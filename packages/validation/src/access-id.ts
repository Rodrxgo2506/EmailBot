import { z } from "zod";
import { idSchema } from "./common.js";

/*
 * Customer Access ID (EmailBot V2 phase 4): "SP-7KQ9X82MP4Z7".
 *
 * The secret is 12 characters of Crockford base32 (60 random bits). The
 * prefix is cosmetic and never part of the secret. THE normalization lives
 * here (API login, admin UI and tests share it):
 *   - Unicode NFKC, uppercase;
 *   - spaces and hyphens removed anywhere ("sp 7kq9-x82m-p4z7" is fine);
 *   - the prefix (1-8 characters starting with a letter) is ignored: it is
 *     the first segment before a space/hyphen when the rest is exactly 12
 *     characters, or the leading characters of an unseparated input; a
 *     truncated Access ID is rejected, never re-split;
 *   - Crockford confusions: O -> 0, I and L -> 1.
 * U is not part of the alphabet and is rejected.
 */

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ACCESS_ID_SECRET_LENGTH = 12;
export const ACCESS_ID_DEFAULT_PREFIX = "SP";
export const ACCESS_ID_MAX_INPUT_LENGTH = 64;

const PREFIX = /^[A-Z][A-Z0-9]{0,7}$/u;
const SECRET = /^[0-9A-HJKMNP-TV-Z]{12}$/u;
const SEPARATORS = /[\s-]+/gu;

/** Returns the canonical 12-character secret, or null if the input cannot be an Access ID. */
export function normalizeAccessId(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > ACCESS_ID_MAX_INPUT_LENGTH) return null;
  const upper = input.normalize("NFKC").toUpperCase().trim();
  const compact = upper.replace(SEPARATORS, "");

  let secret: string | null = null;
  if (compact.length === ACCESS_ID_SECRET_LENGTH) {
    secret = compact;
  } else {
    const separated = /^([A-Z0-9]+)[\s-]+(.+)$/su.exec(upper);
    if (separated) {
      const rest = (separated[2] as string).replace(SEPARATORS, "");
      if (PREFIX.test(separated[1] as string) && rest.length === ACCESS_ID_SECRET_LENGTH) secret = rest;
    } else if (PREFIX.test(compact.slice(0, -ACCESS_ID_SECRET_LENGTH))) {
      secret = compact.slice(-ACCESS_ID_SECRET_LENGTH);
    }
  }
  if (secret === null) return null;

  const canonical = secret.replace(/O/gu, "0").replace(/[IL]/gu, "1");
  return SECRET.test(canonical) ? canonical : null;
}

export function isAccessIdPrefix(value: string): boolean {
  return PREFIX.test(value);
}

/** "SP-7KQ9X82MP4Z7" (shown once, when generated). */
export function formatAccessId(prefix: string, secret: string): string {
  return `${prefix}-${secret}`;
}

/** "SP-••••••••P4Z7" (what is shown afterwards). */
export function maskAccessId(prefix: string, last4: string): string {
  return `${prefix}-${"•".repeat(ACCESS_ID_SECRET_LENGTH - 4)}${last4}`;
}

/** POST /api/portal/session */
export const portalLoginSchema = z
  .object({
    accessId: z.string().min(1).max(ACCESS_ID_MAX_INPUT_LENGTH)
  })
  .strict();

/** POST /api/customers/:id/access (generate or regenerate). */
export const customerAccessIssueSchema = z
  .object({
    /** Optional expiration; null / absent = does not expire. */
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional()
  })
  .strict();

export type CustomerAccessIssueInput = z.infer<typeof customerAccessIssueSchema>;

export const customerSessionParamsSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema
  })
  .strict();
