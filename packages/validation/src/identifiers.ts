import type { CustomerIdentifierType } from "@emailbot/types";

/*
 * THE customer identifier normalizer (EmailBot V2). API (writes), web
 * (preview) and worker (lookups, phase 3) all use this function, so the value
 * stored in customer_identifiers.normalized_value and the value looked up for
 * an email are always computed the same way. The database only checks
 * invariants of the output (migration customer_identifiers).
 *
 * Every type: Unicode NFC (composed and decomposed accents compare equal),
 * then trim.
 *   EMAIL     lowercase. Dots and +alias are KEPT (john.smith@ and
 *             john+netflix@ are different identifiers).
 *   PHONE     digits only, keeping a leading "+"; separators (spaces, dashes,
 *             dots, parentheses, slashes) are removed; 6 to 15 digits (E.164
 *             maximum). Letters are rejected. No country code is guessed.
 *   USERNAME / EXTERNAL_ID / CUSTOM  lowercase.
 */

export const MAX_IDENTIFIER_LENGTH = 320;

export type IdentifierNormalization =
  | { ok: true; value: string; normalized: string }
  | { ok: false; problem: string };

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/u;
const PHONE_ALLOWED = /^\+?[\d\s().\-/]+$/u;

export function normalizeIdentifier(type: CustomerIdentifierType, raw: string): IdentifierNormalization {
  const value = raw.normalize("NFC").trim();
  if (value.length === 0) return { ok: false, problem: "must not be empty" };
  if (value.length > MAX_IDENTIFIER_LENGTH) return { ok: false, problem: `must be at most ${MAX_IDENTIFIER_LENGTH} characters` };

  switch (type) {
    case "EMAIL": {
      const normalized = value.toLowerCase();
      if (!EMAIL_SHAPE.test(normalized)) return { ok: false, problem: "must be an email address" };
      return { ok: true, value, normalized };
    }
    case "PHONE": {
      if (!PHONE_ALLOWED.test(value)) return { ok: false, problem: "may only contain digits, spaces, (, ), ., -, / and a leading +" };
      const digits = value.replace(/\D/gu, "");
      if (digits.length < 6 || digits.length > 15) return { ok: false, problem: "must contain 6 to 15 digits" };
      return { ok: true, value, normalized: `${value.startsWith("+") ? "+" : ""}${digits}` };
    }
    default:
      return { ok: true, value, normalized: value.toLowerCase() };
  }
}
