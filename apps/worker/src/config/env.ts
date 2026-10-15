import { encryptionKeyEnv, EnvValidationError, graphLifecycleUrl, optionalEnv, parseEnv, type OAuthClientConfig } from "@emailbot/shared";
import { productionUrlProblem, PUBLIC_URL, REDIS_URL } from "@emailbot/validation";
import { z } from "zod";
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS, MAX_REDIS_COMMAND_TIMEOUT_MS, MIN_REDIS_COMMAND_TIMEOUT_MS } from "../infrastructure/app-redis.js";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, MIN_SHUTDOWN_TIMEOUT_MS } from "../infrastructure/shutdown.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: optionalEnv(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])),

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ATTACHMENTS_BUCKET: z.string().min(1).default("email-attachments"),

  /** Development default: redis://localhost:6379. Required in production. */
  REDIS_URL: optionalEnv(z.string().min(1)),
  TOKEN_ENCRYPTION_KEY: encryptionKeyEnv,

  GOOGLE_CLIENT_ID: optionalEnv(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optionalEnv(z.string().min(1)),
  GOOGLE_REDIRECT_URI: optionalEnv(z.url()),

  MICROSOFT_CLIENT_ID: optionalEnv(z.string().min(1)),
  MICROSOFT_CLIENT_SECRET: optionalEnv(z.string().min(1)),
  MICROSOFT_REDIRECT_URI: optionalEnv(z.url()),
  MICROSOFT_TENANT: z.string().min(1).default("common"),

  WORKER_EVENTS_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  WORKER_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * IMAP A2: IMAP synchronizations run at once by one process, out of WORKER_EVENTS_CONCURRENCY (one events
   * slot stays for Gmail / Microsoft only when WORKER_EVENTS_CONCURRENCY >= 2; see imapSyncSlotCount). Only
   * used when IMAP synchronization is enabled.
   */
  WORKER_IMAP_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
  /**
   * IMAP A2.1: IMAP jobs of the email-processing queue (recovery of incomplete emails) run at once by one process,
   * out of WORKER_PROCESSING_CONCURRENCY (one slot stays for Gmail / Microsoft only when it is >= 2). Only used
   * when IMAP synchronization is enabled.
   */
  WORKER_IMAP_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
  /** Recovery polling (not the primary ingestion once Gmail push is enabled). 0 disables it. */
  WORKER_POLL_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),
  /**
   * Gmail push (users.watch): Pub/Sub topic "projects/<project>/topics/<topic>".
   * Unset = push disabled, mailboxes are only polled. The topic must grant
   * Pub/Sub Publisher to gmail-api-push@system.gserviceaccount.com.
   */
  GMAIL_PUBSUB_TOPIC: optionalEnv(z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/, "must be projects/<project>/topics/<topic>")),
  /**
   * Microsoft push (Graph change notifications): public HTTPS URL of the
   * API's POST /webhooks/microsoft; lifecycle notifications go to the same URL
   * + "/lifecycle". Unset = Microsoft push disabled, mailboxes are only polled.
   * Graph validates the URL (handshake) when a subscription is created.
   */
  MICROSOFT_GRAPH_NOTIFICATION_URL: optionalEnv(z.url({ protocol: /^https$/, error: "must be an https URL" })),
  /** How often push subscriptions close to expiry are renewed (Gmail watches: 7 days; Graph subscriptions: ~70 h). */
  WORKER_WATCH_RENEW_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Attachments larger than this are recorded (metadata) but not stored. */
  WORKER_MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(0).default(25 * 1024 * 1024),
  /**
   * F5.5: total limit of one attachment download or Storage upload that keeps progressing (a download with no byte
   * for PROVIDER_HTTP_TIMEOUT_MS still fails then). See infrastructure/attachment-transfer.ts.
   */
  WORKER_ATTACHMENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),

  /** Timeout of every call to Google / Microsoft (OAuth token refresh, Gmail, Graph, attachment downloads). */
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /** Timeout of every call to Supabase (PostgREST, Storage uploads). */
  SUPABASE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  /**
   * Health endpoint (GET /livez, GET /readyz) for the hosting platform. Port:
   * WORKER_HEALTH_PORT, else the platform's PORT; disabled when neither is set
   * (local development). No business endpoints are served.
   */
  WORKER_HEALTH_PORT: optionalEnv(z.coerce.number().int().min(1).max(65_535)),
  PORT: optionalEnv(z.coerce.number().int().min(1).max(65_535)),
  WORKER_HEALTH_HOST: z.string().min(1).default("0.0.0.0"),
  /**
   * F5.1: total shutdown budget (SIGTERM / SIGINT to process exit). The worker exits within it whatever is still
   * pending; keep it below the platform's own grace period (Render: maxShutdownDelaySeconds, 120 s in
   * deploy/render/render.yaml; the value applied to the service is not verified).
   */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(MIN_SHUTDOWN_TIMEOUT_MS).max(600_000).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  /** F5.2: limit of each application Redis command (sync lock, health PING, realtime) and queue producer call. */
  WORKER_REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_REDIS_COMMAND_TIMEOUT_MS)
    .max(MAX_REDIS_COMMAND_TIMEOUT_MS)
    .default(DEFAULT_REDIS_COMMAND_TIMEOUT_MS),
  SENTRY_DSN: optionalEnv(z.url())
}).superRefine((env, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

  // F5.5: an attachment transfer may not have a shorter limit than any other provider request.
  if (env.WORKER_ATTACHMENT_TIMEOUT_MS < env.PROVIDER_HTTP_TIMEOUT_MS) {
    issue("WORKER_ATTACHMENT_TIMEOUT_MS", "must be at least PROVIDER_HTTP_TIMEOUT_MS");
  }

  // Every environment: subscriptions are created with the Microsoft account's delegated token.
  if (env.MICROSOFT_GRAPH_NOTIFICATION_URL !== undefined && !(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_REDIRECT_URI)) {
    issue("MICROSOFT_GRAPH_NOTIFICATION_URL", "requires MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_REDIRECT_URI");
  }

  if (env.NODE_ENV !== "production") return;

  const supabaseProblem = productionUrlProblem(env.SUPABASE_URL, PUBLIC_URL);
  if (supabaseProblem) issue("SUPABASE_URL", supabaseProblem);
  const redisProblem = productionUrlProblem(env.REDIS_URL, REDIS_URL);
  if (redisProblem) issue("REDIS_URL", redisProblem);

  for (const [prefix, id, secret, redirect] of [
    ["GOOGLE", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI],
    ["MICROSOFT", env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET, env.MICROSOFT_REDIRECT_URI]
  ] as const) {
    const provided = [id, secret, redirect].filter((value) => value !== undefined).length;
    if (provided > 0 && provided < 3) {
      // A partial set silently disables token refresh and every account of that provider ends in ERROR.
      issue(`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_ID, ${prefix}_CLIENT_SECRET and ${prefix}_REDIRECT_URI must be set together`);
    }
    if (redirect !== undefined) {
      const problem = productionUrlProblem(redirect, PUBLIC_URL);
      if (problem) issue(`${prefix}_REDIRECT_URI`, problem);
    }
  }

  if (env.MICROSOFT_GRAPH_NOTIFICATION_URL !== undefined) {
    const problem = productionUrlProblem(env.MICROSOFT_GRAPH_NOTIFICATION_URL, PUBLIC_URL);
    if (problem) issue("MICROSOFT_GRAPH_NOTIFICATION_URL", problem);
  }
});

export interface WorkerConfig {
  env: "development" | "test" | "production";
  logLevel: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  attachmentsBucket: string;
  redisUrl: string;
  providerHttpTimeoutMs: number;
  supabaseHttpTimeoutMs: number;
  tokenEncryptionKey: string;
  oauth: { GMAIL: OAuthClientConfig | null; MICROSOFT: OAuthClientConfig | null };
  eventsConcurrency: number;
  processingConcurrency: number;
  /** IMAP A2: requested IMAP synchronizations at once (see imapSyncSlotCount). */
  imapSyncConcurrency: number;
  /** IMAP A2.1: requested IMAP email-processing jobs at once (see imapSyncSlotCount). */
  imapProcessingConcurrency: number;
  pollIntervalMinutes: number;
  /** null = Gmail push disabled (polling only). */
  gmailPubSubTopic: string | null;
  /** null = Microsoft push disabled (polling only). */
  microsoftPush: { notificationUrl: string; lifecycleNotificationUrl: string } | null;
  watchRenewIntervalMinutes: number;
  maxAttachmentBytes: number;
  /** F5.5: total limit (ms) of one attachment download / Storage upload, see infrastructure/attachment-transfer.ts. */
  attachmentTimeoutMs: number;
  /** F5.1: total shutdown budget (ms), see infrastructure/shutdown.ts. */
  shutdownTimeoutMs: number;
  /** F5.2: application Redis command / queue producer limit (ms), see infrastructure/app-redis.ts. */
  redisCommandTimeoutMs: number;
  /** null = health endpoint disabled. */
  health: { port: number; host: string } | null;
  sentryDsn: string | null;
  /**
   * IMAP synchronization. FIXED to false in code (no environment variable can
   * turn it on): IMAP accounts are never polled, synchronized or processed and
   * the IMAP adapter is not even created until IMAP is launched by a code change.
   */
  imapSyncEnabled: boolean;
}

function oauth(
  clientId: string | undefined,
  clientSecret: string | undefined,
  redirectUri: string | undefined,
  tenant?: string
): OAuthClientConfig | null {
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, tenant };
}

/** IMAP A2.1: queue concurrency needed so the IMAP slots always leave one slot to Gmail / Microsoft. */
export const IMAP_MIN_QUEUE_CONCURRENCY = 2;

/**
 * IMAP A2 / A2.1: with IMAP synchronization enabled, each shared queue needs a concurrency of 2 or more: with 1,
 * its only slot would be IMAP's (imapSyncSlotCount) and nothing would be reserved for Gmail / Microsoft. Throws
 * EnvValidationError naming every offending variable. IMAP disabled: no requirement (concurrency 1 stays valid).
 */
export function assertImapWorkerConcurrency(config: Pick<WorkerConfig, "imapSyncEnabled" | "eventsConcurrency" | "processingConcurrency">): void {
  if (!config.imapSyncEnabled) return;
  const issues: string[] = [];
  for (const [name, value] of [
    ["WORKER_EVENTS_CONCURRENCY", config.eventsConcurrency],
    ["WORKER_PROCESSING_CONCURRENCY", config.processingConcurrency]
  ] as const) {
    if (value < IMAP_MIN_QUEUE_CONCURRENCY) {
      issues.push(`${name}: must be at least ${IMAP_MIN_QUEUE_CONCURRENCY} while IMAP synchronization is enabled (got ${value}), so IMAP never takes every slot of the queue`);
    }
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
}

export function loadWorkerConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const env = parseEnv(envSchema, source);
  const config: WorkerConfig = {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    attachmentsBucket: env.ATTACHMENTS_BUCKET,
    // Local default only applies outside production (validated above).
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    providerHttpTimeoutMs: env.PROVIDER_HTTP_TIMEOUT_MS,
    supabaseHttpTimeoutMs: env.SUPABASE_HTTP_TIMEOUT_MS,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    oauth: {
      GMAIL: oauth(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI),
      MICROSOFT: oauth(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET, env.MICROSOFT_REDIRECT_URI, env.MICROSOFT_TENANT)
    },
    eventsConcurrency: env.WORKER_EVENTS_CONCURRENCY,
    processingConcurrency: env.WORKER_PROCESSING_CONCURRENCY,
    imapSyncConcurrency: env.WORKER_IMAP_SYNC_CONCURRENCY,
    imapProcessingConcurrency: env.WORKER_IMAP_PROCESSING_CONCURRENCY,
    pollIntervalMinutes: env.WORKER_POLL_INTERVAL_MINUTES,
    gmailPubSubTopic: env.GMAIL_PUBSUB_TOPIC ?? null,
    microsoftPush: env.MICROSOFT_GRAPH_NOTIFICATION_URL
      ? { notificationUrl: env.MICROSOFT_GRAPH_NOTIFICATION_URL, lifecycleNotificationUrl: graphLifecycleUrl(env.MICROSOFT_GRAPH_NOTIFICATION_URL) }
      : null,
    watchRenewIntervalMinutes: env.WORKER_WATCH_RENEW_INTERVAL_MINUTES,
    maxAttachmentBytes: env.WORKER_MAX_ATTACHMENT_BYTES,
    attachmentTimeoutMs: env.WORKER_ATTACHMENT_TIMEOUT_MS,
    health: (env.WORKER_HEALTH_PORT ?? env.PORT) !== undefined
      ? { port: (env.WORKER_HEALTH_PORT ?? env.PORT) as number, host: env.WORKER_HEALTH_HOST }
      : null,
    sentryDsn: env.SENTRY_DSN ?? null,
    shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
    redisCommandTimeoutMs: env.WORKER_REDIS_COMMAND_TIMEOUT_MS,
    // Not read from the environment on purpose (see WorkerConfig.imapSyncEnabled).
    imapSyncEnabled: false
  };
  assertImapWorkerConcurrency(config);
  return config;
}
