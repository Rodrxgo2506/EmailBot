import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildAttachmentPath,
  buildAuthorizationUrl,
  createOAuthState,
  emailProcessingJobId,
  exchangeAuthorizationCode,
  fetchWithTimeout,
  HttpTimeoutError,
  OAuthError,
  redactSensitive,
  refreshAccessToken,
  safeEqual,
  sanitizeUrl,
  SecretBox,
  SecretBoxError,
  encryptionKeyEnv,
  encryptionKeyFingerprint,
  encryptionKeyProblem,
  parseEnv,
  storageObjectName,
  verifyOAuthState
} from "./index.js";

describe("SecretBox", () => {
  const box = new SecretBox(randomBytes(32));

  it("round-trips and never stores plaintext", () => {
    const encrypted = box.encrypt("ya29.refresh-token-value");
    expect(encrypted).not.toContain("refresh-token-value");
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(box.decrypt(encrypted)).toBe("ya29.refresh-token-value");
  });

  it("uses a random IV per encryption", () => {
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });

  it("rejects tampered ciphertext and foreign keys", () => {
    const encrypted = box.encrypt("secret");
    const parts = encrypted.split(".");
    const tampered = [...parts.slice(0, 3), Buffer.from("other").toString("base64url")].join(".");
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => new SecretBox(randomBytes(32)).decrypt(encrypted)).toThrow();
  });

  it("requires a 32-byte key and never serializes it", () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow();
    expect(JSON.stringify({ box })).toBe('{"box":"[SecretBox]"}');
  });
});

describe("OAuth state", () => {
  const secret = "x".repeat(40);
  const input = { userId: "user-1", organizationId: "org-1", provider: "GMAIL" as const };

  it("verifies a fresh state", () => {
    const state = createOAuthState(input, secret);
    const result = verifyOAuthState(state, secret);
    expect(result.ok && result.payload.organizationId).toBe("org-1");
  });

  it("rejects tampering, wrong secrets and expiry", () => {
    const state = createOAuthState(input, secret, 60, Date.now());
    const [data, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...input, organizationId: "org-2", nonce: "n", exp: 9e9 })).toString(
      "base64url"
    );

    expect(verifyOAuthState(`${forged}.${signature}`, secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyOAuthState(`${data}.${signature}`, "y".repeat(40))).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyOAuthState(state, secret, Date.now() + 61_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyOAuthState("garbage", secret)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("logging helpers", () => {
  it("redacts sensitive keys recursively", () => {
    expect(
      redactSensitive({ provider: "GMAIL", refreshToken: "abc", nested: { client_secret: "s", password: "p", ok: 1 } })
    ).toEqual({ provider: "GMAIL", refreshToken: "[REDACTED]", nested: { client_secret: "[REDACTED]", password: "[REDACTED]", ok: 1 } });
  });

  it("removes OAuth codes and webhook tokens from URLs", () => {
    expect(sanitizeUrl("/api/oauth/gmail/callback?code=4/abc&state=xyz&scope=s")).toBe(
      "/api/oauth/gmail/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D&scope=s"
    );
    expect(sanitizeUrl("/health")).toBe("/health");
  });

  it("compares secrets in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("queues and storage", () => {
  it("builds deterministic job ids without ':'", () => {
    const a = emailProcessingJobId("acc", "<msg:1@example.com>");
    expect(a).toBe(emailProcessingJobId("acc", "<msg:1@example.com>"));
    expect(a).not.toContain(":");
    expect(a).not.toBe(emailProcessingJobId("acc", "<msg:2@example.com>"));
  });

  it("partitions attachment paths by organization and strips traversal", () => {
    const path = buildAttachmentPath({ organizationId: "org", emailId: "e", attachmentId: "a", filename: "../../etc/passwd" });
    expect(path).toMatch(/^org\/e\/a\/etc_passwd-[0-9a-f]{12}$/);
    expect(path.split("/")).toHaveLength(4);
    expect(path).not.toContain("..");
  });
});

/** Object key rule of Supabase Storage (storage-api v1.77.5, src/storage/limits.ts). */
const STORAGE_VALID_OBJECT_KEY = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/;
const ORG_ID = "6f1c1e0a-3b5d-4c8e-9a7f-1d2e3f4a5b6c";

describe("attachment storage keys (regression: non-ASCII names were rejected with 'Invalid key')", () => {
  const key = (filename: string) =>
    buildAttachmentPath({ organizationId: ORG_ID, emailId: "email-1", attachmentId: "attachment-1", filename });

  it.each([
    ["Cotización.xlsx", /^Cotizacion-[0-9a-f]{12}\.xlsx$/],
    ["Factura ñ.pdf", /^Factura_n-[0-9a-f]{12}\.pdf$/],
    ["résumé.docx", /^resume-[0-9a-f]{12}\.docx$/],
    ["报告.pdf", /^attachment-[0-9a-f]{12}\.pdf$/],
    ["Straße Œuvre ø.txt", /^Strasse_OEuvre_o-[0-9a-f]{12}\.txt$/],
    ["📎 informe ✅ 2026.pdf", /^informe_2026-[0-9a-f]{12}\.pdf$/],
    ["a&b (1) #2 %3.pdf", /^a_b_1_2_3-[0-9a-f]{12}\.pdf$/],
    ["Factura Octubre.pdf", /^Factura_Octubre-[0-9a-f]{12}\.pdf$/],
    ["..", /^attachment-[0-9a-f]{12}$/],
    [".htaccess", /^htaccess-[0-9a-f]{12}$/],
    ["sin extension ñ", /^sin_extension_n-[0-9a-f]{12}$/]
  ])("%s -> ASCII key accepted by Storage, extension kept", (filename, expected) => {
    const path = key(filename);
    const segments = path.split("/");
    expect(segments).toHaveLength(4);
    expect(segments.slice(0, 3)).toEqual([ORG_ID, "email-1", "attachment-1"]);
    expect(segments[3]).toMatch(expected);
    expect(STORAGE_VALID_OBJECT_KEY.test(path)).toBe(true);
    expect(path).toMatch(/^[A-Za-z0-9._/-]+$/);
  });

  it("keeps names that are already safe unchanged", () => {
    expect(storageObjectName("factura.pdf")).toBe("factura.pdf");
    expect(storageObjectName("archive.tar.gz")).toBe("archive.tar.gz");
    expect(storageObjectName("INV-2026_10.PDF")).toBe("INV-2026_10.PDF");
  });

  it("is deterministic so a retried upload targets the same object", () => {
    expect(key("Cotización.xlsx")).toBe(key("Cotización.xlsx"));
    expect(storageObjectName("报告.pdf")).toBe(storageObjectName("报告.pdf"));
  });

  it("never maps two different originals to the same name", () => {
    const names = [
      "Factura ñ.pdf",
      "Factura n.pdf",
      "Factura_n.pdf",
      "Factura ń.pdf",
      "Cotización.xlsx",
      "Cotizacion.xlsx",
      "报告.pdf",
      "报表.pdf",
      "résumé.docx",
      "resume.docx",
      "Résumé.docx"
    ];
    const keys = names.map(storageObjectName);
    expect(new Set(keys).size).toBe(names.length);
  });

  it("bounds extremely long names and keeps them distinct", () => {
    const long = `${"á".repeat(400)}.pdf`;
    const other = `${"á".repeat(400)}b.pdf`;
    const name = storageObjectName(long);
    expect(name.length).toBeLessThanOrEqual(100 + 1 + 12 + 17);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(STORAGE_VALID_OBJECT_KEY.test(name)).toBe(true);
    expect(storageObjectName(other)).not.toBe(name);
    expect(key(`${"x".repeat(2000)}.pdf`).length).toBeLessThan(1024);
  });

  it("never produces traversal segments or hidden names", () => {
    for (const filename of ["..", ".", "../x", "./.env", "a/../../b", "\\..\\..\\x", "\u0000", "", " "]) {
      const name = storageObjectName(filename);
      expect(name).not.toMatch(/^\.|\/|\\/);
      expect(name.length).toBeGreaterThan(0);
      expect(STORAGE_VALID_OBJECT_KEY.test(name)).toBe(true);
    }
  });
});

describe("OAuth clients", () => {
  const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/cb" };

  it("builds a Gmail authorization URL requesting offline access", () => {
    const url = new URL(buildAuthorizationUrl("GMAIL", config, "state-123"));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  });

  it("Gmail asks for explicit consent AND the account chooser (prompt=consent select_account); nothing else changes", () => {
    const url = new URL(buildAuthorizationUrl("GMAIL", config, "state-123"));
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.toString()).toContain("prompt=consent+select_account");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client",
      redirect_uri: "https://api.example.com/cb",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state: "state-123"
    });
  });

  it("builds a Microsoft authorization URL with the tenant", () => {
    const url = new URL(buildAuthorizationUrl("MICROSOFT", { ...config, tenant: "common" }, "s"));
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("prompt")).toBe("select_account"); // Microsoft unchanged
  });

  it("exchanges a code and computes expiry", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 })
    );
    const tokens = await exchangeAuthorizationCode("GMAIL", config, "code", fetchMock as unknown as typeof fetch);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeInstanceOf(Date);
  });

  it("surfaces invalid_grant as requiring reconnection without leaking tokens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const error = await refreshAccessToken("MICROSOFT", config, "rt-secret", fetchMock as unknown as typeof fetch).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).requiresReconnect).toBe(true);
    expect((error as OAuthError).message).not.toContain("rt-secret");
  });
});

describe("fetchWithTimeout", () => {
  const never = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

  it("returns fast responses with status, headers and body intact", async () => {
    const fetchImpl = fetchWithTimeout(
      vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "x-test": "1" } })) as unknown as typeof fetch,
      200
    );
    const response = await fetchImpl("https://api.example.com/x");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.json()).toEqual({ ok: 1 });
  });

  it("aborts a request whose headers never arrive", async () => {
    const started = Date.now();
    await expect(fetchWithTimeout(never as unknown as typeof fetch, 50)("https://slow.example.com/a")).rejects.toMatchObject({
      name: "HttpTimeoutError",
      host: "slow.example.com",
      timeoutMs: 50
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("aborts a response whose body stalls (the deadline covers the body)", async () => {
    const stalledBody = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        }
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchWithTimeout(stalledBody, 50)("https://slow.example.com/b")).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("keeps a caller abort distinct from a timeout", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(never as unknown as typeof fetch, 5000)("https://x.example.com", { signal: controller.signal });
    controller.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toThrow("cancelled by caller");
  });

  it("passes network errors through unchanged and handles empty bodies", async () => {
    const failing = fetchWithTimeout(vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch, 100);
    await expect(failing("https://x.example.com")).rejects.toThrow("fetch failed");
    const empty = fetchWithTimeout(vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch, 100);
    expect((await empty("https://x.example.com")).status).toBe(204);
  });

  it("OAuth token exchange fails with a timeout error instead of hanging", async () => {
    const config = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/cb" };
    await expect(exchangeAuthorizationCode("GMAIL", config, "code", fetchWithTimeout(never as unknown as typeof fetch, 50))).rejects.toBeInstanceOf(
      HttpTimeoutError
    );
  });
});

describe("TOKEN_ENCRYPTION_KEY validation (shared by API and worker)", () => {
  const valid = randomBytes(32).toString("base64");

  it("accepts the documented format: base64 of 32 random bytes", () => {
    expect(encryptionKeyProblem(valid)).toBeNull();
    expect(SecretBox.fromBase64(valid).decrypt(SecretBox.fromBase64(valid).encrypt("x"))).toBe("x");
  });

  it.each([
    ["missing", undefined, /is required/],
    ["empty", "", /is required/],
    ["surrounding whitespace", ` ${randomBytes(32).toString("base64")}`, /whitespace/],
    ["16 bytes", randomBytes(16).toString("base64"), /44 characters/],
    ["48 bytes", randomBytes(48).toString("base64"), /44 characters/],
    ["hex instead of base64", randomBytes(32).toString("hex"), /44 characters/],
    ["base64url alphabet", randomBytes(32).toString("base64url"), /44 characters/],
    ["invalid characters", `${"!".repeat(43)}=`, /44 characters/],
    ["placeholder of zeros", Buffer.alloc(32).toString("base64"), /not random enough/],
    ["repeated pattern", Buffer.alloc(32, "ab").toString("base64"), /not random enough/]
  ])("rejects %s", (_label, value, reason) => {
    expect(encryptionKeyProblem(value)).toMatch(reason);
  });

  it("never echoes the key in messages", () => {
    const weak = Buffer.alloc(32).toString("base64");
    expect(encryptionKeyProblem(weak)).not.toContain(weak.slice(0, 8));
    expect(() => SecretBox.fromBase64(weak)).toThrow(/TOKEN_ENCRYPTION_KEY is not random enough/);
    try {
      parseEnv(z.object({ TOKEN_ENCRYPTION_KEY: encryptionKeyEnv }), { TOKEN_ENCRYPTION_KEY: `${valid.slice(0, 40)}` });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("TOKEN_ENCRYPTION_KEY");
      expect(String(error)).not.toContain(valid.slice(0, 40));
    }
  });

  it("the same zod schema validates the key for both services", () => {
    expect(parseEnv(z.object({ TOKEN_ENCRYPTION_KEY: encryptionKeyEnv }), { TOKEN_ENCRYPTION_KEY: valid }).TOKEN_ENCRYPTION_KEY).toBe(valid);
    expect(() => parseEnv(z.object({ TOKEN_ENCRYPTION_KEY: encryptionKeyEnv }), {})).toThrow(/TOKEN_ENCRYPTION_KEY: is required/);
  });

  it("fingerprints identify a key without revealing it", () => {
    const other = randomBytes(32).toString("base64");
    expect(encryptionKeyFingerprint(valid)).toMatch(/^[0-9a-f]{16}$/);
    expect(encryptionKeyFingerprint(valid)).toBe(encryptionKeyFingerprint(valid));
    expect(encryptionKeyFingerprint(valid)).not.toBe(encryptionKeyFingerprint(other));
    expect(valid).not.toContain(encryptionKeyFingerprint(valid));
    expect(Buffer.from(valid, "base64").toString("hex")).not.toContain(encryptionKeyFingerprint(valid));
  });

  it("a value encrypted with another key fails with a typed, non-secret error", () => {
    const encrypted = SecretBox.fromBase64(valid).encrypt("refresh-token");
    const other = SecretBox.fromBase64(randomBytes(32).toString("base64"));
    expect(() => other.decrypt(encrypted)).toThrow(SecretBoxError);
    expect(() => other.decrypt(encrypted)).toThrow(/cannot be decrypted with the configured TOKEN_ENCRYPTION_KEY/);
    expect(() => other.decrypt("v2.a.b.c")).toThrow(SecretBoxError);
  });
});
