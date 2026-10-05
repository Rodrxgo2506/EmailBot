import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { ACCESS_ID_SECRET_LENGTH, CROCKFORD_ALPHABET } from "@emailbot/validation";

/*
 * Customer Access ID and portal session secrets (EmailBot V2 phase 4).
 *
 * - Access ID secret: 60 bits from crypto.randomBytes, 12 Crockford base32
 *   characters. Stored ONLY as hex(HMAC-SHA256(key, secret)); the key is
 *   derived with HKDF-SHA256 from TOKEN_ENCRYPTION_KEY (info
 *   "emailbot:customer-access:v1"), so no new secret has to be deployed and
 *   a leaked database cannot be brute-forced offline.
 * - Session token: 256 random bits (base64url, 43 chars), only in the
 *   httpOnly cookie; stored as hex(SHA-256(token)).
 * Normalization of user input: normalizeAccessId (@emailbot/validation).
 */

const HKDF_INFO = "emailbot:customer-access:v1";
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** 12 Crockford base32 characters = exactly 60 random bits. */
export function generateAccessSecret(): string {
  const bits = randomBytes(8).readBigUInt64BE() >> 4n; // 64 - 4 = 60 bits
  let value = bits;
  let secret = "";
  for (let index = 0; index < ACCESS_ID_SECRET_LENGTH; index++) {
    secret = CROCKFORD_ALPHABET[Number(value & 31n)] + secret;
    value >>= 5n;
  }
  return secret;
}

export class AccessIdHasher {
  readonly #key: Buffer;

  constructor(tokenEncryptionKey: string) {
    this.#key = Buffer.from(hkdfSync("sha256", Buffer.from(tokenEncryptionKey, "base64"), Buffer.alloc(0), HKDF_INFO, 32));
  }

  /** hex(HMAC-SHA256) of a NORMALIZED secret. */
  hash(normalizedSecret: string): string {
    return createHmac("sha256", this.#key).update(normalizedSecret, "utf8").digest("hex");
  }

  /** Prevents accidental serialization of the key. */
  toJSON(): string {
    return "[AccessIdHasher]";
  }
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isSessionToken(value: string | undefined): value is string {
  return typeof value === "string" && SESSION_TOKEN.test(value);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
