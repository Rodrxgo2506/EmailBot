import dns from "node:dns";
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
  imapConnectionOptions,
  imapCredentialContext,
  openImapClient,
  resolveImapDestination,
  type ImapFlow,
  type ImapProbeOpen,
  type ImapResolver
} from "@emailbot/shared";
import type { EmailAccount } from "@emailbot/types";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";

/*
 * IMAP E3 - REAL integration of the API connection test against a local,
 * throwaway Dovecot 2.4.5 (apps/worker/scripts/imap-integration-dovecot.sh,
 * published on 127.0.0.1 only; see docs/imap.md). Opt-in: every test here is
 * SKIPPED unless IMAP_INTEGRATION_SCENARIO is A, B or C. CI never sets it.
 *
 * The production transport is used unchanged (shared openImapClient after every
 * E1 check). The test DNS answer is a public IP (TEST_IP): a socket-level hook
 * records every TCP destination and every byte written before TLS, and only then
 * redirects TEST_IP to 127.0.0.1. The test CA is trusted through
 * NODE_EXTRA_CA_CERTS for this process only (never through connection options).
 */

const SCENARIO = process.env.IMAP_INTEGRATION_SCENARIO ?? "";
const PASSWORD = process.env.IMAP_TEST_PASSWORD ?? "";
if (SCENARIO !== "" && (!["A", "B", "C"].includes(SCENARIO) || PASSWORD.length === 0)) {
  throw new Error("IMAP_INTEGRATION_SCENARIO must be A, B or C, with IMAP_TEST_PASSWORD set (see docs/imap.md)");
}
const run = (scenario: string) => SCENARIO === scenario;

const HOST = "imap.emailbot-e2-integration.com";
const TEST_IP = "93.184.216.34";
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const owner = makeUser({ [ORG_A]: "OWNER" });

const dialed: Array<{ host: string; port: number }> = [];
const sockets: net.Socket[] = [];
const plaintextWrites: string[] = [];
const dnsLookups: string[] = [];
const originalConnect = net.Socket.prototype.connect;
const originalWrite = net.Socket.prototype.write;
const originalLookup = dns.lookup;

function installHooks() {
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; port?: number } | undefined;
    if (options && typeof options === "object" && typeof options.host === "string") {
      dialed.push({ host: options.host, port: Number(options.port) });
      sockets.push(this);
      if (options.host === TEST_IP) options.host = "127.0.0.1";
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  net.Socket.prototype.write = function patched(this: net.Socket, chunk: unknown, ...rest: unknown[]) {
    if (!(this as unknown as { encrypted?: boolean }).encrypted) plaintextWrites.push(Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk));
    return (originalWrite as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof net.Socket.prototype.write;
  dns.lookup = function patched(hostname: string, ...rest: unknown[]) {
    dnsLookups.push(hostname);
    return (originalLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest);
  } as typeof dns.lookup;
}

beforeAll(() => installHooks());
afterAll(() => {
  net.Socket.prototype.connect = originalConnect;
  net.Socket.prototype.write = originalWrite;
  dns.lookup = originalLookup;
});

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
  dialed.length = 0;
  sockets.length = 0;
  plaintextWrites.length = 0;
  dnsLookups.length = 0;
});

const resolver: ImapResolver = vi.fn(async () => [{ address: TEST_IP, family: 4 as const }]);
/** The production connection (what deps.imapProbeOpen defaults to outside tests). */
const realOpen: ImapProbeOpen = (options, login, onClient) => openImapClient(options, login, { onClient });

async function setup() {
  ctx = await createTestApp({ users: [owner], config: { imapAccountsEnabled: true }, imapResolver: resolver, imapProbeOpen: realOpen });
  ctx.repos.emailAccounts.list.mockResolvedValue([]);
  return ctx;
}

const uniqueUser = (label: string) => `${label}-${randomBytes(4).toString("hex")}@emailbot-e2-integration.com`;
const payload = (user: string, overrides: Record<string, unknown> = {}) => ({ emailAddress: user, host: HOST, port: 993, security: "TLS", username: user, password: PASSWORD, ...overrides });
const testConnection = (body: object) => ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap/test", headers: authHeaders(owner, ORG_A), payload: body });

/** Every socket opened by the request is closed afterwards (success and failure). */
async function expectAllSocketsClosed() {
  expect(sockets.length).toBeGreaterThan(0);
  await vi.waitFor(() => expect(sockets.every((socket) => socket.destroyed)).toBe(true), { timeout: 5_000 });
}

/** Setup-only client (APPEND / read flags / position) on the same checked connection path. */
async function setupClient(user: string): Promise<ImapFlow> {
  const options = imapConnectionOptions(await resolveImapDestination({ host: HOST, port: 993, security: "TLS" }, { resolver }));
  return openImapClient(options, { username: user, password: PASSWORD });
}
const message = (n: number) =>
  Buffer.from(`From: Streaming <info@streaming.example>\r\nTo: me@empresa-correo.com\r\nSubject: Codigo ${n}\r\nMessage-ID: <e3-${n}-${randomBytes(3).toString("hex")}@streaming.example>\r\n\r\nTu codigo es 4821\r\n`);

describe.runIf(run("A"))("A - valid certificate (API connection test, real Dovecot)", () => {
  it("TLS 993: 200; the validated IP is dialled with no DNS at connect time; every socket closed", async () => {
    await setup();
    const response = await testConnection(payload(uniqueUser("tls")));
    expect([response.statusCode, response.json()]).toEqual([200, { ok: true }]);
    expect(dialed).toEqual([{ host: TEST_IP, port: 993 }]);
    expect(dnsLookups).not.toContain(HOST);
    expect(response.body).not.toContain(PASSWORD);
    await expectAllSocketsClosed();
  });

  it("STARTTLS 143: 200; nothing but the greeting exchange and STARTTLS travel in clear (no LOGIN, no password)", async () => {
    await setup();
    const user = uniqueUser("starttls");
    const response = await testConnection(payload(user, { port: 143, security: "STARTTLS" }));
    expect(response.statusCode).toBe(200);
    expect(dialed).toEqual([{ host: TEST_IP, port: 143 }]);
    const plain = plaintextWrites.join("");
    expect(plain).toMatch(/STARTTLS/);
    expect(plain).not.toContain(PASSWORD);
    expect(plain).not.toContain(user);
    expect(plain).not.toMatch(/\bLOGIN\b|AUTHENTICATE/);
    await expectAllSocketsClosed();
  });

  it("wrong password: 422 IMAP_AUTH_FAILED, sockets closed", async () => {
    await setup();
    const response = await testConnection(payload(uniqueUser("wrong"), { password: `${PASSWORD}-wrong` }));
    expect([response.statusCode, response.json().error.code]).toEqual([422, "IMAP_AUTH_FAILED"]);
    expect(response.body).not.toContain(PASSWORD);
    await expectAllSocketsClosed();
  });

  it("creation: the stored cursor is the real INBOX position (UIDNEXT - 1); EXAMINE marks nothing \\Seen", async () => {
    const context = await setup();
    const user = uniqueUser("create");
    const client = await setupClient(user);
    try {
      for (let n = 1; n <= 3; n += 1) await client.append("INBOX", message(n));
    } finally {
      await client.logout();
    }

    const account: EmailAccount = {
      id: ACCOUNT_ID,
      organizationId: ORG_A,
      provider: "IMAP",
      status: "PAUSED",
      emailAddress: user,
      displayName: null,
      lastSyncedAt: null,
      lastErrorCode: "IMAP_SYNC_NOT_IMPLEMENTED",
      lastErrorMessage: null,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z"
    };
    context.privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account, created: true, previousStatus: null });
    const response = await context.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(owner, ORG_A), payload: payload(user) });
    expect(response.statusCode).toBe(201);
    await expectAllSocketsClosed();

    const check = await setupClient(user);
    try {
      const status = await check.status("INBOX", { uidNext: true, uidValidity: true });
      if (!status) throw new Error("STATUS INBOX failed");
      const input = context.privileged.connectImapEmailAccount.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input.syncCursor).toBe(`imap:v1:${String(status.uidValidity)}:${Number(status.uidNext) - 1}`);
      expect(Number(status.uidNext) - 1).toBe(3);
      expect(context.deps.secretBox.decryptBound(input.passwordEncrypted as string, imapCredentialContext(ORG_A, user))).toBe(PASSWORD);

      const lock = await check.getMailboxLock("INBOX", { readOnly: true });
      try {
        const flags: string[][] = [];
        for await (const item of check.fetch("1:*", { uid: true, flags: true }, { uid: true })) flags.push([...(item.flags ?? [])]);
        expect(flags).toHaveLength(3);
        expect(flags.every((set) => !set.includes("\\Seen"))).toBe(true);
      } finally {
        lock.release();
      }
    } finally {
      await check.logout();
    }
    expect(context.queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });
});

describe.runIf(run("B"))("B - untrusted certificate (API connection test, real Dovecot)", () => {
  it("TLS 993: 422 IMAP_TLS_FAILED, one connection only, sockets closed", async () => {
    await setup();
    const response = await testConnection(payload(uniqueUser("b993")));
    expect([response.statusCode, response.json().error.code]).toEqual([422, "IMAP_TLS_FAILED"]);
    expect(dialed).toEqual([{ host: TEST_IP, port: 993 }]);
    await expectAllSocketsClosed();
  });

  it("STARTTLS 143: 422 IMAP_TLS_FAILED; the password never travels in clear", async () => {
    await setup();
    const user = uniqueUser("b143");
    const response = await testConnection(payload(user, { port: 143, security: "STARTTLS" }));
    expect([response.statusCode, response.json().error.code]).toEqual([422, "IMAP_TLS_FAILED"]);
    const plain = plaintextWrites.join("");
    expect(plain).not.toContain(PASSWORD);
    expect(plain).not.toContain(user);
    expect(plain).not.toMatch(/\bLOGIN\b|AUTHENTICATE/);
    await expectAllSocketsClosed();
  });
});

describe.runIf(run("C"))("C - no STARTTLS (API connection test, real Dovecot)", () => {
  it("143: 422 IMAP_STARTTLS_UNAVAILABLE; no username, password, LOGIN or AUTHENTICATE written in clear; sockets closed", async () => {
    await setup();
    const user = uniqueUser("c143");
    const response = await testConnection(payload(user, { port: 143, security: "STARTTLS" }));
    expect([response.statusCode, response.json().error.code]).toEqual([422, "IMAP_STARTTLS_UNAVAILABLE"]);
    expect(dialed).toEqual([{ host: TEST_IP, port: 143 }]);
    const plain = plaintextWrites.join("");
    expect(plain).not.toContain(PASSWORD);
    expect(plain).not.toContain(user);
    expect(plain).not.toMatch(/\bLOGIN\b|AUTHENTICATE/);
    await expectAllSocketsClosed();
  });
});
