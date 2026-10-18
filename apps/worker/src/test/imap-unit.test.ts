import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { htmlToText } from "@emailbot/rules-engine";
import { imapCredentialContext, ImapDestinationError, SecretBox, SecretBoxError, storageObjectName, type ImapConnectionOptions, type ImapResolver } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderContext } from "../credentials/token-manager.js";
import { createImapConnector, imapPoolKey, readImapEndpoint, type ImapClient } from "../providers/imap/connection.js";
import { formatImapCursor, formatImapMessageId, parseImapCursor, parseImapMessageId } from "../providers/imap/cursor.js";
import { classifyImapError } from "../providers/imap/errors.js";
import { extractImapAttachment, IMAP_SNIPPET_HTML_INPUT, normalizeImapMessage, snippetHtmlPrefix, snippetOf } from "../providers/imap/normalize.js";
import { ImapConnectionPool, type PoolableClient } from "../providers/imap/pool.js";
import { DEFAULT_IMAP_E2_SCRIPT, integrationScriptCommand, toWslPath } from "./imap-integration-paths.js";
import { ProviderHttpError } from "../providers/http.js";
import { ProviderAuthError, ProviderSecurityError, ProviderTransientError } from "../providers/types.js";
import { makeAccount, makeAccountStore } from "./fakes.js";

/*
 * IMAP E2, unit level (mocks / pure functions, no network). The real server
 * behaviour is covered by imap-integration.test.ts (Dovecot, opt-in).
 */

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
const bytes = (text: string) => Buffer.from(crlf(text));

describe("cursor and message ids", () => {
  it("round-trip and strict parsing", () => {
    expect(formatImapCursor({ uidValidity: 7, uid: 0 })).toBe("imap:v1:7:0");
    expect(parseImapCursor("imap:v1:7:120")).toEqual({ uidValidity: 7, uid: 120 });
    expect(parseImapCursor("imap:v1:4294967295:4294967295")).toEqual({ uidValidity: 4294967295, uid: 4294967295 });
    expect(formatImapMessageId({ uidValidity: 7, uid: 121 })).toBe("7:121");
    expect(parseImapMessageId("7:121")).toEqual({ uidValidity: 7, uid: 121 });
  });

  it.each([null, undefined, "", "100", "imap:v1:0:5", "imap:v1:7:-1", "imap:v2:7:5", "imap:v1:7:05", "imap:v1:4294967296:1", "imap:v1:7:5:extra", " imap:v1:7:5"])(
    "unreadable cursor %j -> null (restart from the newest message)",
    (cursor) => {
      expect(parseImapCursor(cursor as string | null)).toBeNull();
    }
  );

  it.each(["7:0", "0:7", "7", "7:x", "7:4294967296", "a:b", "7:1:2"])("invalid message id %j", (id) => {
    expect(parseImapMessageId(id)).toBeNull();
  });

  it("refuses to format out-of-range values", () => {
    expect(() => formatImapCursor({ uidValidity: 0, uid: 1 })).toThrow();
    expect(() => formatImapMessageId({ uidValidity: 7, uid: 0 })).toThrow();
  });
});

describe("MIME normalization (postal-mime)", () => {
  const meta = { providerMessageId: "7:10", internalDate: new Date("2026-10-14T10:00:00Z"), envelope: { subject: "Envelope subject", from: [{ name: "Env", address: "env@sender.example" }] } };

  it("plain text: addresses, Message-ID, dates, snippet, headers", async () => {
    const email = await normalizeImapMessage(
      bytes(`From: "Netflix" <Info@Account.Netflix.example>
To: Juan <juan@cliente.example>, ventas@empresa.example
Cc: Team: a@team.example, b@team.example;
Subject: Tu código
Message-ID: <abc123@netflix.example>
Date: Tue, 14 Oct 2026 09:59:00 +0000
Content-Type: text/plain; charset=utf-8

Tu código es 482913
`),
      meta,
      "account-1"
    );
    expect(email).toMatchObject({
      provider: "IMAP",
      providerMessageId: "7:10",
      accountId: "account-1",
      direction: "INBOUND",
      sender: { address: "info@account.netflix.example", name: "Netflix" },
      subject: "Tu código",
      internetMessageId: "<abc123@netflix.example>",
      receivedAt: "2026-10-14T10:00:00.000Z",
      sentAt: "2026-10-14T09:59:00.000Z",
      htmlBody: null,
      snippet: "Tu código es 482913",
      attachments: []
    });
    expect(email.textBody).toContain("Tu código es 482913");
    expect(email.recipients.map((r) => r.address)).toEqual(["juan@cliente.example", "ventas@empresa.example"]);
    expect(email.cc.map((r) => r.address)).toEqual(["a@team.example", "b@team.example"]);
    expect(email.headers["message-id"]).toBe("<abc123@netflix.example>");
  });

  it("multipart/alternative (text + HTML) and attachments (regular and inline), positional ids", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake").toString("base64");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const source = bytes(`From: shop@store.example
To: me@empresa.example
Subject: Factura
Message-ID: <f1@store.example>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mix"

--mix
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8

Total: 10 soles
--alt
Content-Type: text/html; charset=utf-8

<p>Total: <b>10 soles</b><img src="cid:logo@store"></p>
--alt--
--rel
Content-Type: image/png
Content-ID: <logo@store>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

${png}
--rel--
--mix
Content-Type: application/pdf; name="../../etc/passwd.pdf"
Content-Disposition: attachment; filename="../../etc/passwd.pdf"
Content-Transfer-Encoding: base64

${pdf}
--mix--
`);
    const email = await normalizeImapMessage(source, meta, "account-1");
    expect(email.textBody).toContain("Total: 10 soles");
    expect(email.htmlBody).toContain("<b>10 soles</b>");
    expect(email.attachments).toEqual([
      { providerAttachmentId: "part-0", filename: "logo.png", contentType: "image/png", size: 4, contentId: "logo@store", isInline: true },
      { providerAttachmentId: "part-1", filename: "../../etc/passwd.pdf", contentType: "application/pdf", size: 13, contentId: null, isInline: false }
    ]);
    // The sender's file name is only text: the storage key is built from ids and a sanitized name.
    expect(storageObjectName("../../etc/passwd.pdf")).not.toContain("/");
    expect(Buffer.from((await extractImapAttachment(source, "part-1")) ?? []).toString()).toBe("%PDF-1.4 fake");
    expect(await extractImapAttachment(source, "part-2")).toBeNull();
    expect(await extractImapAttachment(source, "../part-1")).toBeNull();
  });

  it("a message the parser refuses (too many parts) still yields a minimal email from the envelope, never an exception", async () => {
    const parts = Array.from({ length: 600 }, (_, index) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${index}\r\n`).join("");
    const source = Buffer.from(`From: x@y.example\r\nSubject: bomb\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}--b--\r\n`);
    const email = await normalizeImapMessage(source, meta, "account-1");
    expect(email).toMatchObject({ subject: "Envelope subject", sender: { address: "env@sender.example" }, textBody: null, htmlBody: null, attachments: [] });
  });

  it("garbage bytes do not throw either", async () => {
    const email = await normalizeImapMessage(randomBytes(4096), meta, "account-1");
    expect(email.provider).toBe("IMAP");
    expect(email.providerMessageId).toBe("7:10");
  });

  it("bodies are bounded (same limit as Gmail)", async () => {
    const email = await normalizeImapMessage(bytes(`From: a@b.example\nSubject: big\n\n${"x".repeat(1_200_000)}\n`), meta, "account-1");
    expect(email.textBody?.length).toBe(1_000_000);
  });
});

describe("error classification (generic messages, no server text)", () => {
  it.each([
    [{ authenticationFailed: true, message: "NO [AUTHENTICATIONFAILED] user juan@x" }, ProviderAuthError, "IMAP_AUTH_FAILED"],
    [{ serverResponseCode: "AUTHENTICATIONFAILED" }, ProviderAuthError, "IMAP_AUTH_FAILED"],
    [{ tlsFailed: true, message: "Server does not support STARTTLS" }, ProviderSecurityError, "IMAP_STARTTLS_UNAVAILABLE"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, ProviderSecurityError, "IMAP_TLS_FAILED"],
    // A STARTTLS upgrade that fails on the certificate: ImapFlow sets tlsFailed AND the certificate code.
    [{ tlsFailed: true, code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, ProviderSecurityError, "IMAP_TLS_FAILED"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID", message: "Host: 10.0.0.1 is not in the cert's altnames" }, ProviderSecurityError, "IMAP_TLS_FAILED"],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, ProviderSecurityError, "IMAP_TLS_FAILED"],
    [new ImapDestinationError("IMAP_ADDRESS_FORBIDDEN", "x"), ProviderSecurityError, "IMAP_HOST_FORBIDDEN"],
    [new ImapDestinationError("IMAP_HOST_INVALID", "x"), ProviderSecurityError, "IMAP_HOST_FORBIDDEN"]
  ])("%j -> %s", (error, type, code) => {
    const classified = classifyImapError(error);
    expect(classified).toBeInstanceOf(type);
    expect((classified as unknown as { code: string }).code).toBe(code);
    expect(classified.message).not.toMatch(/10\.0\.0\.1|juan@x/);
  });

  it.each([{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }, { code: "CONNECT_TIMEOUT" }, { code: "ECONNRESET" }, { code: "EAI_AGAIN" }, new Error("weird"), new ImapDestinationError("IMAP_DNS_FAILED", "x")])(
    "%j -> transient (bounded BullMQ retries)",
    (error) => {
      expect(classifyImapError(error)).toBeInstanceOf(ProviderTransientError);
    }
  );

  it("passes through classified errors, unreadable credentials and 'message gone'", () => {
    const gone = new ProviderHttpError("gone", 404);
    const unreadable = new SecretBoxError("x");
    expect(classifyImapError(gone)).toBe(gone);
    expect(classifyImapError(unreadable)).toBe(unreadable);
  });
});

describe("stored IMAP settings are re-validated before every connection", () => {
  const imap = (settings: Record<string, unknown>) => makeAccount({ provider: "IMAP", providerMetadata: { imap: settings } });

  it("valid E1 settings", () => {
    expect(readImapEndpoint(imap({ host: "imap.hostinger.com", port: 993, security: "TLS", username: "u" }))).toEqual({ host: "imap.hostinger.com", port: 993, security: "TLS" });
  });

  it.each([
    [{ host: "imap.example-mail.com", port: 993, secure: true, username: "u" }],
    [{ host: "imap.example-mail.com", port: 143, secure: false, username: "u" }],
    [{ host: "127.0.0.1", port: 993, security: "TLS" }],
    [{ host: "mail.internal", port: 993, security: "TLS" }],
    [{ host: "imap.example-mail.com", port: 110, security: "TLS" }],
    [{ host: "imap.example-mail.com", port: 143, security: "NONE" }]
  ])("legacy / tampered settings %j -> ProviderSecurityError IMAP_SETTINGS_INVALID", (settings) => {
    expect(() => readImapEndpoint(imap(settings))).toThrow(ProviderSecurityError);
  });

  it("missing settings", () => {
    expect(() => readImapEndpoint(makeAccount({ provider: "IMAP" }))).toThrow(ProviderSecurityError);
  });

  it("the pool key changes with the server, login or stored password", () => {
    const account = makeAccount({ id: "a1", accessTokenEncrypted: "v2.one" });
    const endpoint = { host: "imap.example-mail.com", port: 993, security: "TLS" as const };
    const key = imapPoolKey(account, endpoint, "u");
    expect(imapPoolKey(account, endpoint, "u")).toBe(key);
    expect(imapPoolKey({ ...account, accessTokenEncrypted: "v2.two" }, endpoint, "u")).not.toBe(key);
    expect(imapPoolKey(account, { ...endpoint, host: "imappro.example-mail.com" }, "u")).not.toBe(key);
    expect(imapPoolKey(account, endpoint, "other")).not.toBe(key);
    expect(key.startsWith("a1:")).toBe(true);
    expect(key).not.toContain("v2.one");
  });
});

class FakeClient implements PoolableClient {
  usable = true;
  logouts = 0;
  closes = 0;
  listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  async logout() {
    this.logouts += 1;
    this.usable = false;
  }
  close() {
    this.closes += 1;
    this.usable = false;
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
}

describe("connection pool", () => {
  afterEach(() => vi.useRealTimers());

  it("at most 2 connections per mailbox at the same time; the third operation waits and reuses one", async () => {
    const pool = new ImapConnectionPool<FakeClient>({ idleMs: 1_000 });
    const opened: FakeClient[] = [];
    const open = vi.fn(async () => {
      const client = new FakeClient();
      opened.push(client);
      return client;
    });
    let concurrent = 0;
    let peak = 0;
    const work = () =>
      pool.use("acc", open, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
      });
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    expect(pool.stats()).toMatchObject({ open: 2, busy: 0 });
    await pool.closeAll();
    expect(opened.every((client) => client.logouts === 1 && client.closes === 1)).toBe(true);
    expect(pool.stats().open).toBe(0);
  });

  it("at most 10 connections in total; an idle connection of another mailbox is closed to make room", async () => {
    const pool = new ImapConnectionPool<FakeClient>({ maxTotal: 3, idleMs: 60_000 });
    const clients: FakeClient[] = [];
    const open = async () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    };
    for (const key of ["a", "b", "c"]) await pool.use(key, open, async () => undefined);
    expect(pool.stats().open).toBe(3);
    await pool.use("d", open, async () => undefined);
    expect(pool.stats().open).toBe(3);
    expect(clients[0]?.closes).toBe(1); // the least recently used idle one
    expect(new ImapConnectionPool().stats()).toEqual({ open: 0, busy: 0, opening: 0, byKey: {} });
    await pool.closeAll();
  });

  it("a full pool with nothing idle makes callers wait, then fail with a transient error (bounded)", async () => {
    const pool = new ImapConnectionPool<FakeClient>({ maxTotal: 1, acquireTimeoutMs: 30 });
    let release!: () => void;
    const busy = pool.use("a", async () => new FakeClient(), () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(pool.use("b", async () => new FakeClient(), async () => undefined)).rejects.toBeInstanceOf(ProviderTransientError);
    release();
    await busy;
    await pool.closeAll();
  });

  it("idle connections are logged out after the idle delay (30 s by default)", async () => {
    vi.useFakeTimers();
    const pool = new ImapConnectionPool<FakeClient>();
    const client = new FakeClient();
    await pool.use("a", async () => client, async () => undefined);
    expect(pool.stats().open).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(client.logouts).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.logouts).toBe(1);
    expect(pool.stats().open).toBe(0);
  });

  it("a connection whose operation failed is discarded, never reused", async () => {
    const pool = new ImapConnectionPool<FakeClient>();
    const first = new FakeClient();
    const second = new FakeClient();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(pool.use("a", open, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(first.closes).toBe(1);
    await pool.use("a", open, async (client) => expect(client).toBe(second));
    await pool.closeAll();
  });

  it("a failed open frees its slot; after closeAll nothing new is opened", async () => {
    const pool = new ImapConnectionPool<FakeClient>({ maxPerKey: 1 });
    await expect(pool.use("a", async () => Promise.reject(new ProviderTransientError("down", null)), async () => undefined)).rejects.toBeInstanceOf(ProviderTransientError);
    expect(pool.stats()).toMatchObject({ open: 0, opening: 0 });
    await pool.closeAll();
    const open = vi.fn(async () => new FakeClient());
    await expect(pool.use("a", open, async () => undefined)).rejects.toBeInstanceOf(ProviderTransientError);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("production connector: E1 checks before ImapFlow", () => {
  const endpoint = { host: "imap.example-mail.com", port: 993, security: "TLS" as const };
  const credentials = { username: "u", password: "p" };
  const fakeClient = {} as ImapClient;
  const openMock = () => vi.fn(async (_options: ImapConnectionOptions, _credentials: unknown) => fakeClient);
  const resolverOf = (...addresses: string[]): ImapResolver => vi.fn(async () => addresses.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 })));

  it("ImapFlow receives a validated IP literal as host and the DNS name as servername, certificate checks on", async () => {
    const open = openMock();
    await createImapConnector({ resolver: resolverOf("93.184.216.34"), open })(endpoint, credentials);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      host: "93.184.216.34",
      port: 993,
      secure: true,
      servername: "imap.example-mail.com",
      tls: { servername: "imap.example-mail.com", rejectUnauthorized: true, minVersion: "TLSv1.2" }
    });
    expect(open.mock.calls[0]?.[0].proxy).toBeUndefined();
  });

  it("143: STARTTLS mandatory", async () => {
    const open = openMock();
    await createImapConnector({ resolver: resolverOf("93.184.216.34"), open })({ ...endpoint, port: 143, security: "STARTTLS" }, credentials);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
  });

  it.each([["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["93.184.216.34", "192.168.1.2"], ["::1"]])("forbidden answers %j: refused before any connection", async (...addresses) => {
    const open = vi.fn(async () => fakeClient);
    const error = await createImapConnector({ resolver: resolverOf(...addresses), open })(endpoint, credentials).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect((error as ProviderSecurityError).code).toBe("IMAP_HOST_FORBIDDEN");
    expect(open).not.toHaveBeenCalled();
  });

  it("an internal name is refused without even resolving it", async () => {
    const resolver = resolverOf("93.184.216.34");
    const open = vi.fn(async () => fakeClient);
    await expect(createImapConnector({ resolver, open })({ ...endpoint, host: "mail.internal" }, credentials)).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("a DNS failure is transient", async () => {
    const open = vi.fn(async () => fakeClient);
    await expect(createImapConnector({ resolver: vi.fn(async () => Promise.reject(new Error("SERVFAIL"))), open })(endpoint, credentials)).rejects.toBeInstanceOf(ProviderTransientError);
    expect(open).not.toHaveBeenCalled();
  });

  it("an unreachable address moves on to the next validated one; a TLS failure does not", async () => {
    const open = vi.fn().mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })).mockResolvedValueOnce(fakeClient);
    await createImapConnector({ resolver: resolverOf("93.184.216.34", "93.184.216.35"), open })(endpoint, credentials);
    expect(open.mock.calls.map((call) => (call[0] as { host: string }).host)).toEqual(["93.184.216.34", "93.184.216.35"]);

    const tls = vi.fn().mockRejectedValue(Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
    await expect(createImapConnector({ resolver: resolverOf("93.184.216.34", "93.184.216.35"), open: tls })(endpoint, credentials)).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(tls).toHaveBeenCalledTimes(1);
  });

  it("DNS is resolved again for every new connection (a rebinding answer is refused, the old IP is never reused blindly)", async () => {
    let calls = 0;
    const resolver: ImapResolver = vi.fn(async () => {
      calls += 1;
      return [{ address: calls === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 as const }];
    });
    const open = vi.fn(async () => fakeClient);
    const connect = createImapConnector({ resolver, open });
    await connect(endpoint, credentials);
    await expect(connect(endpoint, credentials)).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("IMAP credentials (SecretBox v2 bound to the mailbox)", () => {
  const box = new SecretBox(randomBytes(32));
  const deps = { secretBox: box, accounts: makeAccountStore([]), oauth: { GMAIL: null, MICROSOFT: null }, fetch: vi.fn() as unknown as typeof fetch };
  const account = (overrides = {}) =>
    makeAccount({
      provider: "IMAP",
      emailAddress: "ventas@empresa-correo.com",
      providerMetadata: { imap: { host: "imap.hostinger.com", port: 993, security: "TLS", username: "ventas@empresa-correo.com" } },
      accessTokenEncrypted: box.encryptBound("app-password", imapCredentialContext("11111111-1111-4111-8111-111111111111", "ventas@empresa-correo.com")),
      ...overrides
    });

  it("decrypts with decryptBound and the (organization, address) context", async () => {
    const context = createProviderContext(account(), deps);
    await expect(context.getImapCredentials?.()).resolves.toEqual({ username: "ventas@empresa-correo.com", password: "app-password" });
  });

  it("never through the OAuth path", async () => {
    await expect(createProviderContext(account(), deps).getAccessToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("a legacy v1 value, a value of another mailbox or another key: SecretBoxError (CREDENTIALS_UNREADABLE, no retry)", async () => {
    await expect(createProviderContext(account({ accessTokenEncrypted: box.encrypt("app-password") }), deps).getImapCredentials?.()).rejects.toBeInstanceOf(SecretBoxError);
    await expect(createProviderContext(account({ emailAddress: "otra@empresa-correo.com" }), deps).getImapCredentials?.()).rejects.toBeInstanceOf(SecretBoxError);
    await expect(createProviderContext(account(), { ...deps, secretBox: new SecretBox(randomBytes(32)) }).getImapCredentials?.()).rejects.toBeInstanceOf(SecretBoxError);
  });

  it("no stored password or username: ProviderAuthError", async () => {
    await expect(createProviderContext(account({ accessTokenEncrypted: null }), deps).getImapCredentials?.()).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(createProviderContext(account({ providerMetadata: { imap: { host: "x" } } }), deps).getImapCredentials?.()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("OAuth accounts keep their context (no IMAP credentials)", () => {
    expect(createProviderContext(makeAccount(), deps).getImapCredentials).toBeUndefined();
  });
});

describe("A1: snippets of attacker-controlled HTML (bounded input, linear conversion)", () => {
  const viaRulesEngine = (html: string) => {
    const prefix = snippetHtmlPrefix(html);
    expect(prefix.length).toBeLessThanOrEqual(IMAP_SNIPPET_HTML_INPUT);
    expect(html.startsWith(prefix)).toBe(true);
    const compact = htmlToText(prefix).replace(/\s+/g, " ").trim();
    return compact.length > 0 ? compact.slice(0, 200) : null;
  };

  it("the converted prefix is bounded and never ends inside a tag", () => {
    expect(snippetHtmlPrefix("<p>corto</p>")).toBe("<p>corto</p>");
    const big = "x".repeat(IMAP_SNIPPET_HTML_INPUT - 3) + "<a href='y'>z</a>";
    expect(snippetHtmlPrefix(big)).toBe("x".repeat(IMAP_SNIPPET_HTML_INPUT - 3));
    expect(snippetHtmlPrefix("<style".repeat(200_000)).length).toBeLessThanOrEqual(IMAP_SNIPPET_HTML_INPUT);
    expect(snippetHtmlPrefix("y".repeat(200_000))).toHaveLength(IMAP_SNIPPET_HTML_INPUT);
  });

  it("normal HTML: script / style removed, text kept", () => {
    expect(snippetOf(null, "<style>.x{color:red}</style><p>Hola <b>Juan</b>, tu c&oacute;digo es 4821</p><script>alert(1)</script>")).toBe(
      viaRulesEngine("<style>.x{color:red}</style><p>Hola <b>Juan</b>, tu c&oacute;digo es 4821</p><script>alert(1)</script>")
    );
    expect(snippetOf(null, "<p>Hola <b>Juan</b></p>")).toBe("Hola Juan");
    expect(snippetOf("texto plano  con   espacios", "<p>ignored</p>")).toBe("texto plano con espacios");
    expect(snippetOf(null, null)).toBeNull();
  });

  it.each([["<style"], ["<a"], ["<script"], ["<"], ["<a href='x"], ["<style>x<style>"]])(
    "1 MB of %j without closing: same result as htmlToText on the 64 KB prefix, quickly",
    (unit) => {
      const html = unit.repeat(Math.ceil(1_000_000 / unit.length));
      expect(html.length).toBeGreaterThanOrEqual(1_000_000);
      const started = performance.now();
      const snippet = snippetOf(null, html);
      const elapsed = performance.now() - started;
      expect(snippet).toBe(viaRulesEngine(html));
      // Secondary guard only (the property is the bounded prefix above); the old regex took minutes here.
      expect(elapsed).toBeLessThan(2_000);
    }
  );

  it("only the 64 KB prefix is ever converted: what comes after it cannot change the result", () => {
    const prefix = `<p>Codigo 4821</p>${"<span>a</span> ".repeat(Math.ceil(IMAP_SNIPPET_HTML_INPUT / 15))}`;
    expect(prefix.length).toBeGreaterThan(IMAP_SNIPPET_HTML_INPUT);
    const a = snippetOf(null, `${prefix}<p>AFTER-ONE</p>`);
    const b = snippetOf(null, `${prefix}${"<style".repeat(200_000)}`);
    expect(a).toBe(b);
    expect(a?.startsWith("Codigo 4821")).toBe(true);
  });

  it("a tag cut by the prefix leaves a safe, reasonable snippet (no markup)", () => {
    const html = `<p>Codigo 4821</p>${" ".repeat(IMAP_SNIPPET_HTML_INPUT - 25)}<a href="https://example.com/very/long">enlace</a>`;
    const snippet = snippetOf(null, html);
    expect(snippet).toBe("Codigo 4821");
    expect(snippet).not.toContain("<");
  });

  it("a 1 MB HTML-only message with unclosed tags is normalized without blocking", async () => {
    const body = "<a".repeat(500_000);
    const source = Buffer.from(`From: x@y.example\r\nSubject: html bomb\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`);
    const started = performance.now();
    const email = await normalizeImapMessage(source, { providerMessageId: "7:1", internalDate: new Date("2026-10-14T10:00:00Z") }, "account-1");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(email.htmlBody?.length).toBeGreaterThan(900_000);
    expect(email.snippet).toBe(viaRulesEngine(email.htmlBody as string));
  });
});

describe("M3: errors of a STARTTLS upgrade (ImapFlow flags every one of them tlsFailed)", () => {
  it.each([
    ["1. invalid certificate", { tlsFailed: true, code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "IMAP_TLS_FAILED"],
    ["1. certificate for another name", { tlsFailed: true, code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "IMAP_TLS_FAILED"],
    ["2. STARTTLS not offered", { tlsFailed: true, message: "Server does not support STARTTLS" }, "IMAP_STARTTLS_UNAVAILABLE"],
    ["plaintext injection after STARTTLS", { tlsFailed: true, code: "STARTTLS_INJECTION" }, "IMAP_TLS_FAILED"],
    ["5. unknown TLS error (fails closed)", { tlsFailed: true, code: "ERR_UNSEEN_TLS_THING" }, "IMAP_TLS_FAILED"],
    ["TLS protocol error", { tlsFailed: true, code: "EPROTO" }, "IMAP_TLS_FAILED"]
  ])("%s -> ProviderSecurityError (no retry, no plaintext fallback)", (_label, error, code) => {
    const classified = classifyImapError(error);
    expect(classified).toBeInstanceOf(ProviderSecurityError);
    expect((classified as unknown as { code: string }).code).toBe(code);
  });

  it.each([
    ["3. connection reset during the handshake", { tlsFailed: true, code: "ECONNRESET" }],
    ["4. handshake timeout", { tlsFailed: true, code: "UPGRADE_TIMEOUT" }],
    ["socket timeout", { tlsFailed: true, code: "ETIMEDOUT" }],
    ["connection closed", { tlsFailed: true, code: "ClosedAfterConnectText" }],
    ["broken pipe", { tlsFailed: true, code: "EPIPE" }]
  ])("%s -> ProviderTransientError (bounded BullMQ retries)", (_label, error) => {
    expect(classifyImapError(error)).toBeInstanceOf(ProviderTransientError);
  });

  it("a certificate code wins over a network-looking situation; tlsFailed alone is never transient", () => {
    expect(classifyImapError({ tlsFailed: true, code: "CERT_HAS_EXPIRED" })).toBeInstanceOf(ProviderSecurityError);
    expect(classifyImapError({ tlsFailed: true })).toBeInstanceOf(ProviderSecurityError);
  });
});

describe("M5: locating the opt-in Dovecot script (no process is started here)", () => {
  const winScript = "C:\\Users\\dev\\Projects\\EmailBot\\apps\\worker\\scripts\\imap-integration-dovecot.sh";
  const linuxScript = "/home/dev/EmailBot/apps/worker/scripts/imap-integration-dovecot.sh";

  it("the default script is found from this package, not from the current directory", () => {
    expect(DEFAULT_IMAP_E2_SCRIPT.replace(/\\/g, "/")).toMatch(/\/apps\/worker\/scripts\/imap-integration-dovecot\.sh$/);
    expect(existsSync(DEFAULT_IMAP_E2_SCRIPT)).toBe(true);
    for (const cwd of ["/repo", "/repo/apps/worker"]) {
      expect(integrationScriptCommand({}, { platform: "linux", cwd, defaultScript: linuxScript })).toEqual({ command: "bash", args: [linuxScript] });
    }
  });

  it("Linux: plain bash; IMAP_E2_SCRIPT absolute or relative to the current directory", () => {
    expect(integrationScriptCommand({ IMAP_E2_SCRIPT: "/opt/s.sh" }, { platform: "linux", cwd: "/repo" }).args).toEqual(["/opt/s.sh"]);
    expect(integrationScriptCommand({ IMAP_E2_SCRIPT: "apps/worker/scripts/x.sh" }, { platform: "linux", cwd: "/repo" }).args).toEqual(["/repo/apps/worker/scripts/x.sh"]);
    expect(integrationScriptCommand({ IMAP_E2_SCRIPT: "scripts/x.sh" }, { platform: "darwin", cwd: "/repo/apps/worker" })).toEqual({ command: "bash", args: ["/repo/apps/worker/scripts/x.sh"] });
    // IMAP_E2_WORK reaches bash through the inherited environment, not as an argument.
    expect(integrationScriptCommand({ IMAP_E2_WORK: "/tmp/w" }, { platform: "linux", cwd: "/repo", defaultScript: linuxScript }).args).toEqual([linuxScript]);
  });

  it("Windows: bash inside WSL, with WSL paths, from the root or from apps/worker", () => {
    expect(integrationScriptCommand({}, { platform: "win32", cwd: "C:\\Users\\dev\\Projects\\EmailBot", defaultScript: winScript })).toEqual({
      command: "wsl.exe",
      args: ["-e", "env", "bash", "/mnt/c/Users/dev/Projects/EmailBot/apps/worker/scripts/imap-integration-dovecot.sh"]
    });
    const fromRoot = integrationScriptCommand({ IMAP_E2_SCRIPT: "apps\\worker\\scripts\\imap-integration-dovecot.sh" }, { platform: "win32", cwd: "C:\\Users\\dev\\Projects\\EmailBot" });
    const fromWorker = integrationScriptCommand({ IMAP_E2_SCRIPT: "scripts/imap-integration-dovecot.sh" }, { platform: "win32", cwd: "C:\\Users\\dev\\Projects\\EmailBot\\apps\\worker" });
    expect(fromRoot.args.at(-1)).toBe("/mnt/c/Users/dev/Projects/EmailBot/apps/worker/scripts/imap-integration-dovecot.sh");
    expect(fromWorker.args.at(-1)).toBe(fromRoot.args.at(-1));
  });

  it("Windows: IMAP_E2_WORK is forwarded explicitly (wsl.exe does not forward the environment)", () => {
    const command = integrationScriptCommand({ IMAP_E2_WORK: "C:\\Temp\\emailbot imap" }, { platform: "win32", cwd: "C:\\repo", defaultScript: winScript });
    expect(command.args.slice(0, 4)).toEqual(["-e", "env", "IMAP_E2_WORK=/mnt/c/Temp/emailbot imap", "bash"]);
  });

  it("toWslPath: drive paths, POSIX paths and values rewritten by Git Bash (MSYS)", () => {
    expect(toWslPath("D:\\Work\\a b\\x.sh")).toBe("/mnt/d/Work/a b/x.sh");
    expect(toWslPath("C:/Users/dev/x.sh")).toBe("/mnt/c/Users/dev/x.sh");
    expect(toWslPath("/mnt/c/Users/dev/x.sh")).toBe("/mnt/c/Users/dev/x.sh");
    expect(toWslPath("/tmp/emailbot-imap-e2")).toBe("/tmp/emailbot-imap-e2");
    expect(toWslPath("C:/Program Files/Git/mnt/c/Users/dev/x.sh")).toBe("/mnt/c/Users/dev/x.sh");
  });
});
