import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  encryptionKeyFingerprint,
  EXPIRE_SUBSCRIPTIONS_INTERVAL_MS,
  EXPIRE_SUBSCRIPTIONS_SCHEDULER_ID,
  fetchWithTimeout,
  LOG_REDACT_PATHS,
  POLL_SCHEDULER_ID,
  QUEUE_NAMES,
  SecretBox,
  sentryRelease,
  serializeError,
  type EmailEventJob,
  type EmailProcessingJob,
  type NotificationJob
} from "@emailbot/shared";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadWorkerConfig } from "./config/env.js";
import { createProviderContext } from "./credentials/token-manager.js";
import { createAppRedis } from "./infrastructure/app-redis.js";
import { closeServer, createHealthServer, listen, type WorkerHealthState } from "./infrastructure/health.js";
import { cancellableFetch, createRequestCancellation } from "./infrastructure/http-cancellation.js";
import { createImapSyncSlots, imapSyncSlotCount } from "./infrastructure/imap-slots.js";
import { createJobProcessors } from "./infrastructure/job-processors.js";
import { createWorkerQueues } from "./infrastructure/queues.js";
import { createJobTracker, createShutdown, shutdownLimits } from "./infrastructure/shutdown.js";
import { createWorkerSupabase } from "./infrastructure/supabase-client.js";
import { captureWorkerException, flushWorkerSentry, initWorkerSentry, jobType, reportJobFailure } from "./infrastructure/sentry.js";
import { createAppRedisSyncLock } from "./infrastructure/sync-lock.js";
import {
  createAccountStore,
  createAppRealtimePublisher,
  createAttachmentStorage,
  createAuditRecorder,
  createEmailStore,
  createRoutingStore,
  createSubscriptionMaintenance
} from "./infrastructure/supabase-stores.js";
import type { HandleEventDeps } from "./pipeline/handle-email-event.js";
import { deliverNotification } from "./pipeline/notify.js";
import type { ProcessEmailDeps } from "./pipeline/process-email.js";
import { createImapSyncAdapter } from "./providers/imap/adapter.js";
import type { ImapClient } from "./providers/imap/connection.js";
import { abortImapOperations } from "./providers/imap/deadline.js";
import { ImapConnectionPool } from "./providers/imap/pool.js";
import { createMicrosoftSubscriptionClient } from "./providers/microsoft/subscriptions.js";
import { createProviderRegistry } from "./providers/registry.js";
import type { WorkerAccount } from "./providers/types.js";

loadDotenv({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")], quiet: true });

const config = loadWorkerConfig();
const logger = pino({
  level: config.logLevel,
  base: { service: "emailbot-worker" },
  redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" }
});

initWorkerSentry({ dsn: config.sentryDsn, environment: config.env, release: sentryRelease(process.env) });

// SERVICE ROLE client: the worker processes every tenant; it scopes all
// writes with ids read from the database. F5.3: PostgREST reads are not retried by the client (supabase-client.ts).
const supabase = createWorkerSupabase(config.supabaseUrl, config.supabaseServiceRoleKey, config.supabaseHttpTimeoutMs);
// Google / Microsoft: OAuth refresh, Gmail, Graph and attachment downloads. Each request is limited by
// PROVIDER_HTTP_TIMEOUT_MS; F5.4: the shutdown's cancel phase also cancels the ones in flight (http-cancellation.ts).
const providerRequests = createRequestCancellation();
const providerFetch = cancellableFetch(fetchWithTimeout(globalThis.fetch, config.providerHttpTimeoutMs), providerRequests.signal);

// BullMQ workers require maxRetriesPerRequest = null (BullMQ workers and queues only).
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
// F5.2: the application's own commands run on bounded clients (infrastructure/app-redis.ts): the sync lock and the
// health PING on one, realtime publishing on its own (the shutdown interrupts it without touching the lock).
const appRedis = createAppRedis(config.redisUrl, config.redisCommandTimeoutMs);
const publisherRedis = createAppRedis(config.redisUrl, config.redisCommandTimeoutMs);
const publisherConnection = publisherRedis.client;
connection.on("error", (error) => logger.error({ err: serializeError(error) }, "redis error"));
appRedis.client.on("error", (error) => logger.error({ err: serializeError(error) }, "redis application client error"));
publisherConnection.on("error", (error) => logger.error({ err: serializeError(error) }, "redis publisher error"));

// Health endpoint (only when a port is configured): /livez answers right away,
// /readyz once initialization finished and Redis answers.
const health: WorkerHealthState = { initialized: false, failed: false, stopping: false };
const healthServer = config.health
  ? createHealthServer({
      state: health,
      // BullMQ's connection is checked without a command (no PING queued on it while Redis is away).
      pingRedis: async () => connection.status === "ready" && appRedis.client.status === "ready" && (await appRedis.client.ping()) === "PONG"
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

const queues = createWorkerQueues(connection, { producerTimeoutMs: config.redisCommandTimeoutMs });
const accounts = createAccountStore(supabase);
const emails = createEmailStore(supabase);
const realtime = createAppRealtimePublisher(publisherRedis);
// IMAP: the pool and the real adapter exist only when IMAP synchronization is enabled (fixed false today).
const imapPool = config.imapSyncEnabled ? new ImapConnectionPool<ImapClient>() : null;
const providers = createProviderRegistry(providerFetch, imapPool ? { imap: createImapSyncAdapter({ pool: imapPool }) } : {});
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
  maxAttachmentBytes: config.maxAttachmentBytes,
  imapSyncEnabled: config.imapSyncEnabled
};

const eventDeps: Omit<HandleEventDeps, "logger"> = {
  accounts,
  emails,
  producer: queues.producer,
  providers,
  createContext,
  enqueueSync: (account, reason) => queues.enqueueSync(account, reason),
  enqueueWatch: (account) => queues.enqueueWatch(account),
  lock: createAppRedisSyncLock(appRedis),
  audit: auditRecorder,
  watchTopic: config.gmailPubSubTopic,
  microsoftPush: config.microsoftPush,
  microsoftSubscriptions: createMicrosoftSubscriptionClient(providerFetch),
  subscriptions: createSubscriptionMaintenance(supabase),
  imapSyncEnabled: config.imapSyncEnabled,
  // IMAP A2: IMAP runs never take every events slot (at least one stays for Gmail / Microsoft).
  ...(config.imapSyncEnabled ? { imapSlots: createImapSyncSlots(imapSyncSlotCount(config.eventsConcurrency, config.imapSyncConcurrency)) } : {})
};

// Processors (job-processors.ts): failure mapping, Sentry, and the IMAP A2 / A2.1 "slots busy" delay.
// IMAP A2.1: IMAP email-processing jobs (recovery of incomplete emails) get their own slots and a budget.
const processors = createJobProcessors({
  eventDeps,
  processDeps,
  accounts,
  realtime,
  logger,
  reportJobFailure,
  jobType,
  ...(config.imapSyncEnabled
    ? { imapProcessingSlots: createImapSyncSlots(imapSyncSlotCount(config.processingConcurrency, config.imapProcessingConcurrency)) }
    : {})
});

// F5.1: every processor is counted while it runs, so the shutdown knows when the jobs in flight are done.
const jobs = createJobTracker();

const eventsWorker = new Worker<EmailEventJob>(QUEUE_NAMES.emailEvents, jobs.wrap(processors.events), { connection, concurrency: config.eventsConcurrency });

const processingWorker = new Worker<EmailProcessingJob>(QUEUE_NAMES.emailProcessing, jobs.wrap(processors.processing), {
  connection,
  concurrency: config.processingConcurrency
});

const notificationsWorker = new Worker<NotificationJob>(
  QUEUE_NAMES.notifications,
  jobs.wrap(async (job: Job<NotificationJob>) => {
    const jobLogger = logger.child({ queue: QUEUE_NAMES.notifications, jobId: job.id, organizationId: job.data.organizationId });
    return deliverNotification(job.data, { emails, realtime, accounts, logger: jobLogger });
  }),
  { connection, concurrency: 5 }
);

const workers = [eventsWorker, processingWorker, notificationsWorker];
// F5.1: bounded, phased shutdown (infrastructure/shutdown.ts): stop fetching jobs and IMAP operations, a grace
// period for the jobs in flight, then the realtime publisher is interrupted, the workers closed (forced only if a job
// is still running: it stays active in Redis and is retried once its lock expires), everything released, and the
// process exits within WORKER_SHUTDOWN_TIMEOUT_MS whatever is still pending.
const shutdown = createShutdown(
  {
    logger,
    workers,
    tracker: jobs,
    markStopping: () => {
      health.stopping = true;
    },
    // IMAP A2: running IMAP operations are closed (transient: retried later, no cursor moves past unprocessed mail).
    abortImap: abortImapOperations,
    // After the grace period: realtime publishing (a job waiting on it fails and is retried, never marked completed)
    // and, F5.4, the provider HTTP requests in flight (cancelled jobs fail as transient and are retried).
    interruptBlockedClients: () => {
      publisherConnection.disconnect();
      providerRequests.abort();
    },
    release: [
      // After the workers stopped: no job holds an IMAP connection any more.
      ...(imapPool ? [{ name: "imap pool", run: () => imapPool.closeAll() }] : []),
      { name: "queues", run: () => queues.close() },
      ...(healthServer ? [{ name: "health server", run: () => closeServer(healthServer) }] : [])
    ],
    disconnect: () => {
      connection.disconnect();
      appRedis.client.disconnect();
      publisherConnection.disconnect();
    },
    flush: flushWorkerSentry,
    exit: (code) => process.exit(code)
  },
  shutdownLimits(config.shutdownTimeoutMs)
);

// Registered before the (possibly slow) initialization below, so a platform
// can always stop the worker cleanly.
process.on("SIGINT", () => shutdown.onSignal("SIGINT"));
process.on("SIGTERM", () => shutdown.onSignal("SIGTERM"));

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
      POLL_SCHEDULER_ID,
      { every: config.pollIntervalMinutes * 60_000 },
      { name: "POLL_ACCOUNTS", data: { type: "POLL_ACCOUNTS" }, opts: { removeOnComplete: true, removeOnFail: 100 } }
    );
  } else {
    await queues.emailEvents.removeJobScheduler(POLL_SCHEDULER_ID);
  }

  // Push subscriptions (Gmail watches: 7 days; Microsoft Graph subscriptions: ~70 h) are renewed
  // before they expire. Polling (above) keeps covering accounts without a valid subscription.
  if (config.gmailPubSubTopic || config.microsoftPush) {
    await queues.emailEvents.upsertJobScheduler(
      "renew-gmail-watches",
      { every: config.watchRenewIntervalMinutes * 60_000 },
      { name: "RENEW_WATCHES", data: { type: "RENEW_WATCHES" }, opts: { removeOnComplete: true, removeOnFail: 100 } }
    );
  } else {
    await queues.emailEvents.removeJobScheduler("renew-gmail-watches");
  }

  // Commercial V1.2: subscriptions whose period ended become EXPIRED (idempotent; access already stops at the end).
  await queues.emailEvents.upsertJobScheduler(
    EXPIRE_SUBSCRIPTIONS_SCHEDULER_ID,
    { every: EXPIRE_SUBSCRIPTIONS_INTERVAL_MS },
    { name: "EXPIRE_SUBSCRIPTIONS", data: { type: "EXPIRE_SUBSCRIPTIONS" }, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );

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
  captureWorkerException(error, { phase: "initialization" });
  await flushWorkerSentry();
  process.exit(1);
}

health.initialized = true;
logger.info(
  {
    queues: Object.values(QUEUE_NAMES),
    pollIntervalMinutes: config.pollIntervalMinutes,
    gmailPush: Boolean(config.gmailPubSubTopic),
    microsoftPush: Boolean(config.microsoftPush),
    providersConfigured: { gmail: Boolean(config.oauth.GMAIL), microsoft: Boolean(config.oauth.MICROSOFT) },
    // One-way identifier (not part of the key): must match the API's to decrypt its tokens.
    tokenEncryptionKeyFingerprint: encryptionKeyFingerprint(config.tokenEncryptionKey)
  },
  "EmailBot worker started"
);
