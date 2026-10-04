import { randomBytes } from "node:crypto";
import { createOAuthState, fetchWithTimeout } from "@emailbot/shared";
import { REALTIME_REVOKED } from "@emailbot/types";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/env.js";
import { authenticateHandshake, refreshSocketToken, revalidateSockets, type RevalidatableSocket } from "../infrastructure/realtime.js";
import { createResilientRateLimitStore, LocalCounters, type RateLimitRedis } from "../infrastructure/rate-limit-store.js";
import type { Repositories } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/* ------------------------------------------------------------------ production configuration */

describe("production configuration fail-fast", () => {
  const secrets = {
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    OAUTH_STATE_SECRET: "x".repeat(40)
  };
  const production = {
    ...secrets,
    NODE_ENV: "production",
    SUPABASE_URL: "https://project.supabase.co",
    API_PUBLIC_URL: "https://api.example.com",
    WEB_APP_URL: "https://app.example.com",
    CORS_ORIGINS: "https://app.example.com",
    REDIS_URL: "rediss://default:redis-password@redis.example.com:6380"
  };

  it("development without URLs still starts with local defaults", () => {
    const config = loadConfig({ ...secrets, SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(config.apiPublicUrl).toBe("http://localhost:3000");
    expect(config.webAppUrl).toBe("http://localhost:5173");
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.providerHttpTimeoutMs).toBe(20_000);
    expect(config.supabaseHttpTimeoutMs).toBe(60_000);
  });

  it("a complete production configuration is accepted", () => {
    const config = loadConfig(production);
    expect(config.webAppUrl).toBe("https://app.example.com");
    expect(config.redisUrl).toBe(production.REDIS_URL);
  });

  it.each(["API_PUBLIC_URL", "WEB_APP_URL", "REDIS_URL"])("production without %s fails", (name) => {
    const env: Record<string, string> = { ...production };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(`${name}: is required in production`));
  });

  it.each([
    ["API_PUBLIC_URL", "https://localhost:3000"],
    ["WEB_APP_URL", "https://127.0.0.1:5173"],
    ["SUPABASE_URL", "https://0.0.0.0:54321"],
    ["REDIS_URL", "redis://localhost:6379"],
    ["REDIS_URL", "redis://127.0.0.1:6379"],
    ["CORS_ORIGINS", "https://app.example.com,http://localhost:5173"],
    ["API_PUBLIC_URL", "https://api.localhost"]
  ])("production with a local %s (%s) fails", (name, value) => {
    expect(() => loadConfig({ ...production, [name]: value })).toThrow(new RegExp(name));
  });

  it.each([
    ["API_PUBLIC_URL", "http://api.example.com"],
    ["WEB_APP_URL", "http://app.example.com"],
    ["SUPABASE_URL", "http://project.supabase.co"],
    ["CORS_ORIGINS", "http://app.example.com"]
  ])("public URL %s must be HTTPS in production", (name, value) => {
    expect(() => loadConfig({ ...production, [name]: value })).toThrow(/must use https in production/);
  });

  it("an internal Redis without TLS on a private network is allowed (documented)", () => {
    expect(loadConfig({ ...production, REDIS_URL: "redis://redis.internal:6379" }).redisUrl).toBe("redis://redis.internal:6379");
  });

  it("partial or misplaced OAuth configuration fails instead of silently disabling the provider", () => {
    expect(() => loadConfig({ ...production, GOOGLE_CLIENT_ID: "id" })).toThrow(/GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must be set together/);
    const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    expect(() => loadConfig({ ...production, ...google, GOOGLE_REDIRECT_URI: "http://localhost:3000/api/oauth/gmail/callback" })).toThrow(
      /GOOGLE_REDIRECT_URI/
    );
    expect(() => loadConfig({ ...production, ...google, GOOGLE_REDIRECT_URI: "https://other.example.com/api/oauth/gmail/callback" })).toThrow(
      /same origin as API_PUBLIC_URL/
    );
    const ok = loadConfig({ ...production, ...google, GOOGLE_REDIRECT_URI: "https://api.example.com/api/oauth/gmail/callback" });
    expect(ok.google?.redirectUri).toBe("https://api.example.com/api/oauth/gmail/callback");
  });

  it("refuses the anon key as service role key", () => {
    expect(() => loadConfig({ ...production, SUPABASE_SERVICE_ROLE_KEY: "anon-key" })).toThrow(/must not be the anon key/);
  });

  it("errors never echo values (the Redis URL carries a password)", () => {
    try {
      loadConfig({ ...production, REDIS_URL: "redis://user:redis-password@localhost:6379" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("REDIS_URL");
      expect(String(error)).not.toContain("redis-password");
    }
  });
});

/* ------------------------------------------------------------------ outbound timeouts */

describe("OAuth callback with a hanging provider", () => {
  it("answers with connection_failed after the timeout instead of hanging the request", async () => {
    const google = { clientId: "cid", clientSecret: "csecret", redirectUri: "http://localhost:3000/api/oauth/gmail/callback" };
    const hanging = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
    ) as unknown as typeof fetch;
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, privileged, deps } = await createTestApp({ users: [owner], config: { google }, fetch: fetchWithTimeout(hanging, 50) });
    privileged.getMemberRole.mockResolvedValue("OWNER");

    const state = createOAuthState({ userId: owner.id, organizationId: ORG_A, provider: "GMAIL" }, deps.config.oauthStateSecret);
    const started = Date.now();
    const response = await app.inject({ method: "GET", url: `/api/oauth/gmail/callback?code=c&state=${encodeURIComponent(state)}` });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("reason=connection_failed");
    expect(privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ rate limiting without Redis */

/** In-memory stand-in for the Lua script (shared counters like Redis). */
function fakeRedis(): RateLimitRedis & { counters: Map<string, number>; down: boolean } {
  const counters = new Map<string, number>();
  const redis = {
    counters,
    down: false,
    async eval(_script: string, _keys: number, key: string | number, ttl: string | number) {
      if (redis.down) throw new Error("Connection is closed.");
      const next = (counters.get(String(key)) ?? 0) + 1;
      counters.set(String(key), next);
      return [next, Number(ttl)];
    }
  };
  return redis;
}

const ruleTest = {
  rule: { name: "x", conditions: [{ field: "subject", operator: "contains", value: "a" }] },
  email: { sender: "a@b.com", subject: "a" }
};

describe("rate limiting when Redis fails", () => {
  it("Redis available: counters are shared through Redis", async () => {
    const redis = fakeRedis();
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const first = await createTestApp({ users: [viewer], rateLimitRedis: redis });
    const second = await createTestApp({ users: [viewer], rateLimitRedis: redis });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const app = i % 2 === 0 ? first.app : second.app; // two API instances
      statuses.push((await app.inject({ method: "POST", url: "/api/rules/test", headers: authHeaders(viewer, ORG_A), payload: ruleTest })).statusCode);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(30);
    expect(statuses[30]).toBe(429);
    expect([...redis.counters.keys()].some((key) => key.startsWith("emailbot-rl:POST/api/rules/test-"))).toBe(true);
  });

  it("Redis down: a critical route keeps its limit (never unlimited)", async () => {
    const redis = fakeRedis();
    redis.down = true;
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app } = await createTestApp({ users: [viewer], rateLimitRedis: redis });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await app.inject({ method: "POST", url: "/api/rules/test", headers: authHeaders(viewer, ORG_A), payload: ruleTest })).statusCode);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it("Redis down: a non-critical route stays available and keeps the global limit", async () => {
    const redis = fakeRedis();
    redis.down = true;
    const { app } = await createTestApp({ config: { rateLimitMax: 3 }, rateLimitRedis: redis });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/api/me" })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("Redis recovering mid-window resumes shared counting", async () => {
    const redis = fakeRedis();
    const onFallback = vi.fn();
    const Store = createResilientRateLimitStore(redis, { prefix: "p:", onFallback });
    const store = new Store().child({ routeInfo: { method: "GET", url: "/x" } });
    const incr = () => new Promise<{ current: number }>((resolve) => store.incr("ip", (_error, result) => resolve(result!), 60_000));

    expect((await incr()).current).toBe(1);
    redis.down = true;
    expect((await incr()).current).toBe(1); // local fallback counter
    expect((await incr()).current).toBe(2);
    expect(onFallback).toHaveBeenCalledTimes(2);
    redis.down = false;
    expect((await incr()).current).toBe(2); // back on the shared counter
    expect(redis.counters.get("p:GET/x-ip")).toBe(2);
  });

  it("local counters reset after the window and stay bounded", () => {
    const counters = new LocalCounters();
    expect(counters.increment("a", 1000, 0).current).toBe(1);
    expect(counters.increment("a", 1000, 500).current).toBe(2);
    expect(counters.increment("a", 1000, 1000).current).toBe(1);
    for (let i = 0; i < 20_000; i++) counters.increment(`k${i}`, 1000, 0);
    expect(counters.increment("k19999", 1000, 0).current).toBe(2); // newest kept
    expect(counters.increment("k0", 1000, 0).current).toBe(1); // oldest evicted
  });
});

/* ------------------------------------------------------------------ realtime sessions */

function realtimeDeps(tokens: Record<string, string | null>, members: Record<string, string[]>) {
  const findRole = vi.fn(async (userId: string, organizationId: string) => (members[userId]?.includes(organizationId) ? "VIEWER" : null));
  return {
    findRole,
    deps: {
      identity: { verifyAccessToken: vi.fn(async (token: string) => (tokens[token] ? { id: tokens[token] as string, email: null } : null)) },
      repositories: () => ({ memberships: { findRole } }) as unknown as Repositories
    }
  };
}

function fakeSocket(data: RevalidatableSocket["data"]) {
  return {
    data,
    emit: vi.fn<(event: string, ...args: unknown[]) => unknown>(),
    disconnect: vi.fn<(close?: boolean) => unknown>()
  } satisfies RevalidatableSocket;
}

describe("realtime sessions", () => {
  const tokens = { "token-1": "user-1", "token-2": "user-1", "other-user": "user-2", expired: null };

  it("admits a valid token for an organization the user belongs to", async () => {
    const { deps } = realtimeDeps(tokens, { "user-1": [ORG_A] });
    expect(await authenticateHandshake({ token: "token-1", organizationId: ORG_A }, deps)).toEqual({
      ok: true,
      data: { userId: "user-1", token: "token-1", organizationId: ORG_A }
    });
  });

  it("rejects another tenant, malformed ids, missing or invalid tokens", async () => {
    const { deps } = realtimeDeps(tokens, { "user-1": [ORG_A] });
    expect(await authenticateHandshake({ token: "token-1", organizationId: ORG_B }, deps)).toEqual({ ok: false, error: "forbidden" });
    expect(await authenticateHandshake({ token: "token-1", organizationId: "not-a-uuid" }, deps)).toEqual({ ok: false, error: "unauthorized" });
    expect(await authenticateHandshake({ token: "expired", organizationId: ORG_A }, deps)).toEqual({ ok: false, error: "unauthorized" });
    expect(await authenticateHandshake({ organizationId: ORG_A }, deps)).toEqual({ ok: false, error: "unauthorized" });
    expect(await authenticateHandshake({ token: "x".repeat(9000), organizationId: ORG_A }, deps)).toEqual({ ok: false, error: "unauthorized" });
  });

  it("a renewed token replaces the handshake token, so revalidation survives its expiry", async () => {
    const { deps } = realtimeDeps({ ...tokens, "token-1": null }, { "user-1": [ORG_A] }); // handshake token has expired
    const socket = fakeSocket({ userId: "user-1", token: "token-1", organizationId: ORG_A });

    expect(await refreshSocketToken(socket, { token: "token-2" }, deps, 0)).toEqual({ ok: true });
    expect(socket.data.token).toBe("token-2");
    expect(await revalidateSockets([socket], deps)).toBe(0);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("without renewal an expired token is revoked with reason 'token' (client refreshes and reconnects)", async () => {
    const { deps } = realtimeDeps({ ...tokens, "token-1": null }, { "user-1": [ORG_A] });
    const socket = fakeSocket({ userId: "user-1", token: "token-1", organizationId: ORG_A });
    expect(await revalidateSockets([socket], deps)).toBe(1);
    expect(socket.emit).toHaveBeenCalledWith(REALTIME_REVOKED, { reason: "token" });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("losing the membership revokes with reason 'membership' (client does not reconnect)", async () => {
    const members: Record<string, string[]> = { "user-1": [ORG_A] };
    const { deps } = realtimeDeps(tokens, members);
    const socket = fakeSocket({ userId: "user-1", token: "token-1", organizationId: ORG_A });
    members["user-1"] = [];
    expect(await revalidateSockets([socket], deps)).toBe(1);
    expect(socket.emit).toHaveBeenCalledWith(REALTIME_REVOKED, { reason: "membership" });
  });

  it("a renewal with another user's token, or after losing access, revokes the socket", async () => {
    const { deps } = realtimeDeps(tokens, { "user-1": [ORG_A], "user-2": [ORG_A] });
    const hijack = fakeSocket({ userId: "user-1", token: "token-1", organizationId: ORG_A });
    expect(await refreshSocketToken(hijack, { token: "other-user" }, deps, 0)).toEqual({ ok: false });
    expect(hijack.data.token).toBe("token-1");
    expect(hijack.emit).toHaveBeenCalledWith(REALTIME_REVOKED, { reason: "token" });
    expect(hijack.disconnect).toHaveBeenCalledWith(true);

    const removed = realtimeDeps(tokens, { "user-1": [] });
    const socket = fakeSocket({ userId: "user-1", token: "token-1", organizationId: ORG_A });
    expect(await refreshSocketToken(socket, { token: "token-2" }, removed.deps, 0)).toEqual({ ok: false });
    expect(socket.emit).toHaveBeenCalledWith(REALTIME_REVOKED, { reason: "membership" });
  });

  it("ignores malformed and too frequent renewals", async () => {
    const { deps } = realtimeDeps(tokens, { "user-1": [ORG_A] });
    const socket = fakeSocket({ userId: "user-1", token: "token-1", organizationId: ORG_A });
    expect(await refreshSocketToken(socket, { token: 42 }, deps, 0)).toEqual({ ok: false });
    expect(await refreshSocketToken(socket, null, deps, 0)).toEqual({ ok: false });
    expect(await refreshSocketToken(socket, { token: "token-2" }, deps, 0)).toEqual({ ok: true });
    expect(await refreshSocketToken(socket, { token: "token-1" }, deps, 5_000)).toEqual({ ok: false });
    expect(socket.data.token).toBe("token-2");
    expect(await refreshSocketToken(socket, { token: "token-1" }, deps, 20_000)).toEqual({ ok: true });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ storage cleanup */

describe("attachment object cleanup on delete", () => {
  const EMAIL_ID = "55555555-5555-4555-8555-555555555555";
  const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
  const ATTACHMENT_ID = "88888888-8888-4888-8888-888888888888";
  const own = { id: ATTACHMENT_ID, emailId: EMAIL_ID, storageBucket: "email-attachments", storagePath: `${ORG_A}/${EMAIL_ID}/${ATTACHMENT_ID}/f.pdf` };
  const foreign = { ...own, id: "99999999-9999-4999-8999-999999999999", storagePath: `${ORG_B}/${EMAIL_ID}/x/f.pdf` };

  it("deleting an email removes only its objects at the expected location", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.attachments.listStoredObjects.mockResolvedValue([own, foreign]);
    repos.emails.remove.mockResolvedValue(true);

    const response = await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL_ID}`, headers: authHeaders(admin, ORG_A) });
    expect(response.statusCode).toBe(204);
    expect(repos.attachments.listStoredObjects).toHaveBeenCalledWith(ORG_A, { emailId: EMAIL_ID });
    expect(privileged.removeStorageObjects).toHaveBeenCalledWith("email-attachments", [own.storagePath]);
  });

  it("nothing is removed from Storage when the row was not deleted", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.attachments.listStoredObjects.mockResolvedValue([own]);
    repos.emails.remove.mockResolvedValue(false);
    expect((await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL_ID}`, headers: authHeaders(admin, ORG_A) })).statusCode).toBe(404);
    expect(privileged.removeStorageObjects).not.toHaveBeenCalled();
  });

  it("a Storage failure is reported but does not undo the user's deletion", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.attachments.listStoredObjects.mockResolvedValue([own]);
    repos.emails.remove.mockResolvedValue(true);
    privileged.removeStorageObjects.mockRejectedValue(new Error("Storage 503"));
    expect((await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL_ID}`, headers: authHeaders(admin, ORG_A) })).statusCode).toBe(204);
  });

  it("deleting a disconnected account removes the objects of its emails", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.emailAccounts.get.mockResolvedValue({ id: ACCOUNT_ID, status: "DISCONNECTED", provider: "GMAIL", emailAddress: "a@b.c" });
    repos.emailAccounts.remove.mockResolvedValue(true);
    repos.attachments.listStoredObjects.mockResolvedValue([own]);

    expect((await app.inject({ method: "DELETE", url: `/api/email-accounts/${ACCOUNT_ID}`, headers: authHeaders(admin, ORG_A) })).statusCode).toBe(204);
    expect(repos.attachments.listStoredObjects).toHaveBeenCalledWith(ORG_A, { accountId: ACCOUNT_ID });
    expect(privileged.removeStorageObjects).toHaveBeenCalledWith("email-attachments", [own.storagePath]);
  });

  it("a VIEWER cannot trigger any deletion or cleanup", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, privileged } = await createTestApp({ users: [viewer] });
    expect((await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL_ID}`, headers: authHeaders(viewer, ORG_A) })).statusCode).toBe(403);
    expect(privileged.removeStorageObjects).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ HTTP port (H.1) */

describe("HTTP port", () => {
  const local = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    OAUTH_STATE_SECRET: "x".repeat(40)
  };
  const production = {
    ...local,
    NODE_ENV: "production",
    SUPABASE_URL: "https://project.supabase.co",
    API_PUBLIC_URL: "https://api.example.com",
    WEB_APP_URL: "https://app.example.com",
    CORS_ORIGINS: "https://app.example.com",
    REDIS_URL: "rediss://default:pw@redis.example.com:6380"
  };

  it("local development defaults to 3000", () => {
    expect(loadConfig(local).port).toBe(3000);
  });

  it("API_PORT sets the port explicitly", () => {
    expect(loadConfig({ ...local, API_PORT: "4100" }).port).toBe(4100);
  });

  it("a platform-injected PORT is used (and wins over API_PORT)", () => {
    expect(loadConfig({ ...local, PORT: "8080" }).port).toBe(8080);
    expect(loadConfig({ ...local, PORT: "8080", API_PORT: "4100" }).port).toBe(8080);
  });

  it("production honours PORT and API_PORT the same way", () => {
    expect(loadConfig({ ...production, PORT: "10000" }).port).toBe(10000);
    expect(loadConfig({ ...production, API_PORT: "3001" }).port).toBe(3001);
    expect(loadConfig(production).port).toBe(3000);
  });

  it.each([["PORT", "0"], ["PORT", "70000"], ["PORT", "abc"], ["API_PORT", "-1"]])("rejects %s=%s", (name, value) => {
    expect(() => loadConfig({ ...local, [name]: value })).toThrow(new RegExp(name));
  });

  it("blank PORT is ignored (treated as unset)", () => {
    expect(loadConfig({ ...local, PORT: "", API_PORT: "4100" }).port).toBe(4100);
  });

  it("the health check answers on the effective port", async () => {
    const { app } = await createTestApp({ config: { port: 0 } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    await app.close();
  });
});

/* ------------------------------------------------------------------ encryption key (H.4) */

describe("TOKEN_ENCRYPTION_KEY in the API configuration", () => {
  const base = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    OAUTH_STATE_SECRET: "x".repeat(40)
  };

  it("accepts a valid key and refuses weak or malformed ones in every environment", () => {
    expect(loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") }).tokenEncryptionKey).toHaveLength(44);
    for (const env of ["development", "production"]) {
      expect(() => loadConfig({ ...base, NODE_ENV: env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") })).toThrow(/TOKEN_ENCRYPTION_KEY: is not random enough/);
      expect(() => loadConfig({ ...base, NODE_ENV: env, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex") })).toThrow(/TOKEN_ENCRYPTION_KEY: must be the standard base64/);
    }
  });
});
