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

/** Canonical form of an already-trimmed value (the one place the per-type rules live). */
function canonical(type: CustomerIdentifierType, value: string): string {
  if (type === "PHONE") return `${value.startsWith("+") ? "+" : ""}${value.replace(/\D/gu, "")}`;
  return value.toLowerCase();
}

export function normalizeIdentifier(type: CustomerIdentifierType, raw: string): IdentifierNormalization {
  const value = raw.normalize("NFC").trim();
  if (value.length === 0) return { ok: false, problem: "must not be empty" };
  if (value.length > MAX_IDENTIFIER_LENGTH) return { ok: false, problem: `must be at most ${MAX_IDENTIFIER_LENGTH} characters` };

  switch (type) {
    case "EMAIL": {
      const normalized = canonical(type, value);
      if (!EMAIL_SHAPE.test(normalized)) return { ok: false, problem: "must be an email address" };
      return { ok: true, value, normalized };
    }
    case "PHONE": {
      if (!PHONE_ALLOWED.test(value)) return { ok: false, problem: "may only contain digits, spaces, (, ), ., -, / and a leading +" };
      const normalized = canonical(type, value);
      const digits = normalized.replace("+", "").length;
      if (digits < 6 || digits > 15) return { ok: false, problem: "must contain 6 to 15 digits" };
      return { ok: true, value, normalized };
    }
    default:
      return { ok: true, value, normalized: canonical(type, value) };
  }
}

/**
 * Canonical form of a PARTIAL value typed in a search box ("+51 987"), with
 * the same per-type rules as normalizeIdentifier but without its completeness
 * checks (an email fragment has no "@", a phone fragment may have < 6 digits).
 * Returns null when the fragment cannot be part of a value of that type.
 */
export function normalizeIdentifierFragment(type: CustomerIdentifierType, raw: string): string | null {
  const value = raw.normalize("NFC").trim();
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return null;
  if (type === "PHONE" && (!PHONE_ALLOWED.test(value) || !/\d/u.test(value))) return null;
  return canonical(type, value);
}
