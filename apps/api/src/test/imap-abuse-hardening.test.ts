import { randomBytes } from "node:crypto";
import type { ImapProbeClient, ImapProbeOpen, ImapResolver } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/env.js";
import type { RateLimitRedis } from "../infrastructure/rate-limit-store.js";
import {
  ACQUIRE_SLOT_SCRIPT,
  IMAP_CONNECTION_LIMITS,
  IMAP_LOGIN_LOCKOUT,
  imapLimitSecret,
  imapMailboxGlobalKey,
  imapMailboxLockKey,
  RESERVE_SCRIPT
} from "../modules/email-accounts/imap-connection.js";
import { FakeRedis } from "./fake-redis.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B, type TestUser } from "./helpers.js";

/*
 * IMAP E4: abuse-limit hardening.
 *   B6  HMAC keys (IMAP_RATE_LIMIT_SECRET), no unkeyed fallback
 *   B4  shared limits in Redis only: unavailable / slow Redis -> 503 before any connection
 *   M2  global rate of refused logins per external mailbox, across organizations
 *   B2  the disabled routes answer 503 before the body is parsed (auth / permission kept)
 * Redis is the in-memory FakeRedis (exact scripts, shared by several apps to model API
 * instances). It proves the limiter logic, not Redis itself nor real multi-process behaviour.
 */

const PASSWORD = "contraseña-de-aplicacion-123";
const USERNAME = "ventas@empresa-correo.com";
const HOST = "imap.hostinger.com";
const body = { emailAddress: USERNAME, host: HOST, port: 993, security: "TLS", username: USERNAME, password: PASSWORD };
const ORG_C = "33333333-3333-4333-8333-333333333333";
const ORG_D = "44444444-4444-4444-8444-444444444444";

const owner = makeUser({ [ORG_A]: "OWNER" });
const admin = makeUser({ [ORG_A]: "ADMIN" });
const viewer = makeUser({ [ORG_A]: "VIEWER" });
const ownerB = makeUser({ [ORG_B]: "OWNER" });
const ownerC = makeUser({ [ORG_C]: "OWNER" });
const ownerD = makeUser({ [ORG_D]: "OWNER" });
const everyone = [owner, admin, viewer, ownerB, ownerC, ownerD];

interface FakeServer {
  open: ImapProbeOpen & ReturnType<typeof vi.fn>;
}

function fakeServer(options: { failure?: unknown; hang?: Promise<void> } = {}): FakeServer {
  const open = vi.fn(async (_options: unknown, _login: unknown, onClient: (client: ImapProbeClient) => void) => {
    const client = {
      mailbox: false as unknown,
      async getMailboxLock(path: string) {
        client.mailbox = { path, readOnly: true, uidValidity: 7n, uidNext: 2 };
        return { path, release: () => undefined };
      },
      logout: vi.fn(async () => undefined),
      close: vi.fn(() => undefined)
    };
    onClient(client as never);
    if (options.hang) await options.hang;
    if (options.failure) throw options.failure;
    return client as never;
  });
  return { open: open as never };
}
const refusedLogin = () => fakeServer({ failure: { authenticationFailed: true } });
const publicResolver = (): ImapResolver => vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

type App = Awaited<ReturnType<typeof createTestApp>>;
const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.app.close();
});

async function newApp(options: { server?: FakeServer; redis?: RateLimitRedis | null; resolver?: ImapResolver; enabled?: boolean; secret?: string | null; users?: TestUser[] } = {}) {
  const app = await createTestApp({
    users: options.users ?? everyone,
    config: { imapAccountsEnabled: options.enabled ?? true, ...(options.secret !== undefined ? { imapRateLimitSecret: options.secret } : {}) },
    imapResolver: options.resolver ?? publicResolver(),
    imapProbeOpen: (options.server ?? fakeServer()).open,
    ...(options.redis === null ? {} : { rateLimitRedis: options.redis ?? new FakeRedis() })
  });
  app.repos.emailAccounts.list.mockResolvedValue([]);
  apps.push(app);
  return app;
}

let ip = 0;
const nextIp = () => `198.51.100.${(ip = (ip % 250) + 1)}`;
const post = (app: App, url: string, payload: unknown, user: TestUser = owner, organizationId = ORG_A, extra: Record<string, unknown> = {}) =>
  app.app.inject({ method: "POST", url, headers: authHeaders(user, organizationId), payload: payload as object, remoteAddress: nextIp(), ...extra });
const testConnection = (app: App, payload: unknown = body, user: TestUser = owner, organizationId = ORG_A) => post(app, "/api/email-accounts/imap/test", payload, user, organizationId);
const codeOf = (response: { json(): { error?: { code?: string } } }) => {
  try {
    return response.json().error?.code;
  } catch {
    return undefined;
  }
};
/** A FakeRedis that fails only for one script (a store that breaks half-way). */
const failingOn = (script: string, redis = new FakeRedis()): RateLimitRedis & { inner: FakeRedis } => ({
  inner: redis,
  eval: (text: string, n: number, ...args: Array<string | number>) => (text === script ? Promise.reject(new Error("READONLY fake")) : redis.eval(text, n, ...args))
});

/* ================================================================ B6 */

describe("B6: HMAC keys with IMAP_RATE_LIMIT_SECRET", () => {
  const secret = randomBytes(32);
  const other = randomBytes(32);

  it("same context + same secret -> same key; another secret -> another key; no clear data; canonical case", () => {
    const key = imapMailboxLockKey(secret, ORG_A, HOST, USERNAME);
    expect(imapMailboxLockKey(secret, ORG_A, " IMAP.Hostinger.COM ", "Ventas@Empresa-Correo.com")).toBe(key);
    expect(imapMailboxLockKey(other, ORG_A, HOST, USERNAME)).not.toBe(key);
    const global = imapMailboxGlobalKey(secret, HOST, USERNAME);
    expect(imapMailboxGlobalKey(secret, "imap.HOSTINGER.com", "VENTAS@empresa-correo.com")).toBe(global);
    expect(imapMailboxGlobalKey(other, HOST, USERNAME)).not.toBe(global);
    // Domain separation: the global key is not the mailbox key of some organization.
    expect(global.slice(global.indexOf(":") + 1)).not.toBe(key.slice(key.indexOf(":") + 1));
    for (const value of [key, global]) {
      expect(value).toMatch(/^(mailbox|target):[0-9a-f]{64}$/);
      expect(value).not.toMatch(/ventas|hostinger|empresa|correo/i);
    }
  });

  it("imapLimitSecret: absent / short / not base64 -> null (never an unkeyed fallback)", () => {
    expect(imapLimitSecret(undefined)).toBeNull();
    expect(imapLimitSecret(null)).toBeNull();
    expect(imapLimitSecret("")).toBeNull();
    expect(imapLimitSecret(randomBytes(16).toString("base64"))).toBeNull();
    expect(imapLimitSecret("not base64 !!")).toBeNull();
    expect(imapLimitSecret(randomBytes(32).toString("base64"))?.length).toBe(32);
  });

  it.each([
    ["absent", null],
    ["invalid", "short"]
  ])("secret %s: 503 PROVIDER_NOT_CONFIGURED before Redis, DNS or any connection", async (_label, value) => {
    const redis = new FakeRedis();
    const server = fakeServer();
    const resolver = publicResolver();
    const app = await newApp({ secret: value, redis, server, resolver });
    const response = await testConnection(app);
    expect([response.statusCode, codeOf(response)]).toEqual([503, "PROVIDER_NOT_CONFIGURED"]);
    expect(redis.calls.filter((call) => call.keys.some((key) => key.startsWith("emailbot-imap")))).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
  });

  it("the keys stored in Redis never contain the username, host or password", async () => {
    const redis = new FakeRedis();
    const app = await newApp({ redis, server: refusedLogin() });
    await testConnection(app);
    const imapKeys = redis.calls.flatMap((call) => call.keys).filter((key) => key.startsWith("emailbot-imap"));
    expect(imapKeys.length).toBeGreaterThan(4);
    expect(imapKeys.join(" ")).not.toMatch(/ventas|hostinger|empresa|correo|contraseña/i);
    const secretKey = imapLimitSecret(app.deps.config.imapRateLimitSecret)!;
    expect(imapKeys).toContain(`emailbot-imap-login:fail:${imapMailboxLockKey(secretKey, ORG_A, HOST, USERNAME)}`);
    expect(imapKeys).toContain(`emailbot-imap-${imapMailboxGlobalKey(secretKey, HOST, USERNAME)}`);
  });

  it("rotating the secret is NOT transparent: keys change, so existing mailbox locks and counters stop applying", async () => {
    const redis = new FakeRedis();
    const before = await newApp({ redis, server: refusedLogin(), secret: randomBytes(32).toString("base64") });
    for (let attempt = 0; attempt < IMAP_LOGIN_LOCKOUT.mailbox.maxFailures; attempt += 1) await testConnection(before, body, attempt % 2 ? admin : owner);
    expect(codeOf(await testConnection(before, body, owner))).toBe("IMAP_LOGIN_LOCKED");
    const rotated = await newApp({ redis, server: fakeServer(), secret: randomBytes(32).toString("base64") });
    // The organization lock (keyed by the organization id, not an HMAC) still counts these 10 failures (< 30).
    expect((await testConnection(rotated, body, ownerB, ORG_B)).statusCode).toBe(200);
    expect(codeOf(await testConnection(rotated, body, admin))).not.toBe("IMAP_LOGIN_LOCKED");
  });

  describe("configuration (IMAP_RATE_LIMIT_SECRET)", () => {
    const base = {
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      OAUTH_STATE_SECRET: "x".repeat(40)
    };
    it("optional: unset -> null (IMAP refuses); a valid one is kept", () => {
      expect(loadConfig(base).imapRateLimitSecret).toBeNull();
      const value = randomBytes(32).toString("base64");
      expect(loadConfig({ ...base, IMAP_RATE_LIMIT_SECRET: value }).imapRateLimitSecret).toBe(value);
    });

    it.each([
      ["too short", randomBytes(16).toString("base64")],
      ["not base64", "z".repeat(50) + "!"],
      ["a placeholder", Buffer.alloc(32, 0).toString("base64")]
    ])("%s: the API refuses to start, and the error never echoes the value", (_label, value) => {
      let message = "";
      try {
        loadConfig({ ...base, IMAP_RATE_LIMIT_SECRET: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/IMAP_RATE_LIMIT_SECRET/);
      expect(message).not.toContain(value);
    });

    it("reusing TOKEN_ENCRYPTION_KEY or OAUTH_STATE_SECRET is refused", () => {
      const reused = base.TOKEN_ENCRYPTION_KEY;
      expect(() => loadConfig({ ...base, IMAP_RATE_LIMIT_SECRET: reused })).toThrow(/IMAP_RATE_LIMIT_SECRET: must be its own secret/);
      const oauth = randomBytes(33).toString("base64");
      expect(() => loadConfig({ ...base, OAUTH_STATE_SECRET: oauth, IMAP_RATE_LIMIT_SECRET: oauth })).toThrow(/must be its own secret/);
    });
  });
});

/* ================================================================ B4 */

describe("B4: shared limits are Redis-only; an unavailable Redis refuses before any connection", () => {
  it("Redis up: every shared check goes through Redis (attempts, lockout, slot, global rate)", async () => {
    const redis = new FakeRedis();
    const app = await newApp({ redis });
    expect((await testConnection(app)).statusCode).toBe(200);
    expect([...new Set(redis.calls.filter((call) => call.keys.some((key) => key.startsWith("emailbot-imap"))).map((call) => call.script))].sort()).toEqual(
      ["ACQUIRE_SLOT", "INCR", "LOCK_TTL", "RELEASE", "RESERVE", "RESET"].sort()
    );
  });

  it.each([
    ["rejecting every call", () => Object.assign(new FakeRedis(), { mode: "down" as const })],
    ["absent (no Redis configured)", () => null]
  ])("Redis %s: 503 SERVICE_UNAVAILABLE, no DNS, no IMAP connection, nothing stored", async (_label, makeRedis) => {
    const server = fakeServer();
    const resolver = publicResolver();
    const app = await newApp({ redis: makeRedis(), server, resolver });
    for (const response of [await testConnection(app), await post(app, "/api/email-accounts/imap", body)]) {
      expect([response.statusCode, codeOf(response)]).toEqual([503, "SERVICE_UNAVAILABLE"]);
      expect(response.body).not.toMatch(/password|contraseña|refused the|ECONNREFUSED|fake-redis/i);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
    expect(app.privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it("Redis timing out: 503 after the store deadline, no IMAP connection", async () => {
    const redis = new FakeRedis();
    redis.mode = "slow";
    redis.slowOnly = (keys) => keys.some((key) => key.startsWith("emailbot-imap"));
    const server = fakeServer();
    const app = await newApp({ redis, server });
    const started = Date.now();
    const response = await testConnection(app);
    expect([response.statusCode, codeOf(response)]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(IMAP_CONNECTION_LIMITS.storeTimeoutMs - 50);
    expect(Date.now() - started).toBeLessThan(IMAP_CONNECTION_LIMITS.storeTimeoutMs * 3);
    expect(server.open).not.toHaveBeenCalled();
  });

  it.each([
    ["the concurrency slot", ACQUIRE_SLOT_SCRIPT],
    ["the global mailbox rate", RESERVE_SCRIPT]
  ])("Redis failing half-way (%s): 503, still no IMAP connection", async (_label, script) => {
    const server = fakeServer();
    const app = await newApp({ redis: failingOn(script), server });
    const response = await testConnection(app);
    expect([response.statusCode, codeOf(response)]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(server.open).not.toHaveBeenCalled();
  });

  it("two API instances share the counters: per-user attempts", async () => {
    const redis = new FakeRedis();
    const one = await newApp({ redis });
    const two = await newApp({ redis });
    for (let attempt = 0; attempt < IMAP_CONNECTION_LIMITS.perUser.max; attempt += 1) {
      expect((await testConnection(attempt % 2 ? two : one)).statusCode).toBe(200);
    }
    expect(codeOf(await testConnection(one))).toBe("IMAP_TEST_RATE_LIMITED");
    expect(codeOf(await testConnection(two))).toBe("IMAP_TEST_RATE_LIMITED");
  });

  it("an existing lock in Redis (set through another instance) is honoured without contacting the server", async () => {
    const redis = new FakeRedis();
    // Instances of one deployment share IMAP_RATE_LIMIT_SECRET (the mailbox keys are HMACs of it).
    const secret = randomBytes(32).toString("base64");
    const failing = refusedLogin();
    const one = await newApp({ redis, server: failing, secret });
    for (let attempt = 0; attempt < IMAP_LOGIN_LOCKOUT.mailbox.maxFailures; attempt += 1) await testConnection(one, body, attempt % 2 ? admin : owner);
    const good = fakeServer();
    const two = await newApp({ redis, server: good, secret });
    expect(codeOf(await testConnection(two, body, owner))).toBe("IMAP_LOGIN_LOCKED");
    expect(good.open).not.toHaveBeenCalled();
  });

  it("the per-organization concurrency slot is shared by instances", async () => {
    const redis = new FakeRedis();
    let finish!: () => void;
    const hang = new Promise<void>((resolve) => (finish = resolve));
    const slow = fakeServer({ hang });
    const one = await newApp({ redis, server: slow });
    const two = await newApp({ redis });
    const first = testConnection(one, body, owner);
    await vi.waitFor(() => expect(slow.open).toHaveBeenCalledTimes(1));
    const second = await testConnection(two, body, admin);
    expect([second.statusCode, codeOf(second)]).toEqual([429, "IMAP_TEST_BUSY"]);
    finish();
    expect((await first).statusCode).toBe(200);
    expect((await testConnection(two, body, admin)).statusCode).toBe(200);
  });

  it("the portal login keeps its per-instance fallback (unchanged): Redis down does not block it", async () => {
    const redis = Object.assign(new FakeRedis(), { mode: "down" as const });
    const app = await newApp({ redis });
    const response = await app.app.inject({ method: "POST", url: "/api/portal/session", payload: { accessId: "nope" }, remoteAddress: nextIp(), headers: { origin: "http://localhost:5173" } });
    expect(response.statusCode).not.toBe(503);
  });
});

/* ================================================================ M2 */

describe("M2: global rate of refused logins per external mailbox (all organizations)", () => {
  const orgs: Array<[TestUser, string]> = [[owner, ORG_A], [ownerB, ORG_B], [ownerC, ORG_C]];
  /** Each organization fails until its own mailbox lock (10): 3 organizations fill the global budget (30). */
  async function saturate(app: App, variants = false) {
    for (const [user, organizationId] of orgs) {
      for (let attempt = 0; attempt < IMAP_LOGIN_LOCKOUT.mailbox.maxFailures; attempt += 1) {
        const payload = variants
          ? { ...body, username: attempt % 2 ? "VENTAS@Empresa-Correo.com" : USERNAME, ...(attempt % 3 === 0 ? { port: 143, security: "STARTTLS" } : {}) }
          : body;
        expect(codeOf(await testConnection(app, payload, user, organizationId))).toBe("IMAP_AUTH_FAILED");
      }
    }
  }

  it("1+4. the same server and user share the budget across organizations: a 4th organization is refused without any connection", async () => {
    const server = refusedLogin();
    const app = await newApp({ server });
    await saturate(app);
    expect(server.open).toHaveBeenCalledTimes(IMAP_CONNECTION_LIMITS.perMailboxGlobal.maxRefusedLogins);
    const fresh = fakeServer();
    app.deps.imapProbeOpen = fresh.open;
    const refused = await testConnection(app, body, ownerD, ORG_D);
    expect([refused.statusCode, codeOf(refused)]).toEqual([429, "IMAP_TEST_RATE_LIMITED"]);
    expect(refused.body).not.toMatch(/ventas|hostinger|other organization/i);
    expect(fresh.open).not.toHaveBeenCalled();
  });

  it("2. letter case and the 993 / 143 alternation do not escape the global budget", async () => {
    const app = await newApp({ server: refusedLogin() });
    await saturate(app, true);
    app.deps.imapProbeOpen = fakeServer().open;
    expect(codeOf(await testConnection(app, { ...body, port: 143, security: "STARTTLS", username: "Ventas@EMPRESA-correo.com" }, ownerD, ORG_D))).toBe("IMAP_TEST_RATE_LIMITED");
  });

  it("3. another server or another username does not share the counter", async () => {
    const app = await newApp({ server: refusedLogin() });
    await saturate(app);
    app.deps.imapProbeOpen = fakeServer().open;
    expect((await testConnection(app, { ...body, emailAddress: "soporte@empresa-correo.com", username: "soporte@empresa-correo.com" }, ownerD, ORG_D)).statusCode).toBe(200);
    expect((await testConnection(app, { ...body, host: "imap.otro-proveedor.com" }, ownerD, ORG_D)).statusCode).toBe(200);
  });

  it("5. one organization alone cannot exhaust the global budget (its own lock stops it at 10)", async () => {
    const server = refusedLogin();
    const app = await newApp({ server });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const payload = { ...body, username: attempt % 2 ? "VENTAS@empresa-correo.com" : USERNAME, ...(attempt % 2 ? { port: 143, security: "STARTTLS" } : {}) };
      await testConnection(app, payload, attempt % 2 ? admin : owner, ORG_A);
    }
    expect(server.open).toHaveBeenCalledTimes(IMAP_LOGIN_LOCKOUT.mailbox.maxFailures);
    app.deps.imapProbeOpen = fakeServer().open;
    expect((await testConnection(app, body, ownerB, ORG_B)).statusCode).toBe(200);
  });

  it("successful logins and DNS / TLS / timeout failures do not consume the global budget", async () => {
    const app = await newApp();
    const users: Array<[TestUser, string]> = [[owner, ORG_A], [admin, ORG_A], [ownerB, ORG_B], [ownerC, ORG_C], [ownerD, ORG_D]];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const [user, organizationId] = users[attempt % users.length]!;
      app.deps.imapProbeOpen = attempt % 4 === 1 ? fakeServer({ failure: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }).open : attempt % 4 === 2 ? fakeServer({ failure: { code: "CONNECT_TIMEOUT" } }).open : fakeServer().open;
      expect(codeOf(await testConnection(app, body, user, organizationId))).not.toBe("IMAP_TEST_RATE_LIMITED");
    }
  });

  it("6. the global window expires (a rate, not a lock)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const app = await newApp({ server: refusedLogin() });
    await saturate(app);
    app.deps.imapProbeOpen = fakeServer().open;
    expect(codeOf(await testConnection(app, body, ownerD, ORG_D))).toBe("IMAP_TEST_RATE_LIMITED");
    vi.setSystemTime(new Date(Date.now() + IMAP_CONNECTION_LIMITS.perMailboxGlobal.windowMs + 1_000));
    expect((await testConnection(app, body, ownerD, ORG_D)).statusCode).toBe(200);
  });

  it("7. Redis unavailable at the global step: 503, never a bypass", async () => {
    const server = fakeServer();
    const app = await newApp({ redis: failingOn(RESERVE_SCRIPT), server });
    expect(codeOf(await testConnection(app, body, ownerD, ORG_D))).toBe("SERVICE_UNAVAILABLE");
    expect(server.open).not.toHaveBeenCalled();
  });

  it("8. logs and answers never reveal the HMAC key nor the username", async () => {
    const lines: string[] = [];
    const base = await newApp({ server: refusedLogin() });
    const app = await buildApp(base.deps, { logger: { level: "debug", stream: { write: (line: string) => void lines.push(line) } } });
    try {
      const send = (user: TestUser, organizationId: string) =>
        app.inject({ method: "POST", url: "/api/email-accounts/imap/test", headers: authHeaders(user, organizationId), payload: body, remoteAddress: nextIp() });
      for (const [user, organizationId] of orgs) for (let attempt = 0; attempt < 10; attempt += 1) await send(user, organizationId);
      const refused = await send(ownerD, ORG_D);
      expect(codeOf(refused)).toBe("IMAP_TEST_RATE_LIMITED");
      const secretKey = imapLimitSecret(base.deps.config.imapRateLimitSecret)!;
      const hex = imapMailboxGlobalKey(secretKey, HOST, USERNAME).split(":")[1]!;
      const everything = lines.join("\n") + refused.body;
      expect(lines.join("\n")).toContain("GLOBAL_RATE_LIMITED");
      expect(everything).not.toContain(hex);
      expect(everything).not.toContain(base.deps.config.imapRateLimitSecret!);
      expect(everything).not.toMatch(/ventas@|hostinger|contraseña/i);
    } finally {
      await app.close();
    }
  });
});

/* ================================================================ B2 */

describe("B2: disabled IMAP routes answer before the body is read or parsed", () => {
  const routes = ["/api/email-accounts/imap/test", "/api/email-accounts/imap"];

  it.each(routes)("%s: valid JSON, malformed JSON, an oversized body and text/plain all get 503; nothing else happens", async (url) => {
    const redis = new FakeRedis();
    const server = fakeServer();
    const resolver = publicResolver();
    const app = await newApp({ enabled: false, redis, server, resolver });
    const box = app.deps.secretBox;
    const spies = ["encrypt", "decrypt", "encryptBound", "decryptBound"].map((method) => vi.spyOn(box, method as never));
    const headers = { ...authHeaders(owner, ORG_A), "content-type": "application/json" };
    const answers = [
      await post(app, url, body),
      await app.app.inject({ method: "POST", url, headers, payload: '{"password": "abc"', remoteAddress: nextIp() }),
      await app.app.inject({ method: "POST", url, headers, payload: JSON.stringify({ password: "x".repeat(1_100_000) }), remoteAddress: nextIp() }),
      await app.app.inject({ method: "POST", url, headers: { ...authHeaders(owner, ORG_A), "content-type": "text/plain" }, payload: "hello", remoteAddress: nextIp() })
    ];
    for (const response of answers) expect([response.statusCode, codeOf(response)]).toEqual([503, "IMAP_NOT_AVAILABLE"]);
    expect(resolver).not.toHaveBeenCalled();
    expect(server.open).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(app.privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(app.privileged.insertAuditLog).not.toHaveBeenCalled();
    expect(app.queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(app.queue.requestAccountSync).not.toHaveBeenCalled();
    expect(app.repos.emailAccounts.list).not.toHaveBeenCalled();
    expect(redis.calls.filter((call) => call.keys.some((key) => key.startsWith("emailbot-imap")))).toEqual([]);
  });

  it.each(routes)("%s: anonymous 401, VIEWER 403, another organization's user 403 (unchanged, even with a malformed body)", async (url) => {
    const app = await newApp({ enabled: false });
    const malformed = '{"password":';
    const anonymous = await app.app.inject({ method: "POST", url, headers: { "x-organization-id": ORG_A, "content-type": "application/json" }, payload: malformed, remoteAddress: nextIp() });
    expect(anonymous.statusCode).toBe(401);
    const asViewer = await app.app.inject({ method: "POST", url, headers: { ...authHeaders(viewer, ORG_A), "content-type": "application/json" }, payload: malformed, remoteAddress: nextIp() });
    expect(asViewer.statusCode).toBe(403);
    expect((await post(app, url, body, ownerB, ORG_A)).statusCode).toBe(403);
  });

  it("the per-IP route limit still runs first", async () => {
    const app = await newApp({ enabled: false });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await app.app.inject({ method: "POST", url: "/api/email-accounts/imap/test", headers: { "x-organization-id": ORG_A }, payload: body, remoteAddress: "203.0.113.77" })).statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("when enabled the body is parsed as before (malformed JSON -> 400 after authentication)", async () => {
    const app = await newApp();
    const response = await app.app.inject({ method: "POST", url: "/api/email-accounts/imap/test", headers: { ...authHeaders(owner, ORG_A), "content-type": "application/json" }, payload: '{"password":', remoteAddress: nextIp() });
    expect(response.statusCode).toBe(400);
  });

  it("other routes keep their order: a malformed body on PATCH /email-accounts/:id is still a 400 from the parser", async () => {
    const app = await newApp({ enabled: false });
    const response = await app.app.inject({
      method: "PATCH",
      url: "/api/email-accounts/11111111-2222-4333-8444-555555555555",
      headers: { ...authHeaders(owner, ORG_A), "content-type": "application/json" },
      payload: '{"status":',
      remoteAddress: nextIp()
    });
    expect([response.statusCode, codeOf(response)]).toEqual([400, "FST_ERR_CTP_INVALID_JSON_BODY"]);
  });
});
