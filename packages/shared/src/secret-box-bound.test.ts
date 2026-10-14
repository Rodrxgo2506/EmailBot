import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { imapCredentialContext, SecretBox, SecretBoxError } from "./index.js";

/*
 * v2 (AAD-bound) values for IMAP passwords, next to the unchanged v1 format
 * of the OAuth tokens already stored in production.
 */

const key = randomBytes(32);
const box = new SecretBox(key);
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const context = imapCredentialContext(ORG, "Ventas@Example-Mail.com");

/** An OAuth token written by the current code (independent implementation of the v1 format). */
function legacyV1(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

describe("SecretBox v2 (bound to the mailbox)", () => {
  it("round-trips for its own context and never contains the plaintext", () => {
    const encrypted = box.encryptBound("hunter2-app-password", context);
    expect(encrypted.startsWith("v2.")).toBe(true);
    expect(encrypted).not.toContain("hunter2");
    expect(box.decryptBound(encrypted, context)).toBe("hunter2-app-password");
    expect(box.encryptBound("same", context)).not.toBe(box.encryptBound("same", context));
  });

  it("the context is the mailbox key: organization + lower-case address", () => {
    expect(context).toBe(`imap-password:v2:${ORG}:ventas@example-mail.com`);
    expect(imapCredentialContext(ORG, " ventas@example-mail.com ")).toBe(context);
  });

  it("copied to another mailbox or organization it cannot be decrypted", () => {
    const encrypted = box.encryptBound("secret", context);
    expect(() => box.decryptBound(encrypted, imapCredentialContext(ORG, "otra@example-mail.com"))).toThrow(SecretBoxError);
    expect(() => box.decryptBound(encrypted, imapCredentialContext(OTHER_ORG, "ventas@example-mail.com"))).toThrow(SecretBoxError);
  });

  it("another key, altered parts, a truncated tag or extra parts are refused", () => {
    const encrypted = box.encryptBound("secret", context);
    const [version, iv, tag, ciphertext] = encrypted.split(".") as [string, string, string, string];
    expect(() => new SecretBox(randomBytes(32)).decryptBound(encrypted, context)).toThrow(SecretBoxError);
    expect(() => box.decryptBound([version, iv, tag, Buffer.from("other").toString("base64url")].join("."), context)).toThrow(SecretBoxError);
    expect(() => box.decryptBound([version, iv, tag.slice(0, 8), ciphertext].join("."), context)).toThrow(SecretBoxError);
    expect(() => box.decryptBound(`${encrypted}.x`, context)).toThrow(SecretBoxError);
    expect(() => box.decryptBound("v2.only", context)).toThrow(SecretBoxError);
  });

  it("an empty context is refused (never an unbound v2 value)", () => {
    expect(() => box.encryptBound("secret", "")).toThrow(SecretBoxError);
    expect(() => box.decryptBound(box.encryptBound("secret", context), "")).toThrow(SecretBoxError);
  });

  it("formats never cross: decrypt() refuses v2 and decryptBound() refuses v1", () => {
    expect(() => box.decrypt(box.encryptBound("secret", context))).toThrow(SecretBoxError);
    expect(() => box.decryptBound(box.encrypt("secret"), context)).toThrow(SecretBoxError);
  });
});

describe("OAuth tokens (v1) are unchanged", () => {
  it("values written in the v1 format still decrypt, and encrypt() still writes v1", () => {
    expect(box.decrypt(legacyV1("ya29.access-token"))).toBe("ya29.access-token");
    const encrypted = box.encrypt("1//refresh-token");
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(box.decrypt(encrypted)).toBe("1//refresh-token");
  });
});
