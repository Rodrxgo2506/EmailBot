import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/*
 * Signed, expiring OAuth "state" parameter.
 *
 * The OAuth callback is a browser redirect that does not carry the user's
 * API bearer token, so the state binds the flow to the user and organization
 * that started it. It is HMAC-SHA256 signed and short-lived.
 */

export const oauthStatePayloadSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  provider: z.enum(["GMAIL", "MICROSOFT"]),
  nonce: z.string().min(1),
  exp: z.number().int()
});

export type OAuthStatePayload = z.infer<typeof oauthStatePayloadSchema>;

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function createOAuthState(
  input: Omit<OAuthStatePayload, "exp" | "nonce">,
  secret: string,
  ttlSeconds = 600,
  now = Date.now()
): string {
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomUUID(),
    exp: Math.floor(now / 1000) + ttlSeconds
  };

  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${data}.${sign(data, secret).toString("base64url")}`;
}

export type OAuthStateVerification =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyOAuthState(state: string, secret: string, now = Date.now()): OAuthStateVerification {
  const [data, signature] = state.split(".");
  if (!data || !signature) return { ok: false, reason: "malformed" };

  const expected = sign(data, secret);
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const parsed = oauthStatePayloadSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: "malformed" };

  if (parsed.data.exp < Math.floor(now / 1000)) return { ok: false, reason: "expired" };

  return { ok: true, payload: parsed.data };
}
