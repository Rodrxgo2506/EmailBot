import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

/*
 * Verification of the OIDC token Google Cloud Pub/Sub attaches to push
 * requests (push subscription with authentication: a service account and an
 * audience). Standard JWT verification, no custom cryptography:
 *   - RS256 signature checked with Google's published keys (JWKS,
 *     https://www.googleapis.com/oauth2/v3/certs, cached per Cache-Control);
 *   - iss = accounts.google.com, aud = the configured audience,
 *     email = the configured push service account, email_verified = true,
 *     exp / iat within a small clock skew.
 * Docs: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 4096;
const DEFAULT_CACHE_S = 3600;
/** An unknown key id triggers at most one JWKS refresh per minute (no fetch amplification). */
const MIN_REFRESH_INTERVAL_MS = 60_000;

interface Jwks {
  keys: Map<string, KeyObject>;
  expiresAt: number;
}

export interface GoogleOidcVerifier {
  verify(token: string, expected: { audience: string; email: string }): Promise<boolean>;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function maxAgeSeconds(cacheControl: string | null): number {
  const match = /max-age=(\d+)/i.exec(cacheControl ?? "");
  return match ? Math.min(Number(match[1]), 24 * 3600) : DEFAULT_CACHE_S;
}

export function createGoogleOidcVerifier(options: { fetch: typeof fetch; now?: () => number; certsUrl?: string }): GoogleOidcVerifier {
  const now = options.now ?? Date.now;
  let jwks: Jwks | null = null;
  let lastRefresh = 0;

  async function refresh(): Promise<void> {
    lastRefresh = now();
    const response = await options.fetch(options.certsUrl ?? GOOGLE_CERTS_URL, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Google certs returned HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; kty?: string }> };
    const keys = new Map<string, KeyObject>();
    for (const key of body.keys ?? []) {
      if (!key.kid || key.kty !== "RSA") continue;
      keys.set(key.kid, createPublicKey({ key, format: "jwk" }));
    }
    jwks = { keys, expiresAt: now() + maxAgeSeconds(response.headers.get("cache-control")) * 1000 };
  }

  async function keyFor(kid: string): Promise<KeyObject | null> {
    if (!jwks || jwks.expiresAt <= now()) await refresh();
    else if (!jwks.keys.has(kid) && now() - lastRefresh >= MIN_REFRESH_INTERVAL_MS) await refresh(); // key rotation
    return jwks?.keys.get(kid) ?? null;
  }

  return {
    async verify(token, expected) {
      if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return false;
      const parts = token.split(".");
      if (parts.length !== 3) return false;
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const header = decodeSegment(headerPart);
      const claims = decodeSegment(payloadPart);
      if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return false;

      const key = await keyFor(header.kid);
      if (!key) return false;
      const signed = verifySignature("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, "base64url"));
      if (!signed) return false;

      const nowS = Math.floor(now() / 1000);
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      return (
        typeof claims.iss === "string" &&
        ISSUERS.has(claims.iss) &&
        audience.includes(expected.audience) &&
        typeof claims.email === "string" &&
        claims.email.toLowerCase() === expected.email.toLowerCase() &&
        claims.email_verified === true &&
        typeof claims.exp === "number" &&
        claims.exp + CLOCK_SKEW_S > nowS &&
        (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_S <= nowS)
      );
    }
  };
}
