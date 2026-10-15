import { imapCredentialContext, type ImapProbeClient, type ImapProbeOpen, type ImapResolver } from "@emailbot/shared";
import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createLoginThrottle, LOGIN_LOCKOUT } from "../infrastructure/login-throttle.js";
import { IMAP_CONNECTION_LIMITS, IMAP_LOGIN_LOCKOUT, imapMailboxLockKey } from "../modules/email-accounts/imap-connection.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";
import { entitlementsFor, noAccess } from "./plan-fixtures.js";

/*
 * IMAP E3: connection test (POST /api/email-accounts/imap/test) and the
 * connection test inside the creation (POST /api/email-accounts/imap).
 * IMAP is enabled in the TEST configuration only; production keeps
 * imapAccountsEnabled = false (see "disabled" below). DNS answers come from a
 * fake resolver and the IMAP server is a fake ImapFlow client plugged AFTER
 * every E1 check (deps.imapProbeOpen): these tests simulate the protocol, they
 * do not prove real TLS (Dovecot integration: imap-api-integration.test.ts).
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const admin = makeUser({ [ORG_A]: "ADMIN" });
const viewer = makeUser({ [ORG_A]: "VIEWER" });
const outsider = makeUser({ [ORG_B]: "OWNER" });
const PASSWORD = "contraseña-de-aplicacion-123";
const USERNAME = "ventas@empresa-correo.com";
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";

const body = { emailAddress: "Ventas@Empresa-Correo.com", host: "imap.hostinger.com", port: 993, security: "TLS", username: USERNAME, password: PASSWORD };

const account = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: ACCOUNT_ID,
  organizationId: ORG_A,
  provider: "IMAP",
  status: "PAUSED",
  emailAddress: "ventas@empresa-correo.com",
  displayName: null,
  lastSyncedAt: null,
  lastErrorCode: "IMAP_SYNC_NOT_IMPLEMENTED",
  lastErrorMessage: null,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides
});

interface FakeServer {
  open: ImapProbeOpen & ReturnType<typeof vi.fn>;
  clients: Array<ImapProbeClient & { closed: number; loggedOut: boolean; examined: unknown[] }>;
}

/** Fake IMAP server: `failure` is what ImapFlow would throw at connect/login; `hang` never answers. */
function fakeServer(options: { failure?: unknown; hang?: Promise<void>; uidValidity?: bigint; uidNext?: number } = {}): FakeServer {
  const clients: FakeServer["clients"] = [];
  const open = vi.fn(async (_options: unknown, _login: unknown, onClient: (client: ImapProbeClient) => void) => {
    const client = {
      closed: 0,
      loggedOut: false,
      examined: [] as unknown[],
      mailbox: false as unknown,
      async getMailboxLock(path: string, lockOptions: unknown) {
        client.examined.push([path, lockOptions]);
        client.mailbox = { path, readOnly: true, uidValidity: options.uidValidity ?? 1234n, uidNext: options.uidNext ?? 57 };
        return { path, release: () => undefined };
      },
      logout: vi.fn(async () => {
        client.loggedOut = true;
      }),
      close: vi.fn(() => {
        client.closed += 1;
      })
    };
    clients.push(client as never);
    onClient(client as never);
    if (options.hang) await options.hang;
    if (options.failure) throw options.failure;
    return client as never;
  });
  return { open: open as never, clients };
}

const publicResolver = (): ImapResolver => vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(options: { server?: FakeServer; resolver?: ImapResolver; enabled?: boolean } = {}) {
  const server = options.server ?? fakeServer();
  const resolver = options.resolver ?? publicResolver();
  ctx = await createTestApp({
    users: [owner, admin, viewer, outsider],
    config: { imapAccountsEnabled: options.enabled ?? true },
    imapResolver: resolver,
    imapProbeOpen: server.open
  });
  ctx.repos.emailAccounts.list.mockResolvedValue([]);
  return { ...ctx, server, resolver };
}

let ip = 0;
/** A different client IP per request (the per-IP route limit is tested on its own). */
const nextIp = () => `198.51.100.${(ip = (ip % 250) + 1)}`;
const testConnection = (payload: unknown = body, user = owner, organizationId: string = ORG_A, remoteAddress = nextIp()) =>
  ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap/test", headers: authHeaders(user, organizationId), payload: payload as object, remoteAddress });
const create = (payload: unknown = body, user = owner, remoteAddress = nextIp()) =>
  ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(user, ORG_A), payload: payload as object, remoteAddress });
const codeOf = (response: { json(): { error?: { code?: string } } }) => response.json().error?.code;

describe("disabled (production configuration: imapAccountsEnabled = false, fixed in code)", () => {
  it("both IMAP routes answer 503 IMAP_NOT_AVAILABLE before reading the body: no DNS, no connection, nothing stored or queued", async () => {
    const { server, resolver, privileged, queue } = await setup({ enabled: false });
    for (const response of [await testConnection(), await create({ ...body, displayName: "Ventas" })]) {
      expect([response.statusCode, codeOf(response)]).toEqual([503, "IMAP_NOT_AVAILABLE"]);
      expect(response.body).not.toContain(PASSWORD);
    }
    // Even an invalid body is not parsed.
    expect(codeOf(await testConnection({ password: 1 }))).toBe("IMAP_NOT_AVAILABLE");
    expect(resolver).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(queue.requestAccountSync).not.toHaveBeenCalled();
  });

  it("the providers endpoint still reports IMAP unavailable", async () => {
    await setup({ enabled: false });
    const response = await ctx!.app.inject({ method: "GET", url: "/api/email-accounts/providers", headers: authHeaders(owner, ORG_A) });
    expect(response.json().providers.IMAP).toBe(false);
  });
});

describe("authorization, plans and limits (checked before any connection)", () => {
  it("anonymous: 401, nothing contacted", async () => {
    const { server } = await setup();
    const response = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap/test", headers: { "x-organization-id": ORG_A }, payload: body });
    expect(response.statusCode).toBe(401);
    expect(server.open).not.toHaveBeenCalled();
  });

  it("VIEWER: 403; a user of another organization: 403 (never reaches the mailbox checks)", async () => {
    const { server, repos } = await setup();
    expect((await testConnection(body, viewer)).statusCode).toBe(403);
    expect((await testConnection(body, outsider, ORG_A)).statusCode).toBe(403);
    expect(repos.emailAccounts.list).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
  });

  it("OWNER and ADMIN can test", async () => {
    await setup();
    expect((await testConnection(body, owner)).json()).toEqual({ ok: true });
    expect((await testConnection(body, admin)).json()).toEqual({ ok: true });
  });

  it("BASIC: 403 PLAN_FEATURE_UNAVAILABLE; no subscription: 403 SUBSCRIPTION_REQUIRED; no DNS, no connection", async () => {
    const { repos, server, resolver } = await setup();
    repos.plans.entitlements.mockResolvedValue(entitlementsFor("BASIC"));
    const basic = await testConnection();
    expect([basic.statusCode, codeOf(basic)]).toEqual([403, "PLAN_FEATURE_UNAVAILABLE"]);

    repos.plans.entitlements.mockResolvedValue(noAccess());
    const none = await testConnection();
    expect([none.statusCode, codeOf(none)]).toEqual([403, "SUBSCRIPTION_REQUIRED"]);
    expect(resolver).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
  });

  it("PRO and BUSINESS can test and connect", async () => {
    for (const plan of ["PRO", "BUSINESS"] as const) {
      const { repos, privileged } = await setup();
      repos.plans.entitlements.mockResolvedValue(entitlementsFor(plan));
      privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });
      expect((await testConnection()).statusCode, plan).toBe(200);
      expect((await create()).statusCode, plan).toBe(201);
      await ctx!.app.close();
      ctx = undefined;
    }
  });

  it("at the EMAIL_ACCOUNTS limit (and above it): 403 PLAN_LIMIT_REACHED before connecting; a reconnection of a counted IMAP mailbox is allowed", async () => {
    const { repos, server } = await setup();
    const max = entitlementsFor("BUSINESS").limits.EMAIL_ACCOUNTS as number;
    for (const used of [max, max + 3]) {
      repos.plans.usage.mockResolvedValue({ EMAIL_ACCOUNTS: used });
      const response = await testConnection();
      expect([response.statusCode, codeOf(response)]).toEqual([403, "PLAN_LIMIT_REACHED"]);
    }
    expect(server.open).not.toHaveBeenCalled();

    repos.emailAccounts.list.mockResolvedValue([account({ status: "ERROR" })]);
    expect((await testConnection()).statusCode).toBe(200);
    expect(server.open).toHaveBeenCalledTimes(1);
  });

  it("the same mailbox already connected through Gmail in this organization: 409 before connecting", async () => {
    const { repos, server } = await setup();
    repos.emailAccounts.list.mockResolvedValue([account({ provider: "GMAIL", status: "ACTIVE" })]);
    const response = await testConnection();
    expect([response.statusCode, codeOf(response)]).toEqual([409, "EMAIL_ACCOUNT_ALREADY_CONNECTED"]);
    expect(server.open).not.toHaveBeenCalled();
  });

  it("organization isolation: only the caller's organization is read; another organization's mailbox does not block nor leak", async () => {
    const { repos, privileged } = await setup();
    // RLS-scoped repository: ORG_A sees nothing even if ORG_B has this address.
    repos.emailAccounts.list.mockImplementation(async (organizationId: string) => (organizationId === ORG_B ? [account({ organizationId: ORG_B, provider: "GMAIL", status: "ACTIVE" })] : []));
    privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });
    expect((await testConnection()).statusCode).toBe(200);
    const created = await create();
    expect(created.statusCode).toBe(201);
    expect(repos.emailAccounts.list.mock.calls.every(([organizationId]) => organizationId === ORG_A)).toBe(true);
    expect(privileged.connectImapEmailAccount.mock.calls[0]?.[0]).toMatchObject({ organizationId: ORG_A });
    expect(created.body).not.toContain(ORG_B);
  });
});

describe("connection test (fake protocol after every E1 check)", () => {
  it("TLS 993: validated IP literal, DNS name for SNI / certificate, EXAMINE INBOX read-only, LOGOUT; nothing stored or queued", async () => {
    const { server, privileged, queue } = await setup();
    const response = await testConnection();
    expect([response.statusCode, response.json()]).toEqual([200, { ok: true }]);
    expect(server.open.mock.calls[0]?.[0]).toMatchObject({
      host: "93.184.216.34",
      port: 993,
      secure: true,
      servername: "imap.hostinger.com",
      tls: { servername: "imap.hostinger.com", rejectUnauthorized: true, minVersion: "TLSv1.2" }
    });
    expect(server.open.mock.calls[0]?.[1]).toEqual({ username: USERNAME, password: PASSWORD });
    expect(server.clients[0]?.examined).toEqual([["INBOX", { readOnly: true }]]);
    expect(server.clients[0]?.loggedOut).toBe(true);
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
  });

  it("STARTTLS 143: STARTTLS mandatory (doSTARTTLS), plain TCP never used for the login", async () => {
    const { server } = await setup();
    expect((await testConnection({ ...body, port: 143, security: "STARTTLS" })).statusCode).toBe(200);
    expect(server.open.mock.calls[0]?.[0]).toMatchObject({ port: 143, secure: false, doSTARTTLS: true, servername: "imap.hostinger.com" });
  });

  it.each([
    ["wrong password", { authenticationFailed: true }, "IMAP_AUTH_FAILED"],
    ["untrusted certificate", Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "IMAP_TLS_FAILED"],
    ["certificate for another name", Object.assign(new Error("altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "IMAP_TLS_FAILED"],
    ["STARTTLS not offered", Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true }), "IMAP_STARTTLS_UNAVAILABLE"],
    ["connection timeout", Object.assign(new Error("timeout"), { code: "CONNECT_TIMEOUT" }), "IMAP_TIMEOUT"],
    ["greeting timeout", Object.assign(new Error("timeout"), { code: "GREETING_TIMEOUT" }), "IMAP_TIMEOUT"],
    ["connection refused", Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:993"), { code: "ECONNREFUSED" }), "IMAP_UNREACHABLE"]
  ])("%s: 422 %s with a fixed message; the connection is closed; nothing stored", async (_label, failure, code) => {
    const { server, privileged } = await setup({ server: fakeServer({ failure }) });
    const response = await testConnection();
    expect([response.statusCode, codeOf(response)]).toEqual([422, code]);
    expect(response.body).not.toMatch(/93\.184|self signed|altnames|ECONNREFUSED|STARTTLS\b.*support/);
    expect(response.body).not.toContain(PASSWORD);
    expect(server.clients.every((client) => client.closed > 0)).toBe(true);
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it("a TLS / login failure never moves on to another address (no retry, no downgrade)", async () => {
    const server = fakeServer({ failure: Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }) });
    await setup({ server, resolver: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }, { address: "93.184.216.35", family: 4 as const }]) });
    expect(codeOf(await testConnection())).toBe("IMAP_TLS_FAILED");
    expect(server.open).toHaveBeenCalledTimes(1);
  });

  it("DNS failure: 422 IMAP_DNS_FAILED, nothing dialled", async () => {
    const { server } = await setup({ resolver: vi.fn(async () => Promise.reject(new Error("ENOTFOUND"))) });
    expect(codeOf(await testConnection())).toBe("IMAP_DNS_FAILED");
    expect(server.open).not.toHaveBeenCalled();
  });

  it.each([
    ["a private address", [{ address: "10.0.0.7", family: 4 as const }]],
    ["the metadata service", [{ address: "169.254.169.254", family: 4 as const }]],
    ["one public and one loopback address (mixed)", [{ address: "93.184.216.34", family: 4 as const }, { address: "::1", family: 6 as const }]]
  ])("SSRF: a host resolving to %s is refused (422 IMAP_ADDRESS_FORBIDDEN), nothing dialled, no address in the answer", async (_label, answer) => {
    const { server } = await setup({ resolver: vi.fn(async () => answer) });
    const response = await testConnection();
    expect([response.statusCode, codeOf(response)]).toEqual([422, "IMAP_ADDRESS_FORBIDDEN"]);
    expect(response.body).not.toMatch(/10\.0\.0\.7|169\.254|::1/);
    expect(server.open).not.toHaveBeenCalled();
  });

  it("DNS rebinding: the connector resolves again right before dialling; a now-private answer is refused, never dialled", async () => {
    let calls = 0;
    const resolver: ImapResolver = vi.fn(async () => {
      calls += 1;
      return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 as const }];
    });
    const { server } = await setup({ resolver });
    const response = await testConnection();
    expect([response.statusCode, codeOf(response)]).toEqual([422, "IMAP_HOST_FORBIDDEN"]);
    expect(server.open).not.toHaveBeenCalled();
  });

  it.each([
    ["an IP literal", { host: "93.184.216.34" }],
    ["localhost", { host: "localhost" }],
    ["an internal name", { host: "mail.internal" }],
    ["port 25", { port: 25 }],
    ["port 110", { port: 110 }],
    ["port 143 with TLS", { port: 143 }],
    ["port 993 with STARTTLS", { security: "STARTTLS" }],
    ["plaintext", { security: "NONE" }],
    ["an unknown field (proxy)", { proxy: "socks5://10.0.0.1" }],
    ["a display name (test only takes connection fields)", { displayName: "Ventas" }],
    ["an oversized password", { password: "x".repeat(1001) }],
    ["an oversized username", { username: "u".repeat(321) }],
    ["a missing password", { password: undefined }]
  ])("invalid input (%s): 400 before any DNS query or connection; the API is not a port scanner", async (_label, change) => {
    const { server, resolver } = await setup();
    const response = await testConnection({ ...body, ...change });
    expect(response.statusCode).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
  });
});

describe("abuse limits", () => {
  it("per IP: the route limit (RATE_LIMITS.imapTest) answers 429 RATE_LIMITED", async () => {
    await setup();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await testConnection(body, owner, ORG_A, "203.0.113.9")).statusCode);
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("per user (from many IPs): 429 IMAP_TEST_RATE_LIMITED without contacting the server", async () => {
    const { server } = await setup();
    for (let attempt = 0; attempt < IMAP_CONNECTION_LIMITS.perUser.max; attempt += 1) expect((await testConnection()).statusCode).toBe(200);
    const response = await testConnection();
    expect([response.statusCode, codeOf(response)]).toEqual([429, "IMAP_TEST_RATE_LIMITED"]);
    expect(server.open).toHaveBeenCalledTimes(IMAP_CONNECTION_LIMITS.perUser.max);
  });

  it("per organization (several users): 429 IMAP_TEST_RATE_LIMITED", async () => {
    const extra = makeUser({ [ORG_A]: "ADMIN" });
    const server = fakeServer();
    ctx = await createTestApp({ users: [owner, admin, extra], config: { imapAccountsEnabled: true }, imapResolver: publicResolver(), imapProbeOpen: server.open });
    ctx.repos.emailAccounts.list.mockResolvedValue([]);
    const users = [owner, admin, extra];
    for (let attempt = 0; attempt < IMAP_CONNECTION_LIMITS.perOrganization.max; attempt += 1) {
      expect((await testConnection(body, users[attempt % 3])).statusCode).toBe(200);
    }
    expect(codeOf(await testConnection(body, extra))).toBe("IMAP_TEST_RATE_LIMITED");
  });

  it("refused logins lock the mailbox (429 IMAP_LOGIN_LOCKED) without contacting the server again", async () => {
    const server = fakeServer({ failure: { authenticationFailed: true } });
    await setup({ server });
    // Two users alternate so the per-user attempt limit is not what stops them.
    for (let attempt = 0; attempt < 10; attempt += 1) expect(codeOf(await testConnection(body, attempt % 2 ? admin : owner))).toBe("IMAP_AUTH_FAILED");
    const locked = await testConnection(body, owner);
    expect([locked.statusCode, codeOf(locked)]).toEqual([429, "IMAP_LOGIN_LOCKED"]);
    expect(server.open).toHaveBeenCalledTimes(10);
  });

  it("concurrency: a second test of the same organization while one runs gets 429 IMAP_TEST_BUSY; the slot is freed afterwards", async () => {
    let finish!: () => void;
    const hang = new Promise<void>((resolve) => (finish = resolve));
    const server = fakeServer({ hang });
    await setup({ server });
    const first = testConnection(body, owner);
    await vi.waitFor(() => expect(server.open).toHaveBeenCalledTimes(1));
    const second = await testConnection(body, admin);
    expect([second.statusCode, codeOf(second)]).toEqual([429, "IMAP_TEST_BUSY"]);
    finish();
    expect((await first).statusCode).toBe(200);
    expect((await testConnection(body, admin)).statusCode).toBe(200);
  });
});

describe("creation: connection test first, then the atomic RPC", () => {
  it("stores the v2 password bound to (organization, address) and the INBOX position as the initial cursor; nothing queued", async () => {
    const { privileged, queue, server } = await setup({ server: fakeServer({ uidValidity: 4242n, uidNext: 1001 }) });
    privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });
    const response = await create({ ...body, displayName: "Ventas" });
    expect(response.statusCode).toBe(201);
    expect(server.clients[0]?.loggedOut).toBe(true);

    const input = privileged.connectImapEmailAccount.mock.calls[0]?.[0] as Record<string, unknown>;
    // UIDNEXT 1001: messages 1..1000 existed before (never imported), 1001+ arrive later (imported).
    expect(input).toMatchObject({ organizationId: ORG_A, host: "imap.hostinger.com", port: 993, security: "TLS", username: USERNAME, syncCursor: "imap:v1:4242:1000" });
    const encrypted = input.passwordEncrypted as string;
    const box = ctx!.deps.secretBox;
    expect(box.decryptBound(encrypted, imapCredentialContext(ORG_A, "ventas@empresa-correo.com"))).toBe(PASSWORD);
    // Bound to its context: another organization or another address cannot reuse it.
    expect(() => box.decryptBound(encrypted, imapCredentialContext(ORG_B, "ventas@empresa-correo.com"))).toThrow();
    expect(() => box.decryptBound(encrypted, imapCredentialContext(ORG_A, "otra@empresa-correo.com"))).toThrow();
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain(encrypted);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(queue.requestAccountSync).not.toHaveBeenCalled();
  });

  it("a failed connection test stores nothing: no RPC call, so no account and no encrypted password", async () => {
    const { privileged } = await setup({ server: fakeServer({ failure: { authenticationFailed: true } }) });
    const response = await create();
    expect([response.statusCode, codeOf(response)]).toEqual([422, "IMAP_AUTH_FAILED"]);
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
  });

  it("the atomic operation fails: one RPC call (one transaction), no audit, nothing queued, no secret in the answer", async () => {
    const { privileged, queue } = await setup();
    privileged.connectImapEmailAccount.mockRejectedValue(new Error("connection terminated"));
    const response = await create();
    expect(response.statusCode).toBe(500);
    expect(privileged.connectImapEmailAccount).toHaveBeenCalledTimes(1);
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain("v2.");
  });

  it("the database decides again: limit reached meanwhile -> 403, duplicate -> 409 (after a passing test)", async () => {
    const { privileged } = await setup();
    privileged.connectImapEmailAccount.mockResolvedValueOnce({ outcome: "PLAN_LIMIT_REACHED", used: 250, limit: 250 });
    expect(codeOf(await create())).toBe("PLAN_LIMIT_REACHED");
    privileged.connectImapEmailAccount.mockResolvedValueOnce({ outcome: "DUPLICATE_ACCOUNT" });
    expect(codeOf(await create())).toBe("EMAIL_ACCOUNT_ALREADY_CONNECTED");
  });
});

describe("secrets never reach the logs", () => {
  it("passwords, usernames, hosts and encrypted values are absent from every log line (success and failures)", async () => {
    const lines: string[] = [];
    const base = await setup();
    base.privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });
    const app = await buildApp(base.deps, { logger: { level: "debug", stream: { write: (line: string) => void lines.push(line) } } });
    try {
      const send = (url: string, payload: unknown) =>
        app.inject({ method: "POST", url, headers: authHeaders(owner, ORG_A), payload: payload as object, remoteAddress: nextIp() });
      expect((await send("/api/email-accounts/imap/test", body)).statusCode).toBe(200);
      expect((await send("/api/email-accounts/imap", body)).statusCode).toBe(201);
      base.deps.imapProbeOpen = fakeServer({ failure: { authenticationFailed: true } }).open;
      await send("/api/email-accounts/imap/test", { ...body, username: "otro@empresa-correo.com" });
    } finally {
      await app.close();
    }
    const log = lines.join("\n");
    expect(log).toContain("imap.connection_test");
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(USERNAME);
    expect(log).not.toContain("otro@empresa-correo.com");
    expect(log).not.toContain("93.184.216.34");
    expect(log).not.toMatch(/v2\.[A-Za-z0-9_-]{16}\./);
  });
});

/* ------------------------------------------------------------------ *
 * Audit fixes B1 (attempts counted before DNS), B3 (one lockout key per
 * external mailbox) and M1 (organization lockout threshold).
 * ------------------------------------------------------------------ */

describe("B1: every attempt counts BEFORE the destination check", () => {
  const privateAnswer = (): ImapResolver => vi.fn(async () => [{ address: "10.1.2.3", family: 4 as const }]);

  it("repeated refused destinations hit the per-user limit; the 11th is not even resolved", async () => {
    const resolver = privateAnswer();
    const { server } = await setup({ resolver });
    for (let attempt = 0; attempt < IMAP_CONNECTION_LIMITS.perUser.max; attempt += 1) {
      expect(codeOf(await testConnection({ ...body, host: `h${attempt}.empresa-correo.com` }))).toBe("IMAP_ADDRESS_FORBIDDEN");
    }
    const limited = await testConnection({ ...body, host: "h-last.empresa-correo.com" });
    expect([limited.statusCode, codeOf(limited)]).toEqual([429, "IMAP_TEST_RATE_LIMITED"]);
    expect(resolver).toHaveBeenCalledTimes(IMAP_CONNECTION_LIMITS.perUser.max);
    expect(server.open).not.toHaveBeenCalled();
  });

  it("DNS failures from several users of one organization hit the per-organization limit (creation route too)", async () => {
    const extra = makeUser({ [ORG_A]: "ADMIN" });
    const resolver: ImapResolver = vi.fn(async () => Promise.reject(new Error("ENOTFOUND")));
    const server = fakeServer();
    ctx = await createTestApp({ users: [owner, admin, extra], config: { imapAccountsEnabled: true }, imapResolver: resolver, imapProbeOpen: server.open });
    ctx.repos.emailAccounts.list.mockResolvedValue([]);
    const users = [owner, admin, extra];
    for (let attempt = 0; attempt < IMAP_CONNECTION_LIMITS.perOrganization.max; attempt += 1) {
      const response = attempt % 2 ? await create(body, users[attempt % 3]) : await testConnection(body, users[attempt % 3]);
      expect(codeOf(response)).toBe("IMAP_DNS_FAILED");
    }
    expect(codeOf(await testConnection(body, extra))).toBe("IMAP_TEST_RATE_LIMITED");
    expect(resolver).toHaveBeenCalledTimes(IMAP_CONNECTION_LIMITS.perOrganization.max);
    expect(ctx.privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it("DNS, refused destination, TLS and timeout failures are NOT counted as refused logins (no lockout)", async () => {
    const extra = makeUser({ [ORG_A]: "ADMIN" });
    const server = fakeServer();
    ctx = await createTestApp({ users: [owner, admin, extra], config: { imapAccountsEnabled: true }, imapResolver: publicResolver(), imapProbeOpen: server.open });
    ctx.repos.emailAccounts.list.mockResolvedValue([]);
    const failures: Array<[ImapResolver, ImapProbeOpen, string]> = [
      [vi.fn(async () => Promise.reject(new Error("ENOTFOUND"))), server.open, "IMAP_DNS_FAILED"],
      [vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]), server.open, "IMAP_ADDRESS_FORBIDDEN"],
      [publicResolver(), fakeServer({ failure: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }).open, "IMAP_TLS_FAILED"],
      [publicResolver(), fakeServer({ failure: { code: "CONNECT_TIMEOUT" } }).open, "IMAP_TIMEOUT"]
    ];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const [resolver, open, expected] = failures[attempt % failures.length]!;
      ctx.deps.imapResolver = resolver;
      ctx.deps.imapProbeOpen = open;
      expect(codeOf(await testConnection(body, attempt % 2 ? admin : owner))).toBe(expected);
    }
    ctx.deps.imapResolver = publicResolver();
    ctx.deps.imapProbeOpen = server.open;
    expect((await testConnection(body, extra)).statusCode).toBe(200);
  });
});

describe("B3: one lockout key per external mailbox (case and port do not open new attempts)", () => {
  it("username case and 993 / 143 alternation share the mailbox lock: the server is contacted 10 times, then 429", async () => {
    const server = fakeServer({ failure: { authenticationFailed: true } });
    await setup({ server });
    const variants = ["ventas@empresa-correo.com", "Ventas@Empresa-Correo.com", " VENTAS@EMPRESA-CORREO.COM ", "vEnTaS@empresa-correo.com"];
    for (let attempt = 0; attempt < IMAP_LOGIN_LOCKOUT.mailbox.maxFailures; attempt += 1) {
      const transport = attempt % 2 ? { port: 143, security: "STARTTLS" } : { port: 993, security: "TLS" };
      expect(codeOf(await testConnection({ ...body, ...transport, username: variants[attempt % variants.length] }, attempt % 2 ? admin : owner))).toBe("IMAP_AUTH_FAILED");
    }
    const locked = await testConnection({ ...body, port: 143, security: "STARTTLS", username: "VENTAS@empresa-correo.com" }, owner);
    expect([locked.statusCode, codeOf(locked)]).toEqual([429, "IMAP_LOGIN_LOCKED"]);
    expect(server.open).toHaveBeenCalledTimes(IMAP_LOGIN_LOCKOUT.mailbox.maxFailures);
  });

  it("other accounts are not mixed: another username or another server is not locked; the username sent keeps its case", async () => {
    const { server } = await setup({ server: fakeServer({ failure: { authenticationFailed: true } }) });
    for (let attempt = 0; attempt < IMAP_LOGIN_LOCKOUT.mailbox.maxFailures; attempt += 1) await testConnection(body, attempt % 2 ? admin : owner);
    expect(codeOf(await testConnection(body, owner))).toBe("IMAP_LOGIN_LOCKED");

    const good = fakeServer();
    ctx!.deps.imapProbeOpen = good.open;
    expect((await testConnection({ ...body, emailAddress: "soporte@empresa-correo.com", username: "Soporte@Empresa-Correo.com" }, admin)).statusCode).toBe(200);
    expect((await testConnection({ ...body, host: "imap.otro-proveedor.com" }, owner)).statusCode).toBe(200);
    expect(good.open.mock.calls[0]?.[1]).toEqual({ username: "Soporte@Empresa-Correo.com", password: PASSWORD });
    expect(server.open).toHaveBeenCalledTimes(IMAP_LOGIN_LOCKOUT.mailbox.maxFailures);
  });

  it("imapMailboxLockKey: same key for case / spacing variants, distinct for another user, server or organization, never in clear", () => {
    const key = imapMailboxLockKey(ORG_A, "imap.hostinger.com", "ventas@empresa-correo.com");
    expect(imapMailboxLockKey(ORG_A, "IMAP.Hostinger.com", " Ventas@Empresa-Correo.COM ")).toBe(key);
    expect(imapMailboxLockKey(ORG_A, "imap.hostinger.com", "soporte@empresa-correo.com")).not.toBe(key);
    expect(imapMailboxLockKey(ORG_A, "imap.zoho.com", "ventas@empresa-correo.com")).not.toBe(key);
    expect(imapMailboxLockKey(ORG_B, "imap.hostinger.com", "ventas@empresa-correo.com")).not.toBe(key);
    expect(key).toMatch(/^mailbox:[0-9a-f]{64}$/);
  });
});

describe("M1: lockout thresholds (mailbox 10, organization 30, 15 min; portal unchanged)", () => {
  afterEach(() => vi.useRealTimers());

  /** Fake clock (Date only) BEFORE the app exists: the throttles read Date.now. */
  async function clockedSetup(users = [owner, admin, makeUser({ [ORG_A]: "ADMIN" }), makeUser({ [ORG_A]: "ADMIN" })]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const server = fakeServer({ failure: { authenticationFailed: true } });
    ctx = await createTestApp({ users, config: { imapAccountsEnabled: true }, imapResolver: publicResolver(), imapProbeOpen: server.open });
    ctx.repos.emailAccounts.list.mockResolvedValue([]);
    return { server, users };
  }
  const mailbox = (n: number) => ({ ...body, emailAddress: `buzon${n}@empresa-correo.com`, username: `buzon${n}@empresa-correo.com` });
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  it("1. the 10th refused login of one mailbox triggers its lock (the 9th does not)", async () => {
    const { server } = await clockedSetup();
    for (let attempt = 1; attempt <= 9; attempt += 1) await testConnection(body, attempt % 2 ? admin : owner);
    expect(codeOf(await testConnection(body, owner))).toBe("IMAP_AUTH_FAILED"); // 10th: still answered, now locked
    expect(codeOf(await testConnection(body, admin))).toBe("IMAP_LOGIN_LOCKED");
    expect(server.open).toHaveBeenCalledTimes(10);
  });

  it("2. ten refused logins spread over different mailboxes do NOT lock the organization", async () => {
    const { users } = await clockedSetup();
    for (let n = 0; n < 10; n += 1) expect(codeOf(await testConnection(mailbox(n), users[n % 4]))).toBe("IMAP_AUTH_FAILED");
    ctx!.deps.imapProbeOpen = fakeServer().open;
    expect((await testConnection(mailbox(99), owner)).statusCode).toBe(200);
  });

  it("3. the organization lock triggers at 30 refused logins within 15 min (29 still allow other mailboxes)", async () => {
    const { users } = await clockedSetup();
    // The per-organization attempt limit (20 / 10 min) spreads them over two attempt windows.
    for (let n = 0; n < 20; n += 1) expect(codeOf(await testConnection(mailbox(n), users[n % 4]))).toBe("IMAP_AUTH_FAILED");
    advance(IMAP_CONNECTION_LIMITS.perOrganization.windowMs + 1_000);
    for (let n = 20; n < 29; n += 1) expect(codeOf(await testConnection(mailbox(n), users[n % 4]))).toBe("IMAP_AUTH_FAILED");
    const wrong = ctx!.deps.imapProbeOpen!;
    ctx!.deps.imapProbeOpen = fakeServer().open;
    expect((await testConnection(mailbox(100), owner)).statusCode).toBe(200); // 29 failures: not locked
    ctx!.deps.imapProbeOpen = wrong;
    expect(codeOf(await testConnection(mailbox(29), admin))).toBe("IMAP_AUTH_FAILED"); // the 30th
    ctx!.deps.imapProbeOpen = fakeServer().open;
    const locked = await testConnection(mailbox(101), users[2]);
    expect([locked.statusCode, codeOf(locked)]).toEqual([429, "IMAP_LOGIN_LOCKED"]);
  });

  it("4. counters and locks expire: a failure window resets after 15 min, a lock ends after 15 min", async () => {
    await clockedSetup();
    for (let attempt = 0; attempt < 9; attempt += 1) await testConnection(body, attempt % 2 ? admin : owner);
    advance(IMAP_LOGIN_LOCKOUT.mailbox.failureWindowMs + 1_000);
    for (let attempt = 0; attempt < 9; attempt += 1) expect(codeOf(await testConnection(body, attempt % 2 ? admin : owner))).toBe("IMAP_AUTH_FAILED");
    expect(codeOf(await testConnection(body, owner))).toBe("IMAP_AUTH_FAILED"); // 10th of the new window
    expect(codeOf(await testConnection(body, admin))).toBe("IMAP_LOGIN_LOCKED");
    advance(IMAP_LOGIN_LOCKOUT.mailbox.lockMs - 2_000);
    expect(codeOf(await testConnection(body, owner))).toBe("IMAP_LOGIN_LOCKED");
    advance(3_000);
    ctx!.deps.imapProbeOpen = fakeServer().open;
    expect((await testConnection(body, owner)).statusCode).toBe(200);
  });

  it("5. organizations are isolated: one organization's mailbox and organization locks never affect another", async () => {
    const ownerB = makeUser({ [ORG_B]: "OWNER" });
    const adminB = makeUser({ [ORG_B]: "ADMIN" });
    await clockedSetup([owner, admin, ownerB, adminB]);
    for (let attempt = 0; attempt < 10; attempt += 1) await testConnection(body, attempt % 2 ? admin : owner);
    expect(codeOf(await testConnection(body, owner))).toBe("IMAP_LOGIN_LOCKED");
    // Same external mailbox from organization B: its own counters.
    expect(codeOf(await testConnection(body, ownerB, ORG_B))).toBe("IMAP_AUTH_FAILED");
    ctx!.deps.imapProbeOpen = fakeServer().open;
    expect((await testConnection(body, adminB, ORG_B)).statusCode).toBe(200);
  });

  it("createLoginThrottle: a policy is applied (local and Redis), the default stays the portal's", async () => {
    expect(LOGIN_LOCKOUT).toEqual({ maxFailures: 10, failureWindowMs: 15 * 60_000, lockMs: 15 * 60_000 });
    expect(IMAP_LOGIN_LOCKOUT.mailbox).toBe(LOGIN_LOCKOUT);
    expect(IMAP_LOGIN_LOCKOUT.organization).toEqual({ maxFailures: 30, failureWindowMs: 15 * 60_000, lockMs: 15 * 60_000 });

    let now = 1_000;
    const policy = { maxFailures: 3, failureWindowMs: 1_000, lockMs: 5_000 };
    const local = createLoginThrottle(undefined, { onFallback: () => undefined, now: () => now, policy });
    expect(await local.recordFailure("k")).toBe(0);
    expect(await local.recordFailure("k")).toBe(0);
    expect(await local.recordFailure("k")).toBe(5_000);
    expect(await local.lockedFor("k")).toBe(5_000);
    now += 5_001;
    expect(await local.lockedFor("k")).toBe(0);

    const redis = { eval: vi.fn(async () => 0) };
    await createLoginThrottle(redis, { prefix: "p:", onFallback: () => undefined, policy }).recordFailure("k");
    await createLoginThrottle(redis, { prefix: "p:", onFallback: () => undefined }).recordFailure("k");
    expect((redis.eval.mock.calls[0] as unknown[]).slice(-3)).toEqual([1_000, 3, 5_000]);
    expect((redis.eval.mock.calls[1] as unknown[]).slice(-3)).toEqual([LOGIN_LOCKOUT.failureWindowMs, LOGIN_LOCKOUT.maxFailures, LOGIN_LOCKOUT.lockMs]);
  });
});
