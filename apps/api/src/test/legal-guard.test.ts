import { CURRENT_LEGAL_VERSIONS, type LegalAcceptanceRecord } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSessionToken, hashSessionToken } from "../lib/customer-access.js";
import { PORTAL_SESSION_COOKIE } from "../modules/portal/session.js";
import { createLegalAcceptanceGate } from "../plugins/legal-acceptance.js";
import { authHeaders, createTestApp, makeUser, MICROSOFT_OAUTH, ORG_A, ORG_B, type TestUser } from "./helpers.js";

/*
 * EmailBot V2 phase 7: the API is the authority for the legal barrier. Every
 * route behind `authenticate` answers 403 LEGAL_ACCEPTANCE_REQUIRED to a user
 * without an acceptance of the CURRENT versions, before any organization or
 * data lookup. Exceptions: GET /api/me and POST /api/me/legal-acceptance.
 * Routes without a user session (health, webhooks, customer portal, OAuth
 * callback) never consult it. Gmail push: gmail-push.test.ts.
 */

const ownerA = makeUser({ [ORG_A]: "OWNER" });
const ownerB = makeUser({ [ORG_B]: "OWNER" });
const platformAdmin = makeUser({});

const current: LegalAcceptanceRecord[] = [
  { document: "terms", version: CURRENT_LEGAL_VERSIONS.terms },
  { document: "privacy", version: CURRENT_LEGAL_VERSIONS.privacy }
];
const old: LegalAcceptanceRecord[] = [
  { document: "terms", version: "1.0" },
  { document: "privacy", version: "1.0" }
];
const shown = { termsVersion: CURRENT_LEGAL_VERSIONS.terms, privacyVersion: CURRENT_LEGAL_VERSIONS.privacy };

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

/** Real app with fake infrastructure; `accepted` = what legal_acceptances holds per user. */
async function setup(accepted: Record<string, LegalAcceptanceRecord[]>, config: NonNullable<Parameters<typeof createTestApp>[0]>["config"] = {}) {
  ctx = await createTestApp({ users: [ownerA, ownerB, platformAdmin], platformAdmins: [platformAdmin.id], config });
  const rows: Record<string, LegalAcceptanceRecord[]> = structuredClone(accepted);
  ctx.privileged.listLegalAcceptances.mockImplementation(async (userId: string) => rows[userId] ?? []);
  ctx.privileged.recordLegalAcceptance.mockImplementation(async (userId: string, versions: { terms: string; privacy: string }) => {
    rows[userId] = [...(rows[userId] ?? []), { document: "terms", version: versions.terms }, { document: "privacy", version: versions.privacy }];
  });
  return ctx;
}

const call = (user: TestUser | null, method: "GET" | "POST" | "PATCH", url: string, organizationId?: string, payload?: unknown) =>
  ctx!.app.inject({
    method,
    url,
    headers: user ? authHeaders(user, organizationId) : {},
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {})
  });

/* Every protected area: organization, emails, rules, dashboard data, bots, customers, members, settings, audit, onboarding, admin. */
const PROTECTED: Array<[string, "GET" | "POST" | "PATCH", string, boolean, unknown?]> = [
  ["organization", "GET", "/api/organizations/current", true],
  ["settings", "PATCH", "/api/organizations/current/settings", true, { timezone: "America/Lima" }],
  ["emails (dashboard / inbox)", "GET", "/api/emails", true],
  ["rules", "GET", "/api/rules", true],
  ["categories", "GET", "/api/categories", true],
  ["bots", "GET", "/api/bots", true],
  ["customers", "GET", "/api/customers", true],
  ["members", "GET", "/api/organizations/current/members", true],
  ["email accounts", "GET", "/api/email-accounts", true],
  ["OAuth connection start", "POST", "/api/email-accounts/oauth/gmail/start", true],
  ["audit", "GET", "/api/audit-logs", true],
  ["customer Access ID: issue / regenerate", "POST", "/api/customers/33333333-3333-4333-8333-333333333333/access", true, {}],
  ["customer portal sessions", "GET", "/api/customers/33333333-3333-4333-8333-333333333333/sessions", true],
  ["login audit event", "POST", "/api/me/login-event", true],
  ["onboarding: create organization", "POST", "/api/organizations", false, { name: "Nueva" }]
];

describe("API legal barrier", () => {
  it.each(PROTECTED)("1. without acceptance: %s -> 403 LEGAL_ACCEPTANCE_REQUIRED before any data or membership lookup", async (_label, method, url, scoped, payload) => {
    const { repos } = await setup({});
    const response = await call(ownerA, method, url, scoped ? ORG_A : undefined, payload);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect(repos.memberships.findAccess).not.toHaveBeenCalled();
    expect(repos.memberships.listForUser).not.toHaveBeenCalled();
  });

  it("2. with the current acceptance: protected routes work normally", async () => {
    const { repos } = await setup({ [ownerA.id]: current });
    repos.rules.list.mockResolvedValue([]);
    repos.categories.list.mockResolvedValue([]);
    expect((await call(ownerA, "GET", "/api/rules", ORG_A)).statusCode).toBe(200);
    expect((await call(ownerA, "GET", "/api/categories", ORG_A)).statusCode).toBe(200);
    expect(repos.rules.list).toHaveBeenCalledWith(ORG_A, {});
  });

  it("3. without acceptance: GET /api/me works and reports it", async () => {
    await setup({});
    const response = await call(ownerA, "GET", "/api/me");
    expect(response.statusCode).toBe(200);
    expect(response.json().legal).toEqual({ ...shown, accepted: false });
  });

  it("4. without acceptance: POST /api/me/legal-acceptance works", async () => {
    const { privileged } = await setup({});
    const response = await call(ownerA, "POST", "/api/me/legal-acceptance", undefined, shown);
    expect(response.statusCode).toBe(200);
    expect(privileged.recordLegalAcceptance).toHaveBeenCalledWith(ownerA.id, CURRENT_LEGAL_VERSIONS);
  });

  it("5. an older accepted version -> 403 on protected routes", async () => {
    await setup({ [ownerA.id]: old });
    const response = await call(ownerA, "GET", "/api/rules", ORG_A);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("6. after accepting the current versions the same route works immediately (refusals are never cached)", async () => {
    const { repos } = await setup({ [ownerA.id]: old });
    repos.rules.list.mockResolvedValue([]);
    expect((await call(ownerA, "GET", "/api/rules", ORG_A)).statusCode).toBe(403);
    expect((await call(ownerA, "POST", "/api/me/legal-acceptance", undefined, shown)).statusCode).toBe(200);
    expect((await call(ownerA, "GET", "/api/rules", ORG_A)).statusCode).toBe(200);
  });

  it("the platform administration also requires it (same user session); with it, F6 keeps working", async () => {
    const { admin } = await setup({});
    const denied = await call(platformAdmin, "GET", "/api/admin/stats");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect(admin.isPlatformAdmin).not.toHaveBeenCalled();

    await call(platformAdmin, "POST", "/api/me/legal-acceptance", undefined, shown);
    admin.stats.mockResolvedValue({ totalOrganizations: 0 });
    expect((await call(platformAdmin, "GET", "/api/admin/stats")).statusCode).toBe(200);
    // A normal user with acceptance is still not a platform administrator.
    await call(ownerA, "POST", "/api/me/legal-acceptance", undefined, shown);
    expect((await call(ownerA, "GET", "/api/admin/stats")).json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
  });

  it("10. organization isolation is unchanged: acceptance never grants access to another organization", async () => {
    const { repos } = await setup({ [ownerA.id]: current });
    const response = await call(ownerA, "GET", "/api/rules", ORG_B);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("NOT_A_MEMBER");
    expect(repos.rules.list).not.toHaveBeenCalled();
    // Owner B without acceptance cannot use even its own organization.
    expect((await call(ownerB, "GET", "/api/rules", ORG_B)).json().error.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("unauthenticated requests still get 401 (the barrier runs after authentication)", async () => {
    const { privileged } = await setup({});
    expect((await call(null, "GET", "/api/rules", ORG_A)).statusCode).toBe(401);
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });
});

describe("routes without a user session are not affected", () => {
  it("8. health", async () => {
    const { privileged } = await setup({});
    expect((await ctx!.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });

  it("7. Microsoft webhook (subscription validation handshake)", async () => {
    const { privileged } = await setup({}, { microsoftGraphPushEnabled: true, microsoft: MICROSOFT_OAUTH });
    const response = await ctx!.app.inject({ method: "POST", url: "/webhooks/microsoft?validationToken=abc123" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("abc123");
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });

  it("9. customer portal login (customers are not users) and the OAuth callback (signed state, no bearer)", async () => {
    const { privileged, deps } = await setup({});
    privileged.createPortalSession.mockResolvedValue({ ok: false, reason: "INVALID" });
    const portal = await ctx!.app.inject({
      method: "POST",
      url: "/api/portal/session",
      headers: { "content-type": "application/json", origin: deps.config.webAppUrl },
      payload: { accessId: "AAAA-BBBB-CCCC" }
    });
    expect(portal.statusCode).not.toBe(403);
    const callback = await ctx!.app.inject({ method: "GET", url: "/api/oauth/gmail/callback?state=forged&code=x" });
    expect(callback.statusCode).toBe(302);
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });
});

describe("identity separation: panel user (Supabase JWT) vs portal customer (session cookie)", () => {
  const CUSTOMER = "33333333-3333-4333-8333-333333333333";
  const token = generateSessionToken();
  const cookie = `${PORTAL_SESSION_COOKIE}=${token}`;

  async function portalSetup() {
    const context = await setup({}); // nobody accepted anything
    context.privileged.validatePortalSession.mockImplementation(async (hash: string) =>
      hash === hashSessionToken(token)
        ? {
            sessionId: "session-1",
            organizationId: ORG_A,
            customerId: CUSTOMER,
            profile: {
              customer: { displayName: "Cliente", status: "ACTIVE" },
              organization: { name: "Org A" },
              bots: [],
              session: { idleExpiresAt: "2099-01-01T00:00:00.000Z", absoluteExpiresAt: "2099-01-01T00:00:00.000Z" }
            }
          }
        : null
    );
    return context;
  }

  it("a valid portal cookie never authenticates a panel route (401, no user)", async () => {
    const { privileged } = await portalSetup();
    const response = await ctx!.app.inject({ method: "GET", url: "/api/rules", headers: { cookie, "x-organization-id": ORG_A } });
    expect(response.statusCode).toBe(401);
    expect(privileged.validatePortalSession).not.toHaveBeenCalled();
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });

  it("a panel bearer token never opens the portal: without the cookie -> 401", async () => {
    const { privileged } = await portalSetup();
    const response = await ctx!.app.inject({ method: "GET", url: "/api/portal/me", headers: authHeaders(ownerA) });
    expect(response.statusCode).toBe(401);
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });

  it("with both, the portal ignores the bearer: the identity is the customer of the session, not the user", async () => {
    const { privileged } = await portalSetup();
    const response = await ctx!.app.inject({ method: "GET", url: "/api/portal/me", headers: { ...authHeaders(ownerA), cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().customer.displayName).toBe("Cliente");
    expect(JSON.stringify(response.json())).not.toContain(ownerA.id);
    expect(privileged.listLegalAcceptances).not.toHaveBeenCalled();
  });
});

describe("legal acceptance gate (cache)", () => {
  it("caches only positive answers, for the configured time", async () => {
    let clock = 0;
    const rows: Record<string, LegalAcceptanceRecord[]> = { accepted: current };
    const listLegalAcceptances = vi.fn(async (userId: string) => rows[userId] ?? []);
    const gate = createLegalAcceptanceGate({ listLegalAcceptances }, { ttlMs: 1000, now: () => clock });

    expect(await gate.isAccepted("accepted")).toBe(true);
    expect(await gate.isAccepted("accepted")).toBe(true);
    expect(listLegalAcceptances).toHaveBeenCalledTimes(1);
    clock = 1001;
    expect(await gate.isAccepted("accepted")).toBe(true);
    expect(listLegalAcceptances).toHaveBeenCalledTimes(2);

    expect(await gate.isAccepted("pending")).toBe(false);
    expect(await gate.isAccepted("pending")).toBe(false);
    expect(listLegalAcceptances).toHaveBeenCalledTimes(4); // refusals are read every time
  });

  it("is bounded: the oldest cached user is evicted", async () => {
    const listLegalAcceptances = vi.fn(async () => current);
    const gate = createLegalAcceptanceGate({ listLegalAcceptances }, { maxEntries: 2 });
    for (const user of ["a", "b", "c"]) await gate.isAccepted(user);
    listLegalAcceptances.mockClear();
    await gate.isAccepted("c");
    await gate.isAccepted("b");
    expect(listLegalAcceptances).not.toHaveBeenCalled();
    await gate.isAccepted("a");
    expect(listLegalAcceptances).toHaveBeenCalledTimes(1);
  });

  it("a database failure is not an acceptance (the request fails)", async () => {
    const gate = createLegalAcceptanceGate({ listLegalAcceptances: vi.fn(async () => Promise.reject(new Error("db down"))) });
    await expect(gate.isAccepted("x")).rejects.toThrow("db down");
  });
});
