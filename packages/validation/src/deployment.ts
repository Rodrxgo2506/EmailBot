/*
 * Production configuration checks shared by the API, the worker and the web
 * build. In development localhost defaults are fine; in production a missing
 * or local value for critical infrastructure must stop the process instead of
 * silently talking to the developer's machine.
 */

// Available in browsers and Node >= 16; this package compiles without DOM/Node typings.
declare const atob: (data: string) => string;

const LOCAL_HOSTNAMES =new Set(["localhost", "0.0.0.0", "::", "::1", "[::1]", "[::]", "host.docker.internal"]);

/** Loopback, unspecified or *.localhost host names. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (LOCAL_HOSTNAMES.has(host) || host.endsWith(".localhost")) return true;
  // 127.0.0.0/8 and 0.0.0.0/8
  return /^(127|0)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface ProductionUrlOptions {
  /** Accepted URL schemes, e.g. ["https:"] or ["redis:", "rediss:"]. */
  protocols: readonly string[];
}

/**
 * Returns why `value` is not acceptable as a production URL, or null.
 * Never echoes the value (it may embed credentials, e.g. a Redis password).
 */
export function productionUrlProblem(value: string | undefined, options: ProductionUrlOptions): string | null {
  if (value === undefined || value.trim() === "") return "is required in production";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be a valid URL";
  }
  if (!options.protocols.includes(url.protocol)) {
    return `must use ${options.protocols.map((protocol) => protocol.replace(/:$/, "")).join(" or ")} in production`;
  }
  if (isLocalHostname(url.hostname)) return "must not point to localhost / a loopback address in production";
  return null;
}

export type OriginResult = { ok: true; origin: string } | { ok: false; problem: string };

/**
 * Normalizes a browser origin as browsers serialize the Origin header
 * (scheme://host[:port], lowercase host, no default port, no trailing slash).
 * CORS compares origins by exact string, so a configured "https://app.example.com/"
 * would otherwise never match. Values with a path, query, fragment or
 * credentials are rejected. Problems never echo the value.
 */
export function normalizeOrigin(value: string): OriginResult {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, problem: "must be a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, problem: "must use http or https" };
  if (url.username || url.password) return { ok: false, problem: "must not contain credentials" };
  if (url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, problem: "must be an origin like https://app.example.com (no path, query or fragment)" };
  }
  return { ok: true, origin: url.origin };
}

/** Public browser-facing or third-party URLs: HTTPS only. */
export const PUBLIC_URL = { protocols: ["https:"] } as const;

/**
 * Redis may run inside a private network without TLS (redis://), so both
 * schemes are accepted; only local/loopback hosts are rejected. Managed
 * Redis over the internet should use rediss:// (documented).
 */
export const REDIS_URL = { protocols: ["redis:", "rediss:"] } as const;

/**
 * Detects a Supabase SECRET key (service role JWT or sb_secret_ key). Used to
 * refuse it where only the public anon/publishable key belongs (browser).
 */
export function looksLikeSupabaseSecretKey(key: string): boolean {
  const value = key.trim();
  if (value.startsWith("sb_secret_")) return true;
  const payload = value.split(".")[1];
  if (!payload) return false;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return json.role === "service_role";
  } catch {
    return false;
  }
}
