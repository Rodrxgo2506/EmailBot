import { randomUUID } from "node:crypto";
import type { Customer, CustomerAccessCredential, OrganizationStatus } from "@emailbot/types";
import { maskAccessId, normalizeAccessId } from "@emailbot/validation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoginThrottle, LOGIN_LOCKOUT } from "../infrastructure/login-throttle.js";
import type { RateLimitRedis } from "../infrastructure/rate-limit-store.js";
import { AccessIdHasher, generateAccessSecret, generateSessionToken, hashSessionToken, isSessionToken } from "../lib/customer-access.js";
import { PORTAL_SESSION_COOKIE, readCookie } from "../modules/portal/session.js";
import type { CustomerAccessIssue, PortalLoginResult, PortalSessionContext } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/*
 * EmailBot V2 phase 4: customer Access ID administration + portal sessions.
 * The fake below mirrors the SQL functions (portal.create_session,
 * portal.validate_session, portal.end_session, public.issue_customer_access,
 * public.revoke_customer_access, public.revoke_customer_sessions); the real
 * ones are covered by packages/database and the local integration.
 */

const CUSTOMER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CUSTOMER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

interface FakeCredential {
  id: string;
  organizationId: string;
  customerId: string;
  secretHash: string;
  last4: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string | null;
}

interface FakeSession {
  id: string;
  organizationId: string;
  customerId: string;
  credentialId: string;
  tokenHash: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedReason: string | null;
}

function customer(id: string, organizationId: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id,
    organizationId,
    displayName: id === CUSTOMER_A ? "Juan" : "Pedro",
    status: "ACTIVE",
    externalRef: null,
    notes: null,
    createdBy: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides
  };
}

async function setup(options: { rateLimitRedis?: RateLimitRedis; logLines?: string[] } = {}) {
  const ownerA = makeUser({ [ORG_A]: "OWNER" });
  const operatorA = makeUser({ [ORG_A]: "OPERATOR" });
  const viewerA = makeUser({ [ORG_A]: "VIEWER" });
  const ownerB = makeUser({ [ORG_B]: "OWNER" });
  const context = await createTestApp({
    users: [ownerA, operatorA, viewerA, ownerB],
    ...(options.rateLimitRedis ? { rateLimitRedis: options.rateLimitRedis } : {})
  });
  const { repos, privileged } = context;

  const customers = new Map<string, Customer>([
    [CUSTOMER_A, customer(CUSTOMER_A, ORG_A)],
    [CUSTOMER_B, customer(CUSTOMER_B, ORG_B)]
  ]);
  const organizationStatus = new Map<string, OrganizationStatus>([
    [ORG_A, "ACTIVE"],
    [ORG_B, "ACTIVE"]
  ]);
  const credentials: FakeCredential[] = [];
  const sessions: FakeSession[] = [];
  const now = () => Date.now();

  const revokeSessions = (customerId: string, reason: string, sessionId: string | null = null) => {
    let count = 0;
    for (const session of sessions) {
      if (session.customerId === customerId && session.revokedReason === null && (sessionId === null || session.id === sessionId)) {
        session.revokedReason = reason;
        count++;
      }
    }
    return count;
  };
  const organizationOf = (customerId: string) => customers.get(customerId)?.organizationId as string;
  const toPublic = (credential: FakeCredential): CustomerAccessCredential => ({
    id: credential.id,
    customerId: credential.customerId,
    displayPrefix: "SP",
    last4: credential.last4,
    maskedAccessId: maskAccessId("SP", credential.last4),
    status: credential.status,
    expiresAt: credential.expiresAt,
    createdBy: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    revokedReason: null
  });

  repos.customers.get.mockImplementation(async (organizationId: string, id: string) => {
    const found = customers.get(id);
    return found && found.organizationId === organizationId ? found : null;
  });
  repos.customerAccess.issue.mockImplementation(async (customerId: string, input: CustomerAccessIssue) => {
    const previous = credentials.find((credential) => credential.customerId === customerId && credential.status === "ACTIVE");
    if (previous) previous.status = "REVOKED";
    const revoked = revokeSessions(customerId, "CREDENTIAL_REGENERATED");
    const created: FakeCredential = {
      id: randomUUID(),
      organizationId: organizationOf(customerId),
      customerId,
      secretHash: input.secretHash,
      last4: input.last4,
      status: "ACTIVE",
      expiresAt: input.expiresAt
    };
    credentials.push(created);
    return { credential: toPublic(created), previousCredentialId: previous?.id ?? null, revokedSessions: revoked };
  });
  repos.customerAccess.getActive.mockImplementation(async (_organizationId: string, customerId: string) => {
    const active = credentials.find((credential) => credential.customerId === customerId && credential.status === "ACTIVE");
    return active ? toPublic(active) : null;
  });
  repos.customerAccess.revoke.mockImplementation(async (customerId: string) => {
    const active = credentials.find((credential) => credential.customerId === customerId && credential.status === "ACTIVE");
    if (active) active.status = "REVOKED";
    return { credentialId: active?.id ?? null, revokedSessions: revokeSessions(customerId, "CREDENTIAL_REVOKED") };
  });
  repos.customerAccess.revokeSessions.mockImplementation(async (customerId: string, sessionId: string | null) =>
    revokeSessions(customerId, sessionId ? "REVOKED" : "REVOKED_ALL", sessionId)
  );
  repos.customerAccess.listSessions.mockImplementation(async (_organizationId: string, customerId: string) =>
    sessions.filter((session) => session.customerId === customerId).map((session) => ({ id: session.id, revokedReason: session.revokedReason }))
  );

  privileged.createPortalSession.mockImplementation(
    async (input: { secretHash: string; tokenHash: string }): Promise<PortalLoginResult> => {
      const credential = credentials.find((candidate) => candidate.secretHash === input.secretHash);
      if (!credential) return { outcome: "INVALID", organizationId: null, customerId: null };
      const known = { organizationId: credential.organizationId, customerId: credential.customerId };
      if (credential.status !== "ACTIVE") return { outcome: "REVOKED", ...known };
      if (credential.expiresAt && Date.parse(credential.expiresAt) <= now()) return { outcome: "EXPIRED", ...known };
      if (organizationStatus.get(credential.organizationId) !== "ACTIVE") return { outcome: "ORGANIZATION_INACTIVE", ...known };
      const owner = customers.get(credential.customerId) as Customer;
      if (owner.status !== "ACTIVE") return { outcome: "CUSTOMER_INACTIVE", ...known };
      const session: FakeSession = {
        id: randomUUID(),
        ...known,
        credentialId: credential.id,
        tokenHash: input.tokenHash,
        idleExpiresAt: now() + 7 * 86_400_000,
        absoluteExpiresAt: now() + 30 * 86_400_000,
        revokedReason: null
      };
      sessions.push(session);
      return {
        outcome: "OK",
        ...known,
        sessionId: session.id,
        displayName: owner.displayName,
        idleExpiresAt: new Date(session.idleExpiresAt).toISOString(),
        absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString()
      };
    }
  );
  privileged.validatePortalSession.mockImplementation(async (tokenHash: string): Promise<PortalSessionContext | null> => {
    const session = sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session || session.revokedReason !== null || session.idleExpiresAt <= now() || session.absoluteExpiresAt <= now()) return null;
    const credential = credentials.find((candidate) => candidate.id === session.credentialId);
    const owner = customers.get(session.customerId) as Customer;
    if (credential?.status !== "ACTIVE" || owner.status !== "ACTIVE" || organizationStatus.get(session.organizationId) !== "ACTIVE") return null;
    return {
      sessionId: session.id,
      organizationId: session.organizationId,
      customerId: session.customerId,
      profile: {
        customer: { displayName: owner.displayName, status: owner.status },
        organization: { name: session.organizationId === ORG_A ? "Org A" : "Org B" },
        bots: [],
        session: { idleExpiresAt: new Date(session.idleExpiresAt).toISOString(), absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString() }
      }
    };
  });
  privileged.endPortalSession.mockImplementation(async (tokenHash: string) => {
    const session = sessions.find((candidate) => candidate.tokenHash === tokenHash && candidate.revokedReason === null);
    if (!session) return null;
    session.revokedReason = "LOGOUT";
    return { sessionId: session.id, organizationId: session.organizationId, customerId: session.customerId };
  });

  let app = context.app;
  if (options.logLines) {
    const { buildApp } = await import("../app.js");
    const lines = options.logLines;
    app = await buildApp(context.deps, { logger: { level: "debug", stream: { write: (line: string) => lines.push(line) } } });
  }

  const generate = async (user = ownerA, customerId = CUSTOMER_A, organizationId = ORG_A, body: unknown = {}) =>
    app.inject({ method: "POST", url: `/api/customers/${customerId}/access`, headers: authHeaders(user, organizationId), payload: body as object });
  const accessIdFor = async (customerId = CUSTOMER_A, organizationId = ORG_A, user = organizationId === ORG_A ? ownerA : ownerB) =>
    (await generate(user, customerId, organizationId)).json().accessId as string;
  const login = (accessId: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/portal/session", headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify({ accessId }) });
  const cookieOf = (response: Awaited<ReturnType<typeof login>>) => {
    const header = response.headers["set-cookie"];
    return String(Array.isArray(header) ? header[0] : header ?? "");
  };
  const sessionCookieOf = (response: Awaited<ReturnType<typeof login>>) => cookieOf(response).split(";")[0] as string;
  const me = (cookie: string) => app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie } });

  return {
    app,
    context,
    repos,
    privileged,
    users: { ownerA, operatorA, viewerA, ownerB },
    customers,
    organizationStatus,
    credentials,
    sessions,
    generate,
    accessIdFor,
    login,
    cookieOf,
    sessionCookieOf,
    me
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Access ID primitives", () => {
  it("generates 12 Crockford characters (60 bits) that normalize to themselves", () => {
    const secrets = new Set(Array.from({ length: 200 }, generateAccessSecret));
    expect(secrets.size).toBe(200);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(normalizeAccessId(`SP-${secret}`)).toBe(secret);
    }
  });

  it("HMAC with a key derived (HKDF) from TOKEN_ENCRYPTION_KEY: deterministic per key, different across keys", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const other = Buffer.alloc(32, 9).toString("base64");
    const hasher = new AccessIdHasher(key);
    expect(hasher.hash("7KQ9X82MP4Z7")).toMatch(/^[0-9a-f]{64}$/);
    expect(hasher.hash("7KQ9X82MP4Z7")).toBe(new AccessIdHasher(key).hash("7KQ9X82MP4Z7"));
    expect(hasher.hash("7KQ9X82MP4Z7")).not.toBe(new AccessIdHasher(other).hash("7KQ9X82MP4Z7"));
    expect(JSON.stringify({ hasher })).not.toContain(key);
  });

  it("session tokens: 256 bits, base64url, stored as SHA-256", () => {
    const token = generateSessionToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(isSessionToken(token)).toBe(true);
    expect(isSessionToken(`${token}x`)).toBe(false);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("admin: Access ID generation, regeneration and revocation", () => {
  it("generates an Access ID shown once; afterwards only the masked form exists", async () => {
    const { generate, app, users, credentials } = await setup();
    const response = await generate();
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { accessId, credential, regenerated } = response.json();
    expect(accessId).toMatch(/^SP-[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(regenerated).toBe(false);
    expect(credential.maskedAccessId).toBe(`SP-••••••••${accessId.slice(-4)}`);
    expect(credentials[0]?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(credentials[0]?.secretHash).not.toContain(accessId.slice(3));

    const read = await app.inject({ method: "GET", url: `/api/customers/${CUSTOMER_A}/access`, headers: authHeaders(users.operatorA, ORG_A) });
    expect(read.statusCode).toBe(200);
    expect(JSON.stringify(read.json())).not.toContain(accessId.slice(3));
    expect(JSON.stringify(read.json())).not.toMatch(/secret|hash/i);
    expect(read.json().credential).toMatchObject({ last4: accessId.slice(-4), status: "ACTIVE" });
  });

  it("regeneration revokes the previous Access ID and every session (audited)", async () => {
    const { accessIdFor, generate, login, sessionCookieOf, me, context } = await setup();
    const first = await accessIdFor();
    const cookie = sessionCookieOf(await login(first));
    expect((await me(cookie)).statusCode).toBe(200);

    const again = await generate();
    expect(again.json()).toMatchObject({ regenerated: true, revokedSessions: 1 });
    expect((await me(cookie)).statusCode).toBe(401);
    expect((await login(first)).statusCode).toBe(401);
    expect((await login(again.json().accessId)).statusCode).toBe(200);

    const events = context.privileged.insertAuditLog.mock.calls.map(([entry]) => entry.metadata?.event);
    expect(events).toEqual(expect.arrayContaining(["customer.access.generated", "customer.access.regenerated"]));
  });

  it("revocation of the Access ID ends its sessions; revoking sessions one by one or all at once", async () => {
    const { accessIdFor, app, login, sessionCookieOf, me, users, sessions } = await setup();
    const accessId = await accessIdFor();
    const first = sessionCookieOf(await login(accessId));
    const second = sessionCookieOf(await login(accessId));
    const third = sessionCookieOf(await login(accessId));
    const headers = authHeaders(users.operatorA, ORG_A);

    const one = await app.inject({ method: "DELETE", url: `/api/customers/${CUSTOMER_A}/sessions/${sessions[0]?.id}`, headers });
    expect(one.json()).toEqual({ revokedSessions: 1 });
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);

    const all = await app.inject({ method: "DELETE", url: `/api/customers/${CUSTOMER_A}/sessions`, headers });
    expect(all.json()).toEqual({ revokedSessions: 2 });
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(third)).statusCode).toBe(401);

    const fresh = sessionCookieOf(await login(accessId));
    const revoked = await app.inject({ method: "DELETE", url: `/api/customers/${CUSTOMER_A}/access`, headers });
    expect(revoked.json()).toEqual({ revoked: true, revokedSessions: 1 });
    expect((await me(fresh)).statusCode).toBe(401);
    expect((await login(accessId)).statusCode).toBe(401);
  });

  it("VIEWER cannot generate, read, revoke or list (customer-access:manage)", async () => {
    const { app, users, repos } = await setup();
    const headers = authHeaders(users.viewerA, ORG_A);
    for (const [method, url] of [
      ["POST", `/api/customers/${CUSTOMER_A}/access`],
      ["GET", `/api/customers/${CUSTOMER_A}/access`],
      ["DELETE", `/api/customers/${CUSTOMER_A}/access`],
      ["GET", `/api/customers/${CUSTOMER_A}/sessions`],
      ["DELETE", `/api/customers/${CUSTOMER_A}/sessions`]
    ] as const) {
      const response = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.json().error.code, `${method} ${url}`).toBe("INSUFFICIENT_ROLE");
    }
    expect(repos.customerAccess.issue).not.toHaveBeenCalled();
  });

  it("IDOR: a customer of another organization is 404 for every access endpoint", async () => {
    const { app, users, repos } = await setup();
    const headers = authHeaders(users.ownerA, ORG_A);
    for (const [method, url] of [
      ["POST", `/api/customers/${CUSTOMER_B}/access`],
      ["GET", `/api/customers/${CUSTOMER_B}/access`],
      ["DELETE", `/api/customers/${CUSTOMER_B}/access`],
      ["GET", `/api/customers/${CUSTOMER_B}/sessions`],
      ["DELETE", `/api/customers/${CUSTOMER_B}/sessions`],
      ["DELETE", `/api/customers/${CUSTOMER_B}/sessions/${randomUUID()}`]
    ] as const) {
      const response = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: {} } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(repos.customerAccess.issue).not.toHaveBeenCalled();
    expect(repos.customerAccess.revoke).not.toHaveBeenCalled();
    expect(repos.customerAccess.revokeSessions).not.toHaveBeenCalled();
  });

  it("the body cannot carry secrets, hashes or another organization", async () => {
    const { generate } = await setup();
    for (const body of [{ secretHash: "f".repeat(64) }, { organizationId: ORG_B }, { accessId: "SP-7KQ9X82MP4Z7" }, { expiresAt: "soon" }]) {
      expect((await generate(undefined, undefined, undefined, body)).statusCode).toBe(400);
    }
  });
});

describe("portal login", () => {
  it("valid login: __Host- cookie (httpOnly, Secure, SameSite=Strict, Path=/), minimal body, token never in the body", async () => {
    const { accessIdFor, login, cookieOf } = await setup();
    const accessId = await accessIdFor();
    const response = await login(`  ${accessId.toLowerCase().replace("-", " ")} `);

    expect(response.statusCode).toBe(200);
    const cookie = cookieOf(response);
    expect(cookie).toMatch(new RegExp(`^${PORTAL_SESSION_COOKIE}=[A-Za-z0-9_-]{43}; `));
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age="]) expect(cookie).toContain(attribute);
    expect(cookie).not.toMatch(/Domain=/i);
    const token = readCookie(cookie.split(";")[0], PORTAL_SESSION_COOKIE) as string;
    expect(response.body).not.toContain(token);
    expect(Object.keys(response.json()).sort()).toEqual(["customer", "session"]);
    expect(response.json().customer).toEqual({ displayName: "Juan" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("every failure is the same generic 401: unknown, revoked, expired, customer suspended, organization suspended, malformed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { accessIdFor, login, generate, customers, organizationStatus, credentials, app, users } = await setup();
    const bodies: string[] = [];
    const record = async (accessId: unknown) => {
      vi.setSystemTime(Date.now() + 61_000); // stay under the 5/minute rate limit
      const response = await login(accessId);
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      const { error } = response.json();
      bodies.push(JSON.stringify({ code: error.code, message: error.message }));
    };

    await record("SP-7KQ9X82MP4Z7"); // unknown
    await record("not an access id"); // malformed
    await record(12345); // wrong type

    const revoked = await accessIdFor();
    await generate(); // regeneration revokes it
    await record(revoked);

    const expired = (await generate(users.ownerA, CUSTOMER_A, ORG_A, { expiresAt: new Date(Date.now() + 60_000).toISOString() })).json().accessId;
    (credentials.at(-1) as FakeCredential).expiresAt = new Date(Date.now() - 1000).toISOString();
    await record(expired);

    const suspended = await accessIdFor();
    customers.set(CUSTOMER_A, customer(CUSTOMER_A, ORG_A, { status: "SUSPENDED" }));
    await record(suspended);
    customers.set(CUSTOMER_A, customer(CUSTOMER_A, ORG_A));

    organizationStatus.set(ORG_A, "SUSPENDED");
    await record(suspended);
    organizationStatus.set(ORG_A, "ACTIVE");

    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ code: "INVALID_CREDENTIALS", message: "Las credenciales no son válidas." })]));
    vi.setSystemTime(Date.now() + 61_000);
    expect((await login(suspended)).statusCode).toBe(200);
    void app;
  });

  it("failures of a KNOWN credential are audited in its organization with a category only; unknown ones are not attributable", async () => {
    const { accessIdFor, login, generate, context } = await setup();
    const accessId = await accessIdFor();
    await generate();
    await login(accessId);
    await login("SP-7KQ9X82MP4Z7");
    await new Promise((resolve) => setImmediate(resolve));

    const failures = context.privileged.insertAuditLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.metadata?.event === "portal.login.failed");
    expect(failures).toEqual([
      expect.objectContaining({ organizationId: ORG_A, actorUserId: null, action: "FAIL", entityType: "customer", entityId: CUSTOMER_A, metadata: { event: "portal.login.failed", reason: "REVOKED" } })
    ]);
    expect(JSON.stringify(context.privileged.insertAuditLog.mock.calls)).not.toContain(accessId.slice(3));
  });

  it("the client cannot supply customerId / organizationId / role (strict body, generic failure)", async () => {
    const { accessIdFor, app } = await setup();
    const accessId = await accessIdFor();
    const response = await app.inject({
      method: "POST",
      url: "/api/portal/session",
      headers: { "content-type": "application/json" },
      payload: { accessId, customerId: CUSTOMER_B, organizationId: ORG_B, role: "OWNER" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("CSRF hardening: JSON only, and foreign browser origins are refused", async () => {
    const { accessIdFor, app } = await setup();
    const accessId = await accessIdFor();
    const form = await app.inject({ method: "POST", url: "/api/portal/session", headers: { "content-type": "text/plain" }, payload: JSON.stringify({ accessId }) });
    expect(form.statusCode).toBe(415);
    const foreign = await app.inject({
      method: "POST",
      url: "/api/portal/session",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      payload: { accessId }
    });
    expect(foreign.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: "/api/portal/session",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      payload: { accessId }
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("CORS allows credentials only for /api/portal/*", async () => {
    const { app } = await setup();
    const preflight = (url: string) =>
      app.inject({
        method: "OPTIONS",
        url,
        headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
      });
    expect((await preflight("/api/portal/session")).headers["access-control-allow-credentials"]).toBe("true");
    expect((await preflight("/api/customers")).headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("portal session authorization (requirePortalSession)", () => {
  it("/portal/me returns the session's customer only; no internal ids, hashes or tokens", async () => {
    const { accessIdFor, login, sessionCookieOf, me } = await setup();
    const cookie = sessionCookieOf(await login(await accessIdFor()));
    const response = await me(cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      customer: { displayName: "Juan", status: "ACTIVE" },
      organization: { name: "Org A" },
      bots: [],
      session: { idleExpiresAt: expect.any(String), absoluteExpiresAt: expect.any(String) }
    });
    expect(response.body).not.toContain(CUSTOMER_A);
    expect(response.body).not.toContain(ORG_A);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("no cookie, a malformed cookie or an unknown token -> 401 (and the bad cookie is cleared)", async () => {
    const { me, app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/portal/me" })).statusCode).toBe(401);
    const malformed = await me(`${PORTAL_SESSION_COOKIE}=abc`);
    expect(malformed.statusCode).toBe(401);
    expect(String(malformed.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await me(`${PORTAL_SESSION_COOKIE}=${generateSessionToken()}`)).statusCode).toBe(401);
  });

  it("the session is the only authority: headers, query or a bearer token cannot switch customer or organization", async () => {
    const { accessIdFor, login, sessionCookieOf, app, users } = await setup();
    const cookieB = sessionCookieOf(await login(await accessIdFor(CUSTOMER_B, ORG_B)));
    const response = await app.inject({
      method: "GET",
      url: `/api/portal/me?customerId=${CUSTOMER_A}&organizationId=${ORG_A}`,
      headers: { cookie: cookieB, "x-organization-id": ORG_A, authorization: `Bearer ${users.ownerA.token}` }
    });
    expect(response.json()).toMatchObject({ customer: { displayName: "Pedro" }, organization: { name: "Org B" } });
  });

  it("customer suspended, organization suspended, idle expiry and absolute expiry invalidate the session", async () => {
    const { accessIdFor, login, sessionCookieOf, me, customers, organizationStatus, sessions } = await setup();
    const accessId = await accessIdFor();
    const cookie = sessionCookieOf(await login(accessId));

    customers.set(CUSTOMER_A, customer(CUSTOMER_A, ORG_A, { status: "SUSPENDED" }));
    expect((await me(cookie)).statusCode).toBe(401);
    customers.set(CUSTOMER_A, customer(CUSTOMER_A, ORG_A));

    organizationStatus.set(ORG_A, "SUSPENDED");
    expect((await me(cookie)).statusCode).toBe(401);
    organizationStatus.set(ORG_A, "ACTIVE");
    expect((await me(cookie)).statusCode).toBe(200);

    (sessions[0] as FakeSession).idleExpiresAt = Date.now() - 1;
    expect((await me(cookie)).statusCode).toBe(401);

    const second = sessionCookieOf(await login(accessId));
    (sessions[1] as FakeSession).absoluteExpiresAt = Date.now() - 1;
    expect((await me(second)).statusCode).toBe(401);
  });

  it("organization B keeps working while organization A is suspended", async () => {
    const { accessIdFor, login, sessionCookieOf, me, organizationStatus } = await setup();
    const cookieA = sessionCookieOf(await login(await accessIdFor()));
    const accessB = await accessIdFor(CUSTOMER_B, ORG_B);
    const cookieB = sessionCookieOf(await login(accessB));
    organizationStatus.set(ORG_A, "SUSPENDED");
    expect((await me(cookieA)).statusCode).toBe(401);
    expect((await me(cookieB)).statusCode).toBe(200);
    expect((await login(accessB)).statusCode).toBe(200);
  });

  it("logout revokes only the current session, clears the cookie and is audited", async () => {
    const { accessIdFor, login, sessionCookieOf, me, app, context } = await setup();
    const accessId = await accessIdFor();
    const first = sessionCookieOf(await login(accessId));
    const second = sessionCookieOf(await login(accessId));

    const response = await app.inject({ method: "POST", url: "/api/portal/logout", headers: { cookie: first } });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toMatch(new RegExp(`^${PORTAL_SESSION_COOKIE}=; .*Max-Age=0`));
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/portal/logout", headers: { cookie: first } })).statusCode).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    const logouts = context.privileged.insertAuditLog.mock.calls.filter(([entry]) => entry.action === "LOGOUT");
    expect(logouts).toHaveLength(1);
    expect(logouts[0]?.[0]).toMatchObject({ actorUserId: null, metadata: { event: "customer.session.revoked", reason: "LOGOUT" } });
  });

  it("concurrency: simultaneous logins create independent sessions; concurrent validations all succeed", async () => {
    const { accessIdFor, login, sessionCookieOf, me } = await setup();
    const accessId = await accessIdFor();
    const logins = await Promise.all(Array.from({ length: 4 }, () => login(accessId)));
    expect(logins.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    const cookies = logins.map(sessionCookieOf);
    expect(new Set(cookies).size).toBe(4);
    const checks = await Promise.all(cookies.flatMap((cookie) => [me(cookie), me(cookie)]));
    expect(checks.every((response) => response.statusCode === 200)).toBe(true);
  });

  it("concurrency: simultaneous regenerations leave exactly one ACTIVE credential", async () => {
    const { generate, credentials, login } = await setup();
    const responses = await Promise.all(Array.from({ length: 3 }, () => generate()));
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(credentials.filter((credential) => credential.status === "ACTIVE")).toHaveLength(1);
    const winners = await Promise.all(responses.map((response) => login(response.json().accessId)));
    expect(winners.filter((response) => response.statusCode === 200)).toHaveLength(1);
  });
});

describe("rate limit and lockout", () => {
  it("5 attempts per minute per IP; the 6th is limited; allowed again after the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { login, accessIdFor } = await setup();
    const accessId = await accessIdFor();
    for (let attempt = 1; attempt <= 5; attempt++) expect((await login("SP-7KQ9X82MP4Z7")).statusCode).toBe(401);
    const limited = await login(accessId);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code ?? limited.json().error?.code).toBe("RATE_LIMITED");

    vi.setSystemTime(Date.now() + 61_000);
    expect((await login(accessId)).statusCode).toBe(200);
  });

  it("10 failures lock the IP for 15 minutes (even with a valid Access ID), then it works again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { login, accessIdFor } = await setup();
    const accessId = await accessIdFor();
    for (let failure = 1; failure <= LOGIN_LOCKOUT.maxFailures; failure++) {
      if (failure === 6) vi.setSystemTime(Date.now() + 61_000); // stay under 5/minute
      expect((await login("SP-7KQ9X82MP4Z7")).statusCode).toBe(401);
    }
    vi.setSystemTime(Date.now() + 61_000);
    const locked = await login(accessId);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);

    vi.setSystemTime(Date.now() + LOGIN_LOCKOUT.lockMs);
    expect((await login(accessId)).statusCode).toBe(200);
  });

  it("a successful login clears the failure counter", async () => {
    const throttle = createLoginThrottle(undefined, { onFallback: () => undefined });
    for (let failure = 1; failure < LOGIN_LOCKOUT.maxFailures; failure++) expect(await throttle.recordFailure("ip")).toBe(0);
    await throttle.recordSuccess("ip");
    expect(await throttle.recordFailure("ip")).toBe(0);
    expect(await throttle.lockedFor("ip")).toBe(0);
  });

  it("Redis failing: the existing per-instance fallback keeps both the rate limit and the lockout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const broken: RateLimitRedis = { eval: vi.fn(async () => Promise.reject(new Error("redis down"))) };
    const { login } = await setup({ rateLimitRedis: broken });
    for (let attempt = 1; attempt <= 5; attempt++) expect((await login("SP-7KQ9X82MP4Z7")).statusCode).toBe(401);
    expect((await login("SP-7KQ9X82MP4Z7")).statusCode).toBe(429);
    vi.setSystemTime(Date.now() + 61_000);
    for (let attempt = 1; attempt <= 5; attempt++) expect((await login("SP-7KQ9X82MP4Z7")).statusCode).toBe(401);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await login("SP-7KQ9X82MP4Z7")).statusCode).toBe(429); // locked after 10 failures
    expect(broken.eval).toHaveBeenCalled();
  });

  it("Redis available: lockout counters are shared through Redis (atomic scripts)", async () => {
    const store = new Map<string, number>();
    const redis: RateLimitRedis = {
      eval: vi.fn(async (script: string, _keys: number, ...args: Array<string | number>) => {
        if (script.includes("INCR', KEYS[1])\nif failures")) {
          const failures = (store.get(String(args[0])) ?? 0) + 1;
          store.set(String(args[0]), failures);
          if (failures >= Number(args[3])) {
            store.set(String(args[1]), Number(args[4]));
            store.delete(String(args[0]));
            return Number(args[4]);
          }
          return 0;
        }
        if (script.includes("PTTL")) return store.get(String(args[0])) ?? 0;
        store.delete(String(args[0]));
        return 0;
      })
    };
    const throttle = createLoginThrottle(redis, { onFallback: () => undefined });
    for (let failure = 1; failure < LOGIN_LOCKOUT.maxFailures; failure++) await throttle.recordFailure("1.2.3.4");
    expect(await throttle.lockedFor("1.2.3.4")).toBe(0);
    expect(await throttle.recordFailure("1.2.3.4")).toBe(LOGIN_LOCKOUT.lockMs);
    expect(await throttle.lockedFor("1.2.3.4")).toBe(LOGIN_LOCKOUT.lockMs);
    expect([...store.keys()].some((key) => key.includes("SP-") || key.includes("7KQ9"))).toBe(false);
  });
});

describe("secrets never leak", () => {
  it("no Access ID, session token or hash in logs, audit entries or responses other than the one-time generation", async () => {
    const lines: string[] = [];
    const { generate, login, sessionCookieOf, me, app, context, credentials } = await setup({ logLines: lines });
    const accessId = (await generate()).json().accessId as string;
    const loginResponse = await login(accessId);
    const cookie = sessionCookieOf(loginResponse);
    const token = cookie.split("=")[1] as string;
    await login("SP-7KQ9X82MP4Z7");
    await me(cookie);
    await app.inject({ method: "POST", url: "/api/portal/logout", headers: { cookie } });
    await new Promise((resolve) => setImmediate(resolve));

    const logs = lines.join("\n");
    const audits = JSON.stringify(context.privileged.insertAuditLog.mock.calls);
    const secrets = [accessId, accessId.slice(3), token, hashSessionToken(token), credentials[0]?.secretHash as string, "7KQ9X82MP4Z7"];
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(logs).not.toContain(secret);
      expect(audits).not.toContain(secret);
    }
    expect(loginResponse.body).not.toContain(token);
    expect(logs).toContain("portal.login.failed");
  });
});
