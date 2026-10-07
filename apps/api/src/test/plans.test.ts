import { createOAuthState } from "@emailbot/shared";
import {
  COMMERCIAL_PLANS,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type CommercialPlan,
  type EmailAccount,
  type OrganizationPlan,
  type PlanUsageKey
} from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderConfig } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import {
  assertFeatureEnabled,
  assertWithinLimit,
  canUseFeature,
  createEntitlementService,
  getLimit,
  isWithinLimit
} from "../modules/plans/entitlements.js";
import { toEntitlements } from "../repositories/supabase/plan-repositories.js";
import type { PlanRepository } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, MICROSOFT_OAUTH, ORG_A, type TestUser } from "./helpers.js";
import { entitlementsFor, noAccess, V1_FEATURES, V1_LIMITS } from "./plan-fixtures.js";

/*
 * Commercial V1, phase 1: entitlements (limits + features) and where the API
 * enforces them. Values come from the database catalog; here they are the
 * fixture of the approved catalog (checked against the migration seed in
 * packages/database/test/plan-catalog.test.ts).
 */

const ID = "33333333-3333-4333-8333-333333333333";
const google: OAuthProviderConfig = { clientId: "google-client", clientSecret: "google-secret", redirectUri: "https://api.example.com/api/oauth/gmail/callback" };

/* ------------------------------------------------------------------ pure entitlement checks */

describe("catalog entitlements (pure checks)", () => {
  it("every plan has every known limit and feature", () => {
    for (const plan of COMMERCIAL_PLANS) {
      const entitlements = entitlementsFor(plan);
      expect(Object.keys(entitlements.limits).sort()).toEqual([...PLAN_LIMIT_KEYS].sort());
      expect(Object.keys(entitlements.features).sort()).toEqual([...PLAN_FEATURE_KEYS].sort());
    }
  });

  it.each([
    ["BASIC", { GMAIL: true, MICROSOFT: false, PORTAL: false, API: false, ADVANCED_STATS: false }],
    ["PRO", { GMAIL: true, MICROSOFT: true, PORTAL: true, API: false, ADVANCED_STATS: true }],
    ["BUSINESS", { GMAIL: true, MICROSOFT: true, PORTAL: true, API: true, ADVANCED_STATS: true }]
  ] as const)("%s features", (plan, expected) => {
    const entitlements = entitlementsFor(plan);
    for (const [feature, enabled] of Object.entries(expected)) {
      expect(canUseFeature(entitlements, feature as keyof typeof expected)).toBe(enabled);
      if (enabled) expect(() => assertFeatureEnabled(entitlements, feature as keyof typeof expected)).not.toThrow();
      else expect(() => assertFeatureEnabled(entitlements, feature as keyof typeof expected)).toThrow(AppError);
    }
  });

  it.each(COMMERCIAL_PLANS.flatMap((plan) => PLAN_LIMIT_KEYS.map((limit) => [plan, limit] as const)))("%s %s limit", (plan, limit) => {
    expect(getLimit(entitlementsFor(plan), limit)).toBe(V1_LIMITS[plan][limit]);
  });

  // Hard limits: the last unit fits, the next one does not.
  it.each([
    ["BASIC", "EMAIL_ACCOUNTS", 25],
    ["PRO", "EMAIL_ACCOUNTS", 125],
    ["BUSINESS", "EMAIL_ACCOUNTS", 250],
    ["BASIC", "RULES", 10],
    ["PRO", "RULES", 30],
    ["BUSINESS", "RULES", 100],
    ["BASIC", "BOTS", 2],
    ["PRO", "BOTS", 10],
    ["BUSINESS", "BOTS", 50],
    ["BASIC", "MEMBERS", 2],
    ["PRO", "MEMBERS", 5],
    ["BUSINESS", "MEMBERS", 20],
    ["BASIC", "CUSTOMERS", 500],
    ["PRO", "CUSTOMERS", 2_500],
    ["BUSINESS", "CUSTOMERS", 10_000],
    ["BASIC", "MONTHLY_EMAILS", 2_000],
    ["PRO", "MONTHLY_EMAILS", 15_000],
    ["BUSINESS", "MONTHLY_EMAILS", 75_000]
  ] as const)("%s cannot exceed %s = %d", (plan, limit, max) => {
    const entitlements = entitlementsFor(plan);
    expect(isWithinLimit(entitlements, limit, max - 1)).toBe(true);
    expect(() => assertWithinLimit(entitlements, limit, max - 1)).not.toThrow();
    expect(isWithinLimit(entitlements, limit, max)).toBe(false);
    expect(() => assertWithinLimit(entitlements, limit, max)).toThrow(
      expect.objectContaining({ statusCode: 403, code: "PLAN_LIMIT_REACHED", details: { limit, max, used: max, plan } })
    );
  });

  it("usage already above the limit (plan lowered) is kept but nothing more is added", () => {
    expect(isWithinLimit(entitlementsFor("BASIC"), "EMAIL_ACCOUNTS", 30)).toBe(false);
  });

  it("a null limit is unlimited", () => {
    const entitlements = entitlementsFor("BUSINESS");
    entitlements.limits.RULES = null;
    expect(isWithinLimit(entitlements, "RULES", 1_000_000)).toBe(true);
  });

  it("a legacy FREE organization is entitled as BASIC", () => {
    const entitlements = entitlementsFor("FREE");
    expect(entitlements).toMatchObject({ plan: "FREE", effectivePlan: "BASIC" });
    expect(canUseFeature(entitlements, "MICROSOFT")).toBe(false);
    expect(() => assertWithinLimit(entitlements, "EMAIL_ACCOUNTS", 25)).toThrow(expect.objectContaining({ details: expect.objectContaining({ plan: "BASIC" }) }));
  });
});

describe("toEntitlements (database rows -> entitlements)", () => {
  const row = (key: string, kind: "LIMIT" | "FEATURE", value: number | boolean | null) => ({
    plan: "PRO",
    effective_plan: "PRO",
    access: "SUBSCRIPTION",
    subscription_status: "ACTIVE",
    key,
    kind,
    limit_value: kind === "LIMIT" ? value : null,
    enabled: kind === "FEATURE" ? value : null
  });

  it("maps limits (bigint strings included) and features", () => {
    const entitlements = toEntitlements([row("RULES", "LIMIT", 30), row("STORAGE_BYTES", "LIMIT", "5368709120" as never), row("MICROSOFT", "FEATURE", true)]);
    expect(entitlements).toMatchObject({ plan: "PRO", effectivePlan: "PRO", access: "SUBSCRIPTION", subscriptionStatus: "ACTIVE" });
    expect(entitlements?.limits.RULES).toBe(30);
    expect(entitlements?.limits.STORAGE_BYTES).toBe(5_368_709_120);
    expect(entitlements?.features.MICROSOFT).toBe(true);
  });

  it("fails closed: a missing limit is 0 and a missing feature is disabled; null limit = unlimited", () => {
    const entitlements = toEntitlements([row("RULES", "LIMIT", null)]);
    expect(entitlements?.limits.RULES).toBeNull();
    expect(entitlements?.limits.BOTS).toBe(0);
    expect(entitlements?.features.GMAIL).toBe(false);
  });

  it("ignores keys the code does not know yet", () => {
    const entitlements = toEntitlements([row("FUTURE_LIMIT", "LIMIT", 9), row("FUTURE_FEATURE", "FEATURE", true)]);
    expect(entitlements?.limits).not.toHaveProperty("FUTURE_LIMIT");
    expect(entitlements?.features).not.toHaveProperty("FUTURE_FEATURE");
  });

  it("no rows (organization not visible) -> null", () => {
    expect(toEntitlements([])).toBeNull();
  });

  it("access NONE (no active subscription): no plan, every limit 0, every feature off - whatever the rows say", () => {
    const none = { plan: null, effective_plan: null, access: "NONE", subscription_status: "SUSPENDED", key: null, kind: null, limit_value: null, enabled: null };
    expect(toEntitlements([none])).toMatchObject({ plan: null, effectivePlan: null, access: "NONE", subscriptionStatus: "SUSPENDED" });
    // Fail closed: an unknown access or a non-commercial effective plan never grants anything.
    for (const broken of [{ ...row("RULES", "LIMIT", 9), access: "FREE_FOREVER" }, { ...row("RULES", "LIMIT", 9), effective_plan: "FREE" }]) {
      const entitlements = toEntitlements([broken]);
      expect(entitlements?.access).toBe("NONE");
      expect(entitlements?.limits.RULES).toBe(0);
    }
  });
});

describe("EntitlementService", () => {
  function source(plan: OrganizationPlan | null, usage: Partial<Record<PlanUsageKey, number>> = {}) {
    return {
      entitlements: vi.fn(async () => (plan ? entitlementsFor(plan) : null)),
      subscription: vi.fn(async () => null),
      usage: vi.fn(async (_organizationId: string, keys: readonly PlanUsageKey[] = []) => Object.fromEntries(keys.map((key) => [key, usage[key] ?? 0])))
    } satisfies PlanRepository;
  }

  it("canUseFeature / getLimit / assertFeatureEnabled by organization id", async () => {
    const service = createEntitlementService(source("BASIC"));
    expect(await service.canUseFeature(ORG_A, "MICROSOFT")).toBe(false);
    expect(await service.canUseFeature(ORG_A, "GMAIL")).toBe(true);
    expect(await service.getLimit(ORG_A, "RETENTION_DAYS")).toBe(30);
    await expect(service.assertFeatureEnabled(ORG_A, "PORTAL")).rejects.toMatchObject({ code: "PLAN_FEATURE_UNAVAILABLE", details: { feature: "PORTAL", plan: "BASIC" } });
  });

  it("assertWithinLimit reads only the needed usage, or uses the one given", async () => {
    const plans = source("PRO", { RULES: 30 });
    const service = createEntitlementService(plans);
    await expect(service.assertWithinLimit(ORG_A, "RULES")).rejects.toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    expect(plans.usage).toHaveBeenCalledWith(ORG_A, ["RULES"]);
    await expect(service.assertWithinLimit(ORG_A, "RULES", { currentUsage: 29 })).resolves.toBeUndefined();
    await expect(service.assertWithinLimit(ORG_A, "RULES", { currentUsage: 28, adding: 3 })).rejects.toMatchObject({ code: "PLAN_LIMIT_REACHED" });
  });

  it("without an active subscription every check fails with 403 SUBSCRIPTION_REQUIRED (read() still answers)", async () => {
    const plans = { ...source("BASIC"), entitlements: vi.fn(async () => noAccess("EXPIRED")) };
    const service = createEntitlementService(plans);
    expect(await service.read(ORG_A)).toMatchObject({ access: "NONE", subscriptionStatus: "EXPIRED" });
    expect(await service.canUseFeature(ORG_A, "GMAIL")).toBe(false);
    expect(await service.getLimit(ORG_A, "RULES")).toBe(0);
    for (const check of [service.get(ORG_A), service.assertFeatureEnabled(ORG_A, "GMAIL"), service.assertWithinLimit(ORG_A, "RULES")]) {
      await expect(check).rejects.toMatchObject({ statusCode: 403, code: "SUBSCRIPTION_REQUIRED", details: { subscriptionStatus: "EXPIRED" } });
    }
    expect(plans.usage).not.toHaveBeenCalled();
  });

  it("organization not visible: fails closed with 403 PLAN_UNAVAILABLE", async () => {
    await expect(createEntitlementService(source(null)).assertWithinLimit(ORG_A, "RULES")).rejects.toMatchObject({
      statusCode: 403,
      code: "PLAN_UNAVAILABLE"
    });
  });
});

/* ------------------------------------------------------------------ enforcement in the API */

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function appWithPlan(plan: OrganizationPlan, usage: Partial<Record<PlanUsageKey, number>> = {}, options: Parameters<typeof createTestApp>[0] = {}) {
  ctx = await createTestApp(options);
  ctx.repos.plans.entitlements.mockResolvedValue(entitlementsFor(plan));
  ctx.repos.plans.usage.mockImplementation(async (_organizationId: string, keys: readonly PlanUsageKey[] = []) =>
    Object.fromEntries(keys.map((key) => [key, usage[key] ?? 0]))
  );
  ctx.privileged.getOrganizationEntitlements.mockResolvedValue(entitlementsFor(plan));
  ctx.privileged.getOrganizationUsage.mockImplementation(async (_organizationId: string, keys: readonly PlanUsageKey[]) =>
    Object.fromEntries(keys.map((key) => [key, usage[key] ?? 0]))
  );
  return ctx;
}

const expectLimit = (response: { statusCode: number; json(): { error: { code: string; details?: unknown } } }, limit: string, max: number, plan: CommercialPlan) => {
  expect(response.statusCode).toBe(403);
  expect(response.json().error).toMatchObject({ code: "PLAN_LIMIT_REACHED", details: { limit, max, plan } });
};

describe("GET /api/organizations/current/plan", () => {
  it("every member (VIEWER included) sees the plan, its entitlements and the usage", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await appWithPlan("PRO", { EMAIL_ACCOUNTS: 3, RULES: 12, STORAGE_BYTES: 1024 }, { users: [viewer] });
    const response = await app.inject({ method: "GET", url: "/api/organizations/current/plan", headers: authHeaders(viewer, ORG_A) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entitlements).toEqual(entitlementsFor("PRO"));
    expect(body.usage).toEqual({ EMAIL_ACCOUNTS: 3, RULES: 12, BOTS: 0, MONTHLY_EMAILS: 0, MEMBERS: 0, CUSTOMERS: 0, STORAGE_BYTES: 1024 });
    expect(repos.plans.entitlements).toHaveBeenCalledWith(ORG_A);
  });

  it("readable while the organization is suspended; never for non-members", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const stranger = makeUser({});
    const { app } = await appWithPlan("BASIC", {}, { users: [owner, stranger], organizationStatuses: { [ORG_A]: "SUSPENDED" } });
    expect((await app.inject({ method: "GET", url: "/api/organizations/current/plan", headers: authHeaders(owner, ORG_A) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/organizations/current/plan", headers: authHeaders(stranger, ORG_A) })).statusCode).toBe(403);
  });
});

describe("limits enforced by the API (hard limits, nothing created)", () => {
  const admin = makeUser({ [ORG_A]: "ADMIN" });
  const headers = () => authHeaders(admin, ORG_A);
  const validRule = {
    name: "Netflix codes",
    conditions: [{ field: "sender", operator: "contains", value: "netflix.com" }],
    actions: [{ type: "EXTRACT", name: "verification_code", preset: "verification_code" }]
  };

  it("RULES: BASIC refuses the 11th rule, accepts the 10th", async () => {
    const { app, repos } = await appWithPlan("BASIC", { RULES: 10 }, { users: [admin] });
    expectLimit(await app.inject({ method: "POST", url: "/api/rules", headers: headers(), payload: validRule }), "RULES", 10, "BASIC");
    expect(repos.rules.create).not.toHaveBeenCalled();

    repos.plans.usage.mockResolvedValue({ RULES: 9 });
    repos.rules.create.mockResolvedValue({ id: ID, name: validRule.name, enabled: true, priority: 100, botId: null });
    expect((await app.inject({ method: "POST", url: "/api/rules", headers: headers(), payload: validRule })).statusCode).toBe(201);
  });

  it("RULES: PRO stops at 30, BUSINESS at 100", async () => {
    let { app } = await appWithPlan("PRO", { RULES: 30 }, { users: [admin] });
    expectLimit(await app.inject({ method: "POST", url: "/api/rules", headers: headers(), payload: validRule }), "RULES", 30, "PRO");
    await app.close();
    ({ app } = await appWithPlan("BUSINESS", { RULES: 100 }, { users: [admin] }));
    expectLimit(await app.inject({ method: "POST", url: "/api/rules", headers: headers(), payload: validRule }), "RULES", 100, "BUSINESS");
  });

  it("BOTS: an ACTIVE bot needs room; a PAUSED one does not; resuming needs room", async () => {
    const { app, repos } = await appWithPlan("BASIC", { BOTS: 2 }, { users: [admin] });
    expectLimit(await app.inject({ method: "POST", url: "/api/bots", headers: headers(), payload: { name: "Netflix" } }), "BOTS", 2, "BASIC");
    expect(repos.bots.create).not.toHaveBeenCalled();

    repos.bots.create.mockResolvedValue({ id: ID, name: "Prime", status: "PAUSED" });
    expect((await app.inject({ method: "POST", url: "/api/bots", headers: headers(), payload: { name: "Prime", status: "PAUSED" } })).statusCode).toBe(201);

    repos.bots.get.mockResolvedValue({ id: ID, name: "Prime", status: "PAUSED" });
    expectLimit(await app.inject({ method: "PATCH", url: `/api/bots/${ID}`, headers: headers(), payload: { status: "ACTIVE" } }), "BOTS", 2, "BASIC");
    expect(repos.bots.update).not.toHaveBeenCalled();
  });

  it("CUSTOMERS: an ACTIVE customer needs room; reactivating a suspended one too", async () => {
    const { app, repos } = await appWithPlan("BASIC", { CUSTOMERS: 500 }, { users: [admin] });
    expectLimit(await app.inject({ method: "POST", url: "/api/customers", headers: headers(), payload: { displayName: "Juan" } }), "CUSTOMERS", 500, "BASIC");
    expect(repos.customers.create).not.toHaveBeenCalled();

    repos.customers.get.mockResolvedValue({ id: ID, organizationId: ORG_A, displayName: "Juan", status: "SUSPENDED" });
    expectLimit(await app.inject({ method: "PATCH", url: `/api/customers/${ID}`, headers: headers(), payload: { status: "ACTIVE" } }), "CUSTOMERS", 500, "BASIC");
    expect(repos.customers.update).not.toHaveBeenCalled();

    // Suspending or renaming never needs room.
    repos.customers.update.mockResolvedValue({ id: ID, organizationId: ORG_A, displayName: "Juana", status: "SUSPENDED" });
    expect((await app.inject({ method: "PATCH", url: `/api/customers/${ID}`, headers: headers(), payload: { displayName: "Juana" } })).statusCode).toBe(200);
  });

  it("MEMBERS: BASIC refuses a third member before looking the user up", async () => {
    const { app, privileged, repos } = await appWithPlan("BASIC", { MEMBERS: 2 }, { users: [admin] });
    const response = await app.inject({ method: "POST", url: "/api/organizations/current/members", headers: headers(), payload: { email: "new@example.com", role: "VIEWER" } });
    expectLimit(response, "MEMBERS", 2, "BASIC");
    expect(privileged.findProfileIdByEmail).not.toHaveBeenCalled();
    expect(repos.members.add).not.toHaveBeenCalled();
  });

  it("PORTAL: BASIC cannot issue portal Access IDs; PRO can", async () => {
    const { app, repos } = await appWithPlan("BASIC", {}, { users: [admin] });
    repos.customers.get.mockResolvedValue({ id: ID, organizationId: ORG_A, displayName: "Juan", status: "ACTIVE" });
    const response = await app.inject({ method: "POST", url: `/api/customers/${ID}/access`, headers: headers(), payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "PLAN_FEATURE_UNAVAILABLE", details: { feature: "PORTAL", plan: "BASIC" } });
    expect(repos.customerAccess.issue).not.toHaveBeenCalled();

    repos.plans.entitlements.mockResolvedValue(entitlementsFor("PRO"));
    repos.customerAccess.issue.mockResolvedValue({
      credential: { id: ID, displayPrefix: "SP", last4: "ABCD", expiresAt: null },
      previousCredentialId: null,
      revokedSessions: 0
    });
    expect((await app.inject({ method: "POST", url: `/api/customers/${ID}/access`, headers: headers(), payload: {} })).statusCode).toBe(201);
  });
});

/* ------------------------------------------------------------------ e-mail accounts: Microsoft + account limit */

const mailbox = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: ID,
  organizationId: ORG_A,
  provider: "GMAIL",
  status: "ACTIVE",
  emailAddress: "me@gmail.com",
  displayName: null,
  lastSyncedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

describe("e-mail accounts: OAuth start", () => {
  const owner = makeUser({ [ORG_A]: "OWNER" });
  const start = (slug: "gmail" | "microsoft", user: TestUser = owner) =>
    ctx!.app.inject({ method: "POST", url: `/api/email-accounts/oauth/${slug}/start`, headers: authHeaders(user, ORG_A) });

  it.each(["BASIC", "FREE"] as const)("%s: Microsoft is refused by the backend (not only hidden)", async (plan) => {
    await appWithPlan(plan, {}, { users: [owner], config: { google, microsoft: MICROSOFT_OAUTH } });
    const response = await start("microsoft");
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "PLAN_FEATURE_UNAVAILABLE", details: { feature: "MICROSOFT", plan: "BASIC" } });
    expect(response.json()).not.toHaveProperty("authorizationUrl");
  });

  it.each(["PRO", "BUSINESS"] as const)("%s: Microsoft can be connected", async (plan) => {
    await appWithPlan(plan, {}, { users: [owner], config: { google, microsoft: MICROSOFT_OAUTH } });
    const response = await start("microsoft");
    expect(response.statusCode).toBe(200);
    expect(response.json().authorizationUrl).toContain("login.microsoftonline.com");
  });

  it("BASIC with 25 counted mailboxes: the 26th (new provider) is refused before going to the provider", async () => {
    const { repos } = await appWithPlan("BASIC", { EMAIL_ACCOUNTS: 25 }, { users: [owner], config: { google, microsoft: MICROSOFT_OAUTH } });
    repos.emailAccounts.list.mockResolvedValue([mailbox({ provider: "IMAP" }), mailbox({ provider: "IMAP", id: "x" })]);
    expectLimit(await start("gmail"), "EMAIL_ACCOUNTS", 25, "BASIC");
  });

  it("at the limit, re-authorizing a counted Gmail mailbox is still possible (decided in the callback)", async () => {
    const { repos } = await appWithPlan("BASIC", { EMAIL_ACCOUNTS: 25 }, { users: [owner], config: { google } });
    repos.emailAccounts.list.mockResolvedValue([mailbox({ status: "ERROR" }), mailbox({ id: "x", emailAddress: "b@gmail.com" })]);
    expect((await start("gmail")).statusCode).toBe(200);
  });

  it.each([
    ["BASIC", 25],
    ["PRO", 125],
    ["BUSINESS", 250]
  ] as const)("%s: mailbox number %d can be started, the next one is refused", async (plan, max) => {
    const below = await appWithPlan(plan, { EMAIL_ACCOUNTS: max - 1 }, { users: [owner], config: { google } });
    below.repos.emailAccounts.list.mockResolvedValue([]);
    expect((await start("gmail")).statusCode).toBe(200);
    await below.app.close();
    const full = await appWithPlan(plan, { EMAIL_ACCOUNTS: max }, { users: [owner], config: { google } });
    full.repos.emailAccounts.list.mockResolvedValue([]);
    expectLimit(await start("gmail"), "EMAIL_ACCOUNTS", max, plan);
  });
});

describe("e-mail accounts: OAuth callback re-checks the plan", () => {
  const owner = makeUser({ [ORG_A]: "OWNER" });
  const tokenFetch = () =>
    vi.fn(async (url: string) =>
      url.includes("/token")
        ? new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }), { status: 200 })
        : url.includes("graph.microsoft.com")
          ? new Response(JSON.stringify({ id: "ms-id", mail: "me@contoso.com", userPrincipalName: "me@contoso.com", displayName: "Me" }), { status: 200 })
          : new Response(JSON.stringify({ emailAddress: "Me@Gmail.com", historyId: "555" }), { status: 200 })
    );

  async function callback(plan: OrganizationPlan, provider: "GMAIL" | "MICROSOFT", usage: Partial<Record<PlanUsageKey, number>> = {}) {
    const fetch = tokenFetch();
    const context = await appWithPlan(plan, usage, {
      users: [owner],
      fetch: fetch as unknown as typeof globalThis.fetch,
      config: { google, microsoft: MICROSOFT_OAUTH }
    });
    context.privileged.getMemberRole.mockResolvedValue("OWNER");
    context.privileged.upsertOAuthEmailAccount.mockResolvedValue({ account: { id: "acc-new", emailAddress: "me@gmail.com" }, created: true });
    const state = createOAuthState({ userId: owner.id, organizationId: ORG_A, provider }, context.deps.config.oauthStateSecret);
    const slug = provider === "GMAIL" ? "gmail" : "microsoft";
    const send = () => context.app.inject({ method: "GET", url: `/api/oauth/${slug}/callback?code=abc&state=${encodeURIComponent(state)}` });
    return { ...context, fetch, send };
  }

  it("BASIC: Microsoft is refused before the code is exchanged; nothing is stored", async () => {
    const { send, fetch, privileged } = await callback("BASIC", "MICROSOFT");
    const response = await send();
    expect(response.headers.location).toContain("oauth=error&reason=plan_feature");
    expect(fetch).not.toHaveBeenCalled();
    expect(privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });

  it("PRO: Microsoft connects", async () => {
    const { send, privileged } = await callback("PRO", "MICROSOFT");
    expect((await send()).headers.location).toContain("oauth=connected");
    expect(privileged.upsertOAuthEmailAccount).toHaveBeenCalled();
  });

  it("BASIC with 25 counted mailboxes: a NEW mailbox (the 26th) is refused and the tokens are not stored", async () => {
    const { send, privileged } = await callback("BASIC", "GMAIL", { EMAIL_ACCOUNTS: 25 });
    const response = await send();
    expect(response.headers.location).toContain("oauth=error&reason=plan_limit");
    expect(privileged.findOAuthEmailAccountStatus).toHaveBeenCalledWith(ORG_A, "GMAIL", "me@gmail.com");
    expect(privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });

  it("BASIC with 25 counted mailboxes: re-authorizing one of them is allowed", async () => {
    const { send, privileged } = await callback("BASIC", "GMAIL", { EMAIL_ACCOUNTS: 25 });
    privileged.findOAuthEmailAccountStatus.mockResolvedValue("ERROR");
    expect((await send()).headers.location).toContain("oauth=connected");
    expect(privileged.getOrganizationUsage).not.toHaveBeenCalled();
    expect(privileged.upsertOAuthEmailAccount).toHaveBeenCalled();
  });

  it("reconnecting a DISCONNECTED mailbox counts again, so it needs room", async () => {
    const { send, privileged } = await callback("BASIC", "GMAIL", { EMAIL_ACCOUNTS: 25 });
    privileged.findOAuthEmailAccountStatus.mockResolvedValue("DISCONNECTED");
    expect((await send()).headers.location).toContain("reason=plan_limit");
    expect(privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });

  it("BASIC below the limit: a new Gmail mailbox connects", async () => {
    const { send, privileged } = await callback("BASIC", "GMAIL", { EMAIL_ACCOUNTS: 1 });
    expect((await send()).headers.location).toContain("oauth=connected");
    expect(privileged.getOrganizationUsage).toHaveBeenCalledWith(ORG_A, ["EMAIL_ACCOUNTS"]);
  });

  it.each([
    ["BASIC", 25],
    ["PRO", 125],
    ["BUSINESS", 250]
  ] as const)("%s: a new mailbox number %d connects, the next one is refused", async (plan, max) => {
    const below = await callback(plan, "GMAIL", { EMAIL_ACCOUNTS: max - 1 });
    expect((await below.send()).headers.location).toContain("oauth=connected");
    expect(below.privileged.upsertOAuthEmailAccount).toHaveBeenCalledTimes(1);
    await below.app.close();
    const full = await callback(plan, "GMAIL", { EMAIL_ACCOUNTS: max });
    expect((await full.send()).headers.location).toContain("oauth=error&reason=plan_limit");
    expect(full.privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });

  it.each([["plan not readable", null], ["no active subscription", noAccess()], ["suspended subscription", noAccess("SUSPENDED")]])("%s: refused before the code is exchanged", async (_label, entitlements) => {
    const { send, privileged, fetch } = await callback("BASIC", "GMAIL");
    privileged.getOrganizationEntitlements.mockResolvedValue(entitlements);
    expect((await send()).headers.location).toContain("reason=subscription_required");
    expect(fetch).not.toHaveBeenCalled();
    expect(privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });
});

describe("existing data is never touched by the plan", () => {
  it("listing, pausing and disconnecting mailboxes work above the limit (legacy FREE with Microsoft)", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await appWithPlan("FREE", { EMAIL_ACCOUNTS: 30 }, { users: [owner] });
    const microsoft = mailbox({ provider: "MICROSOFT", emailAddress: "me@contoso.com" });
    repos.emailAccounts.list.mockResolvedValue([microsoft]);
    repos.emailAccounts.get.mockResolvedValue(microsoft);
    repos.emailAccounts.update.mockResolvedValue({ ...microsoft, status: "PAUSED" });

    expect((await app.inject({ method: "GET", url: "/api/email-accounts", headers: authHeaders(owner, ORG_A) })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/email-accounts/${ID}`, headers: authHeaders(owner, ORG_A), payload: { status: "PAUSED" } })).statusCode).toBe(200);
    expect(repos.plans.entitlements).not.toHaveBeenCalled();
  });

  it("the approved catalog fixture matches the features table of the plan", () => {
    expect(V1_FEATURES.BASIC.MICROSOFT).toBe(false);
    expect(V1_FEATURES.PRO.API).toBe(false);
    expect(V1_FEATURES.BUSINESS.API).toBe(true);
  });
});

/* ------------------------------------------------------------------ Commercial V1.1: no free use */

describe("an organization without an active subscription (new, suspended, canceled, expired)", () => {
  const owner = makeUser({ [ORG_A]: "OWNER" });
  const validRule = {
    name: "Netflix codes",
    conditions: [{ field: "sender", operator: "contains", value: "netflix.com" }],
    actions: [{ type: "EXTRACT", name: "verification_code", preset: "verification_code" }]
  };

  async function appWithoutAccess(status: "SUSPENDED" | "CANCELED" | "EXPIRED" | null = null) {
    ctx = await createTestApp({ users: [owner], config: { google, microsoft: MICROSOFT_OAUTH } });
    ctx.repos.plans.entitlements.mockResolvedValue(noAccess(status));
    return ctx;
  }

  it.each([null, "SUSPENDED", "CANCELED", "EXPIRED"] as const)("subscription %s: every commercial action is refused with SUBSCRIPTION_REQUIRED", async (status) => {
    const { app, repos } = await appWithoutAccess(status);
    const headers = authHeaders(owner, ORG_A);
    repos.customers.get.mockResolvedValue({ id: ID, organizationId: ORG_A, displayName: "Juan", status: "ACTIVE" });
    const attempts = [
      app.inject({ method: "POST", url: "/api/email-accounts/oauth/gmail/start", headers }),
      app.inject({ method: "POST", url: "/api/rules", headers, payload: validRule }),
      app.inject({ method: "POST", url: "/api/bots", headers, payload: { name: "Netflix" } }),
      app.inject({ method: "POST", url: "/api/customers", headers, payload: { displayName: "Juan" } }),
      app.inject({ method: "POST", url: "/api/organizations/current/members", headers, payload: { email: "a@example.com", role: "VIEWER" } }),
      app.inject({ method: "POST", url: `/api/customers/${ID}/access`, headers, payload: {} })
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({ code: "SUBSCRIPTION_REQUIRED", details: { subscriptionStatus: status } });
    }
    expect(repos.rules.create).not.toHaveBeenCalled();
    expect(repos.bots.create).not.toHaveBeenCalled();
    expect(repos.customers.create).not.toHaveBeenCalled();
    expect(repos.members.add).not.toHaveBeenCalled();
    expect(repos.customerAccess.issue).not.toHaveBeenCalled();
  });

  it("nothing is deleted or hidden: existing data stays readable and manageable (pause, disconnect)", async () => {
    const { app, repos } = await appWithoutAccess("EXPIRED");
    const gmail = mailbox();
    repos.emailAccounts.list.mockResolvedValue([gmail]);
    repos.emailAccounts.get.mockResolvedValue(gmail);
    repos.emailAccounts.update.mockResolvedValue({ ...gmail, status: "PAUSED" });
    repos.rules.list.mockResolvedValue([]);
    const headers = authHeaders(owner, ORG_A);
    expect((await app.inject({ method: "GET", url: "/api/email-accounts", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/rules", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/email-accounts/${ID}`, headers, payload: { status: "PAUSED" } })).statusCode).toBe(200);
  });

  it("GET /api/organizations/current/plan explains it: access NONE and the last subscription", async () => {
    const { app, repos } = await appWithoutAccess("CANCELED");
    repos.plans.subscription.mockResolvedValue({
      status: "CANCELED",
      plan: "PRO",
      billingPeriod: "MONTHLY",
      currency: "PEN",
      amount: "39.90",
      paymentMethod: "YAPE",
      startedAt: "2026-10-06T05:00:00.000Z",
      currentPeriodStart: "2026-10-06T05:00:00.000Z",
      currentPeriodEnd: "2026-11-06T05:00:00.000Z",
      canceledAt: "2026-10-10T05:00:00.000Z",
      suspendedAt: null,
      expiredAt: null
    });
    const response = await app.inject({ method: "GET", url: "/api/organizations/current/plan", headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(200);
    expect(response.json().entitlements).toMatchObject({ access: "NONE", effectivePlan: null, subscriptionStatus: "CANCELED" });
    expect(response.json().subscription).toMatchObject({ status: "CANCELED", plan: "PRO", amount: "39.90", paymentMethod: "YAPE" });
  });

  it("a member can never activate or change a subscription: there is no such member route", async () => {
    const { app } = await appWithoutAccess();
    const headers = authHeaders(owner, ORG_A);
    for (const [method, url] of [
      ["POST", "/api/organizations/current/subscription"],
      ["POST", "/api/organizations/current/subscription/activate"],
      ["PATCH", "/api/organizations/current/plan"],
      ["PATCH", "/api/organizations/current"]
    ] as const) {
      const response = await app.inject({ method, url, headers, payload: { plan: "BUSINESS", status: "ACTIVE", currentPeriodEnd: "2099-01-01T00:00:00Z" } });
      expect(response.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("Commercial V1.2: closing the remaining entry points", () => {
  const owner = makeUser({ [ORG_A]: "OWNER" });

  it("manual sync of a mailbox without an active subscription -> 403 SUBSCRIPTION_REQUIRED, nothing queued", async () => {
    ctx = await createTestApp({ users: [owner] });
    ctx.repos.plans.entitlements.mockResolvedValue(noAccess("EXPIRED"));
    ctx.repos.emailAccounts.get.mockResolvedValue(mailbox());
    const response = await ctx.app.inject({ method: "POST", url: `/api/email-accounts/${ID}/sync`, headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "SUBSCRIPTION_REQUIRED", details: { subscriptionStatus: "EXPIRED" } });
    expect(ctx.queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("manual sync with an active subscription is queued as before", async () => {
    ctx = await createTestApp({ users: [owner] });
    ctx.repos.emailAccounts.get.mockResolvedValue(mailbox());
    expect((await ctx.app.inject({ method: "POST", url: `/api/email-accounts/${ID}/sync`, headers: authHeaders(owner, ORG_A) })).statusCode).toBe(202);
    expect(ctx.queue.enqueueEmailEvent).toHaveBeenCalledTimes(1);
  });

  it("portal login refused for lack of subscription answers exactly like any other failure (no enumeration) and is audited", async () => {
    ctx = await createTestApp({ users: [owner] });
    const headers = { "content-type": "application/json", origin: ctx.deps.config.webAppUrl };
    const login = () => ctx!.app.inject({ method: "POST", url: "/api/portal/session", headers, payload: JSON.stringify({ accessId: "SP-7KQ9X82MP4Z7" }) });
    ctx.privileged.createPortalSession.mockResolvedValue({ outcome: "INVALID", organizationId: null, customerId: null });
    const invalid = await login();
    ctx.privileged.createPortalSession.mockResolvedValue({ outcome: "SUBSCRIPTION_INACTIVE", organizationId: ORG_A, customerId: ID });
    const inactive = await login();
    expect(inactive.statusCode).toBe(invalid.statusCode);
    expect(inactive.json().error.code).toBe(invalid.json().error.code);
    expect(inactive.headers["set-cookie"]).toBeUndefined();
    await vi.waitFor(() =>
      expect(ctx!.privileged.insertAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_A, action: "FAIL", metadata: expect.objectContaining({ reason: "SUBSCRIPTION_INACTIVE" }) })
      )
    );
  });

  it("an API refusal is logged as subscription.access_denied (organization, status, operation; no content)", async () => {
    const lines: string[] = [];
    ctx = await createTestApp({ users: [owner] });
    const { buildApp } = await import("../app.js");
    const app = await buildApp(ctx.deps, { logger: { level: "info", stream: { write: (line: string) => void lines.push(line) } } });
    ctx.repos.plans.entitlements.mockResolvedValue(noAccess("SUSPENDED"));
    const response = await app.inject({ method: "POST", url: "/api/bots", headers: authHeaders(owner, ORG_A), payload: { name: "Netflix" } });
    expect(response.statusCode).toBe(403);
    const denied = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "subscription.access_denied");
    expect(denied).toMatchObject({ organizationId: ORG_A, subscriptionStatus: "SUSPENDED", operation: "POST /api/bots", reason: "no_active_subscription" });
    expect(JSON.stringify(denied)).not.toMatch(/authorization|token|Netflix/i);
    await app.close();
  });
});
