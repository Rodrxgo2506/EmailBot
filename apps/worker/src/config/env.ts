import { encryptionKeyEnv, optionalEnv, parseEnv, type OAuthClientConfig } from "@emailbot/shared";
import { productionUrlProblem, PUBLIC_URL, REDIS_URL } from "@emailbot/validation";
import { z } from "zod";

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
  /** Polling fallback for accounts without push notifications. 0 disables it. */
  WORKER_POLL_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),
  /** Attachments larger than this are recorded (metadata) but not stored. */
  WORKER_MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(0).default(25 * 1024 * 1024),

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
  SENTRY_DSN: optionalEnv(z.url())
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

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
  pollIntervalMinutes: number;
  maxAttachmentBytes: number;
  /** null = health endpoint disabled. */
  health: { port: number; host: string } | null;
  sentryDsn: string | null;
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

export function loadWorkerConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const env = parseEnv(envSchema, source);
  return {
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
    pollIntervalMinutes: env.WORKER_POLL_INTERVAL_MINUTES,
    maxAttachmentBytes: env.WORKER_MAX_ATTACHMENT_BYTES,
    health: (env.WORKER_HEALTH_PORT ?? env.PORT) !== undefined
      ? { port: (env.WORKER_HEALTH_PORT ?? env.PORT) as number, host: env.WORKER_HEALTH_HOST }
      : null,
    sentryDsn: env.SENTRY_DSN ?? null
  };
}
