import { csvEnv, encryptionKeyEnv, optionalEnv, parseEnv } from "@emailbot/shared";
import { normalizeOrigin, productionUrlProblem, PUBLIC_URL, REDIS_URL } from "@emailbot/validation";
import { z } from "zod";

/*
 * API configuration, validated with Zod at startup. The process refuses to
 * start with an invalid configuration. Error messages never echo values.
 */

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: optionalEnv(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])),

    API_HOST: z.string().min(1).default("0.0.0.0"),
    /**
     * HTTP port. PORT is the standard variable hosting platforms inject and
     * wins when present; API_PORT is the explicit setting (local default 3000).
     */
    PORT: optionalEnv(z.coerce.number().int().min(1).max(65_535)),
    API_PORT: optionalEnv(z.coerce.number().int().min(1).max(65_535)),
    /**
     * Reverse proxy trust (Fastify trustProxy): "true", a hop count ("1") or a
     * comma separated list of proxy IPs/CIDRs. Required behind a load balancer
     * so rate limiting sees the real client IP. Unset = do not trust headers.
     */
    TRUST_PROXY: optionalEnv(z.string().min(1)),
    /** Requests per minute per client IP (global default; sensitive routes are stricter). */
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(300),
    /** Public base URL of this API. Development default: http://localhost:3000. Required in production. */
    API_PUBLIC_URL: optionalEnv(z.url()),
    /** Web app URL; OAuth callbacks redirect the browser back here. Development default: http://localhost:5173. */
    WEB_APP_URL: optionalEnv(z.url()),
    /** Comma separated list of allowed browser origins. Required in production. */
    CORS_ORIGINS: csvEnv,

    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    ATTACHMENTS_BUCKET: z.string().min(1).default("email-attachments"),

    /** Development default: redis://localhost:6379. Required in production. */
    REDIS_URL: optionalEnv(z.string().min(1)),

    /** Timeout of every call to Google / Microsoft (OAuth token endpoints, Gmail, Graph). */
    PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    /** Timeout of every call to Supabase (Auth, PostgREST, Storage). */
    SUPABASE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),

    /** base64 encoded 32-byte key used to encrypt provider credentials. */
    TOKEN_ENCRYPTION_KEY: encryptionKeyEnv,
    /** HMAC secret for the OAuth state parameter. */
    OAUTH_STATE_SECRET: z.string().min(32, "must contain at least 32 characters"),

    GOOGLE_CLIENT_ID: optionalEnv(z.string().min(1)),
    GOOGLE_CLIENT_SECRET: optionalEnv(z.string().min(1)),
    GOOGLE_REDIRECT_URI: optionalEnv(z.url()),
    /** Shared secret appended to the Pub/Sub push endpoint (?token=...). Legacy / additional check. */
    GMAIL_PUBSUB_VERIFICATION_TOKEN: optionalEnv(z.string().min(16)),
    /**
     * Pub/Sub push authentication (recommended): the push subscription sends a
     * Google-signed OIDC token for this service account and audience. Both
     * must be set together; the webhook then rejects requests without a valid token.
     */
    GMAIL_PUBSUB_OIDC_AUDIENCE: optionalEnv(z.string().min(1).max(500)),
    GMAIL_PUBSUB_SERVICE_ACCOUNT: optionalEnv(z.email()),

    MICROSOFT_CLIENT_ID: optionalEnv(z.string().min(1)),
    MICROSOFT_CLIENT_SECRET: optionalEnv(z.string().min(1)),
    MICROSOFT_REDIRECT_URI: optionalEnv(z.url()),
    MICROSOFT_TENANT: z.string().min(1).default("common"),
    /** clientState configured on Graph subscriptions; verified on every notification. */
    MICROSOFT_WEBHOOK_CLIENT_STATE: optionalEnv(z.string().min(16)),

    SENTRY_DSN: optionalEnv(z.url())
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

    // Every environment: CORS matches the Origin header by exact string, so
    // each entry must be a pure origin (normalized in loadConfig).
    for (const origin of env.CORS_ORIGINS) {
      const result = normalizeOrigin(origin);
      if (!result.ok) issue("CORS_ORIGINS", `every origin ${result.problem}`);
    }

    // Every environment: a half-configured push authentication would silently be disabled.
    if ((env.GMAIL_PUBSUB_OIDC_AUDIENCE === undefined) !== (env.GMAIL_PUBSUB_SERVICE_ACCOUNT === undefined)) {
      issue("GMAIL_PUBSUB_OIDC_AUDIENCE", "GMAIL_PUBSUB_OIDC_AUDIENCE and GMAIL_PUBSUB_SERVICE_ACCOUNT must be set together");
    }

    if (env.NODE_ENV !== "production") return;

    if (env.CORS_ORIGINS.length === 0) issue("CORS_ORIGINS", "must list the allowed origins in production");
    for (const origin of env.CORS_ORIGINS) {
      const problem = productionUrlProblem(origin, PUBLIC_URL);
      if (problem) issue("CORS_ORIGINS", `every origin ${problem}`);
    }

    for (const [name, value] of [
      ["API_PUBLIC_URL", env.API_PUBLIC_URL],
      ["WEB_APP_URL", env.WEB_APP_URL],
      ["SUPABASE_URL", env.SUPABASE_URL]
    ] as const) {
      const problem = productionUrlProblem(value, PUBLIC_URL);
      if (problem) issue(name, problem);
    }

    const redisProblem = productionUrlProblem(env.REDIS_URL, REDIS_URL);
    if (redisProblem) issue("REDIS_URL", redisProblem);

    if (env.SUPABASE_SERVICE_ROLE_KEY === env.SUPABASE_ANON_KEY) {
      issue("SUPABASE_SERVICE_ROLE_KEY", "must not be the anon key");
    }

    for (const [prefix, id, secret, redirect] of [
      ["GOOGLE", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI],
      ["MICROSOFT", env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET, env.MICROSOFT_REDIRECT_URI]
    ] as const) {
      const provided = [id, secret, redirect].filter((value) => value !== undefined).length;
      if (provided > 0 && provided < 3) {
        issue(`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_ID, ${prefix}_CLIENT_SECRET and ${prefix}_REDIRECT_URI must be set together`);
      }
      if (redirect !== undefined) {
        const problem = productionUrlProblem(redirect, PUBLIC_URL);
        if (problem) issue(`${prefix}_REDIRECT_URI`, problem);
        else if (env.API_PUBLIC_URL && new URL(redirect).origin !== new URL(env.API_PUBLIC_URL).origin) {
          issue(`${prefix}_REDIRECT_URI`, "must use the same origin as API_PUBLIC_URL (the callback is served by this API)");
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant?: string | undefined;
}

export interface ApiConfig {
  env: Env["NODE_ENV"];
  logLevel: NonNullable<Env["LOG_LEVEL"]>;
  host: string;
  port: number;
  apiPublicUrl: string;
  webAppUrl: string;
  /** `true` = reflect any origin (development only). */
  corsOrigins: string[] | true;
  trustProxy: boolean | string[] | ((address: string, hop: number) => boolean);
  rateLimitMax: number;
  supabase: { url: string; anonKey: string; serviceRoleKey: string };
  attachmentsBucket: string;
  redisUrl: string;
  providerHttpTimeoutMs: number;
  supabaseHttpTimeoutMs: number;
  tokenEncryptionKey: string;
  oauthStateSecret: string;
  google: OAuthProviderConfig | null;
  microsoft: OAuthProviderConfig | null;
  gmailPubSubVerificationToken: string | null;
  /** Pub/Sub push OIDC authentication; null = not configured. */
  gmailPubSubOidc: { audience: string; serviceAccount: string } | null;
  microsoftWebhookClientState: string | null;
  sentryDsn: string | null;
}

function oauthConfig(
  clientId: string | undefined,
  clientSecret: string | undefined,
  redirectUri: string | undefined,
  tenant?: string
): OAuthProviderConfig | null {
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, tenant };
}

function parseTrustProxy(value: string | undefined): ApiConfig["trustProxy"] {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) {
    // Trust only the closest N proxies (hop count).
    const hops = Number(value);
    return (_address, hop) => hop < hops;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Origins as browsers send them (validated by the schema), without duplicates. */
function normalizedOrigins(origins: string[]): string[] {
  const normalized = origins.map((origin) => {
    const result = normalizeOrigin(origin);
    if (!result.ok) throw new Error("CORS_ORIGINS was not validated");
    return result.origin;
  });
  return [...new Set(normalized)];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  const env = parseEnv(envSchema, source);

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
    host: env.API_HOST,
    port: env.PORT ?? env.API_PORT ?? 3000,
    // Local defaults only apply outside production (validated above).
    apiPublicUrl: env.API_PUBLIC_URL ?? "http://localhost:3000",
    webAppUrl: (env.WEB_APP_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    // Development without an explicit list reflects the request origin.
    // Production always requires an explicit allow-list (validated above).
    corsOrigins: env.CORS_ORIGINS.length > 0 ? normalizedOrigins(env.CORS_ORIGINS) : env.NODE_ENV === "production" ? [] : true,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimitMax: env.RATE_LIMIT_MAX,
    supabase: {
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
    },
    attachmentsBucket: env.ATTACHMENTS_BUCKET,
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    providerHttpTimeoutMs: env.PROVIDER_HTTP_TIMEOUT_MS,
    supabaseHttpTimeoutMs: env.SUPABASE_HTTP_TIMEOUT_MS,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    oauthStateSecret: env.OAUTH_STATE_SECRET,
    google: oauthConfig(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI),
    microsoft: oauthConfig(
      env.MICROSOFT_CLIENT_ID,
      env.MICROSOFT_CLIENT_SECRET,
      env.MICROSOFT_REDIRECT_URI,
      env.MICROSOFT_TENANT
    ),
    gmailPubSubVerificationToken: env.GMAIL_PUBSUB_VERIFICATION_TOKEN ?? null,
    gmailPubSubOidc:
      env.GMAIL_PUBSUB_OIDC_AUDIENCE && env.GMAIL_PUBSUB_SERVICE_ACCOUNT
        ? { audience: env.GMAIL_PUBSUB_OIDC_AUDIENCE, serviceAccount: env.GMAIL_PUBSUB_SERVICE_ACCOUNT }
        : null,
    microsoftWebhookClientState: env.MICROSOFT_WEBHOOK_CLIENT_STATE ?? null,
    sentryDsn: env.SENTRY_DSN ?? null
  };
}
