import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Symmetric encryption for provider credentials stored in
 * email_accounts.access_token_encrypted / refresh_token_encrypted.
 *
 * AES-256-GCM (authenticated). Format: "v1.<iv>.<tag>.<ciphertext>" with
 * base64url parts. The version prefix allows key/algorithm rotation later.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** A stored value could not be decrypted (wrong TOKEN_ENCRYPTION_KEY, corrupted or foreign data). */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key must be exactly ${KEY_BYTES} bytes`);
    }
    this.#key = key;
  }

  /** Builds a SecretBox from TOKEN_ENCRYPTION_KEY (validated with encryptionKeyProblem). */
  static fromBase64(encodedKey: string): SecretBox {
    const problem = encryptionKeyProblem(encodedKey);
    if (problem) throw new Error(`TOKEN_ENCRYPTION_KEY ${problem}`);
    return new SecretBox(Buffer.from(encodedKey, "base64"));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
      "."
    );
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(".");

    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new SecretBoxError("Unsupported encrypted payload format");
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // GCM authentication failed: the value was encrypted with another key (or altered).
      throw new SecretBoxError("Encrypted value cannot be decrypted with the configured TOKEN_ENCRYPTION_KEY");
    }
  }

  /** Prevents accidental serialization of the key. */
  toJSON(): string {
    return "[SecretBox]";
  }
}

/** Constant-time string comparison for shared secrets (webhook tokens, etc). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "emailbot-compare").update(a).digest();
  const right = createHmac("sha256", "emailbot-compare").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Standard base64 of exactly 32 bytes: 43 characters + "=" padding. */
const ENCRYPTION_KEY_FORMAT = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Validates TOKEN_ENCRYPTION_KEY. Shared by the API and the worker so both
 * accept exactly the same keys. Returns the reason it is invalid, or null.
 * Messages never contain the key or any part of it.
 *
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function encryptionKeyProblem(encodedKey: string | undefined): string | null {
  if (encodedKey === undefined || encodedKey.length === 0) return "is required";
  if (encodedKey.trim() !== encodedKey) return "must not contain leading or trailing whitespace";
  if (!ENCRYPTION_KEY_FORMAT.test(encodedKey)) {
    return "must be the standard base64 encoding of 32 random bytes (44 characters ending with '=')";
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== KEY_BYTES) return `must decode to exactly ${KEY_BYTES} bytes`;
  // A random 32-byte key has ~30 distinct byte values; this only rejects placeholders like "AAAA...=".
  if (new Set(key).size < 16) return "is not random enough (generate it with crypto.randomBytes(32))";
  return null;
}

export function isValidEncryptionKey(encodedKey: string): boolean {
  return encryptionKeyProblem(encodedKey) === null;
}

/**
 * Non-secret identifier of TOKEN_ENCRYPTION_KEY (truncated HMAC, not a
 * fragment of the key). The API and the worker log it at startup so an
 * operator can confirm both use the same key without ever seeing it.
 */
export function encryptionKeyFingerprint(encodedKey: string): string {
  return createHmac("sha256", Buffer.from(encodedKey, "base64")).update("emailbot:token-encryption-key:fingerprint:v1").digest("hex").slice(0, 16);
}
