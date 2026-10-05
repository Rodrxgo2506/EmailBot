import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import * as Sentry from "@sentry/node";
import {
  encryptionKeyFingerprint,
  fetchWithTimeout,
  LOG_REDACT_PATHS,
  QUEUE_NAMES,
  SecretBox,
  serializeError,
  type EmailEventJob,
  type EmailProcessingJob,
  type NotificationJob
} from "@emailbot/shared";
import { createClient } from "@supabase/supabase-js";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadWorkerConfig } from "./config/env.js";
import { createProviderContext } from "./credentials/token-manager.js";
import { closeServer, createHealthServer, listen, type WorkerHealthState } from "./infrastructure/health.js";
import { createWorkerQueues } from "./infrastructure/queues.js";
import { createRedisSyncLock } from "./infrastructure/sync-lock.js";
import {
  createAccountStore,
  createAttachmentStorage,
  createAuditRecorder,
  createEmailStore,
  createRealtimePublisher,
  createRoutingStore
} from "./infrastructure/supabase-stores.js";
import { handleAccountFailure, NonRetryableError } from "./pipeline/failures.js";
import { handleEmailEvent, SyncBusyError, type HandleEventDeps } from "./pipeline/handle-email-event.js";
import { deliverNotification } from "./pipeline/notify.js";
import { processEmail, type ProcessEmailDeps } from "./pipeline/process-email.js";
import { createProviderRegistry } from "./providers/registry.js";
import type { WorkerAccount } from "./providers/types.js";

loadDotenv({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")], quiet: true });

const config = loadWorkerConfig();
const logger = pino({
  level: config.logLevel,
  base: { service: "emailbot-worker" },
  redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" }
});

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.env,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false
    }
  });
}

// SERVICE ROLE client: the worker processes every tenant; it scopes all
// writes with ids read from the database.
const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: fetchWithTimeout(globalThis.fetch, config.supabaseHttpTimeoutMs) }
});
// Google / Microsoft: OAuth refresh, Gmail, Graph and attachment downloads.
const providerFetch = fetchWithTimeout(globalThis.fetch, config.providerHttpTimeoutMs);

// BullMQ workers require maxRetriesPerRequest = null.
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const publisherConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
connection.on("error", (error) => logger.error({ err: serializeError(error) }, "redis error"));
publisherConnection.on("error", (error) => logger.error({ err: serializeError(error) }, "redis publisher error"));

// Health endpoint (only when a port is configured): /livez answers right away,
// /readyz once initialization finished and Redis answers.
const health: WorkerHealthState = { initialized: false, failed: false, stopping: false };
const healthServer = config.health
  ? createHealthServer({
      state: health,
      pingRedis: async () => connection.status === "ready" && (await connection.ping()) === "PONG"
    })
  : null;
if (healthServer && config.health) {
  try {
    await listen(healthServer, config.health.port, config.health.host);
    logger.info({ port: config.health.port }, "health endpoint listening (/livez, /readyz)");
  } catch (error) {
    logger.fatal({ err: serializeError(error), port: config.health.port }, "cannot start the health endpoint");
    process.exit(1);
  }
}

const queues = createWorkerQueues(connection);
const accounts = createAccountStore(supabase);
const emails = createEmailStore(supabase);
const realtime = createRealtimePublisher(publisherConnection);
const providers = createProviderRegistry(providerFetch);
const secretBox = SecretBox.fromBase64(config.tokenEncryptionKey);

const createContext = (account: WorkerAccount) =>
  createProviderContext(account, { secretBox, accounts, oauth: config.oauth, fetch: providerFetch });

const auditRecorder = createAuditRecorder(supabase);

const processDeps: Omit<ProcessEmailDeps, "logger"> = {
  accounts,
  emails,
  routing: createRoutingStore(supabase),
  audit: auditRecorder,
  storage: createAttachmentStorage(supabase),
  realtime,
  producer: queues.producer,
  providers,
  createContext,
  attachmentsBucket: config.attachmentsBucket,
  maxAttachmentBytes: config.maxAttachmentBytes
};

const eventDeps: Omit<HandleEventDeps, "logger"> = {
  accounts,
  emails,
  producer: queues.producer,
  providers,
  createContext,
  enqueueSync: (account, reason) => queues.enqueueSync(account, reason),
  enqueueWatch: (account) => queues.enqueueWatch(account),
  lock: createRedisSyncLock(connection),
  audit: auditRecorder,
  watchTopic: config.gmailPubSubTopic
};

/** Maps domain failures to BullMQ semantics (UnrecoverableError = no retry). */
async function runWithFailureHandling<T>(
  account: { id: string; organizationId: string } | null,
  jobLogger: typeof logger,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Another run holds the account: expected, retried with backoff (no error report).
    if (error instanceof SyncBusyError) throw error;
    try {
      return await handleAccountFailure(error, account, { accounts, realtime, logger: jobLogger });
    } catch (handled) {
      if (handled instanceof NonRetryableError) throw new UnrecoverableError(handled.message);
      Sentry.captureException(handled);
      throw handled;
    }
  }
}

const eventsWorker = new Worker<EmailEventJob>(
  QUEUE_NAMES.emailEvents,
  async (job: Job<EmailEventJob>) => {
    const jobLogger = logger.child({ queue: QUEUE_NAMES.emailEvents, jobId: job.id, type: job.data.type });
    const account =
      job.data.type === "SYNC_ACCOUNT" || job.data.type === "WATCH_ACCOUNT"
        ? { id: job.data.emailAccountId, organizationId: job.data.organizationId }
        : null;
    return runWithFailureHandling(account, jobLogger, () =>
      handleEmailEvent(job.data, {
        ...eventDeps,
        // Every ingestion path (push, recovery polling, manual sync) uses the same pipeline.
        processMessage: (message) => processEmail(message, { ...processDeps, logger: jobLogger }, { attempt: 1 }),
        logger: jobLogger
      })
    );
  },
  { connection, concurrency: config.eventsConcurrency }
);

const processingWorker = new Worker<EmailProcessingJob>(
  QUEUE_NAMES.emailProcessing,
  async (job: Job<EmailProcessingJob>) => {
    const jobLogger = logger.child({
      queue: QUEUE_NAMES.emailProcessing,
      jobId: job.id,
      organizationId: job.data.organizationId,
      emailAccountId: job.data.emailAccountId
    });
    const outcome = await runWithFailureHandling(
      { id: job.data.emailAccountId, organizationId: job.data.organizationId },
      jobLogger,
      // Whether an email is resumed is decided by its processing_status in the
      // database (migration 9), not by BullMQ's attempt counters; `attempt`
      // only seeds processing_attempts of a newly stored email.
      () => processEmail(job.data, { ...processDeps, logger: jobLogger }, { attempt: job.attemptsMade + 1 })
    );
    jobLogger.debug({ outcome: outcome.status, ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}) }, "job done");
    return outcome;
  },
  { connection, concurrency: config.processingConcurrency }
);

const notificationsWorker = new Worker<NotificationJob>(
  QUEUE_NAMES.notifications,
  async (job: Job<NotificationJob>) => {
    const jobLogger = logger.child({ queue: QUEUE_NAMES.notifications, jobId: job.id, organizationId: job.data.organizationId });
    return deliverNotification(job.data, { emails, realtime, logger: jobLogger });
  },
  { connection, concurrency: 5 }
);

const workers = [eventsWorker, processingWorker, notificationsWorker];
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  health.stopping = true;
  logger.info({ signal }, "shutting down worker");
  try {
    await Promise.all(workers.map((worker) => worker.close()));
    await queues.close();
    connection.disconnect();
    publisherConnection.disconnect();
    if (healthServer) await closeServer(healthServer);
    await Sentry.flush(2000);
    process.exit(0);
  } catch (error) {
    logger.error({ err: serializeError(error) }, "error during shutdown");
    process.exit(1);
  }
}

// Registered before the (possibly slow) initialization below, so a platform
// can always stop the worker cleanly.
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

for (const worker of workers) {
  worker.on("failed", (job, error) => {
    logger.warn({ queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err: serializeError(error) }, "job failed");
  });
  worker.on("error", (error) => logger.error({ queue: worker.name, err: serializeError(error) }, "worker error"));
}

try {
  // Polling fallback for accounts without push subscriptions.
  if (config.pollIntervalMinutes > 0) {
    await queues.emailEvents.upsertJobScheduler(
      "poll-active-accounts",
      { every: config.pollIntervalMinutes * 60_000 },
      { name: "POLL_ACCOUNTS", data: { type: "POLL_ACCOUNTS" }, opts: { removeOnComplete: true, removeOnFail: 100 } }
    );
  } else {
    await queues.emailEvents.removeJobScheduler("poll-active-accounts");
  }

  // Gmail push: renew watches before they expire (7 days). Polling covers accounts without a valid watch.
  if (config.gmailPubSubTopic) {
    await queues.emailEvents.upsertJobScheduler(
      "renew-gmail-watches",
      { every: config.watchRenewIntervalMinutes * 60_000 },
      { name: "RENEW_WATCHES", data: { type: "RENEW_WATCHES" }, opts: { removeOnComplete: true, removeOnFail: 100 } }
    );
  } else {
    await queues.emailEvents.removeJobScheduler("renew-gmail-watches");
  }

  // Resumes emails left RECEIVED / PROCESSING by jobs that exhausted their retries (migration 9).
  await queues.emailEvents.upsertJobScheduler(
    "recover-incomplete-emails",
    { every: 10 * 60_000 },
    { name: "RECOVER_INCOMPLETE", data: { type: "RECOVER_INCOMPLETE" }, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
} catch (error) {
  // Serious initialization problem (e.g. Redis rejects commands): report not ready and exit so the platform restarts it.
  health.failed = true;
  logger.fatal({ err: serializeError(error) }, "worker initialization failed");
  await Sentry.flush(2000);
  process.exit(1);
}

health.initialized = true;
logger.info(
  {
    queues: Object.values(QUEUE_NAMES),
    pollIntervalMinutes: config.pollIntervalMinutes,
    gmailPush: Boolean(config.gmailPubSubTopic),
    providersConfigured: { gmail: Boolean(config.oauth.GMAIL), microsoft: Boolean(config.oauth.MICROSOFT) },
    // One-way identifier (not part of the key): must match the API's to decrypt its tokens.
    tokenEncryptionKeyFingerprint: encryptionKeyFingerprint(config.tokenEncryptionKey)
  },
  "EmailBot worker started"
);
