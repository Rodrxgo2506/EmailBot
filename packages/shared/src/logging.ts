/*
 * Structured-logging helpers. Credentials must never reach logs:
 * passwords, OAuth access/refresh tokens, client secrets, service role keys,
 * cookies and Authorization headers are redacted.
 */

/** pino `redact.paths` used by the API and the worker. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  "*.password",
  "*.access_token",
  "*.refresh_token",
  "*.accessToken",
  "*.refreshToken",
  "*.id_token",
  "*.client_secret",
  "*.clientSecret",
  "*.token",
  "*.access_token_encrypted",
  "*.refresh_token_encrypted",
  "*.serviceRoleKey",
  "*.SUPABASE_SERVICE_ROLE_KEY",
  "*.TOKEN_ENCRYPTION_KEY",
  // EmailBot V2 phase 4: customer Access IDs.
  "*.accessId",
  "req.body.accessId"
];

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|service[-_]?role|credential/i;

/**
 * Deep-copies a value replacing sensitive keys with "[REDACTED]".
 * Used for audit metadata and job payloads before they are logged/stored.
 */
export function redactSensitive<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1)) as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(inner, depth + 1);
  }
  return output as T;
}

const SENSITIVE_QUERY_PARAMS = new Set(["code", "state", "token", "access_token", "id_token", "validationtoken"]);

/**
 * Removes secrets from a request URL before logging it (OAuth callback
 * `code`/`state`, webhook verification tokens).
 */
export function sanitizeUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;

  const params = new URLSearchParams(url.slice(queryStart + 1));
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) params.set(key, "[REDACTED]");
  }
  return `${url.slice(0, queryStart)}?${params.toString()}`;
}

/** Converts an unknown error into a log-safe object (no request configs/headers). */
export function serializeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message.slice(0, 1000),
      ...(typeof code === "string" ? { code } : {})
    };
  }
  return { name: "UnknownError", message: String(error).slice(0, 1000) };
}
