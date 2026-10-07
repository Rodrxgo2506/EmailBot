import type { BillingSubscriptionSummary, CommercialPlan, OrganizationSubscriptionSummary } from "@emailbot/types";
import { describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../config/env.js";
import { loadConfig } from "../config/env.js";
import { decideCheckout } from "../modules/billing/policy.js";
import type { BillingPrice } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";
import { entitlementsFor, noAccess } from "./plan-fixtures.js";

/*
 * Commercial V1 phase 2: Culqi recurring subscriptions, SANDBOX ONLY.
 * The browser sends plan + period + card token; the price comes from the
 * EmailBot catalog and must match the Culqi plan; access is granted later by
 * the worker on a confirmed payment. Webhooks only enqueue (event id).
 */

const SECRET = "sk_test_SECRETkey1234567890";
const PUBLIC = "pk_test_PUBLICkey123456";
const CULQI: NonNullable<ApiConfig["culqi"]> = { secretKey: SECRET, publicKey: PUBLIC, apiUrl: "https://culqi.test", webhookToken: null };
const ORDER: Record<CommercialPlan, number> = { BASIC: 1, PRO: 2, BUSINESS: 3 };
const PRICES: Record<CommercialPlan, { amount: string; cents: number }> = {
  BASIC: { amount: "19.90", cents: 1990 },
  PRO: { amount: "39.90", cents: 3990 },
  BUSINESS: { amount: "89.90", cents: 8990 }
};
const price = (plan: CommercialPlan, billingPeriod: "MONTHLY" | "YEARLY" = "MONTHLY"): BillingPrice => ({
  planPriceId: `price-${plan}-${billingPeriod}`,
  plan,
  planName: plan === "BASIC" ? "Básico" : plan === "PRO" ? "Pro" : "Business",
  billingPeriod,
  currency: "PEN",
  amount: PRICES[plan].amount,
  amountCents: PRICES[plan].cents,
  sortOrder: ORDER[plan]
});
const summary = (overrides: Partial<BillingSubscriptionSummary> = {}): BillingSubscriptionSummary => ({
  id: "bill-1",
  status: "PENDING",
  plan: "PRO",
  billingPeriod: "MONTHLY",
  environment: "test",
  createdAt: "2026-10-07T12:00:00.000Z",
  activatedAt: null,
  currentPeriodEnd: null,
  canceledAt: null,
  cancelReason: null,
  failureCode: null,
  failureMessage: null,
  ...overrides
});
const subscriptionBy = (paymentMethod: OrganizationSubscriptionSummary["paymentMethod"], plan: CommercialPlan = "PRO"): OrganizationSubscriptionSummary => ({
  status: "ACTIVE",
  plan,
  billingPeriod: "MONTHLY",
  currency: "PEN",
  amount: PRICES[plan].amount,
  paymentMethod,
  startedAt: "2026-10-01T00:00:00.000Z",
  currentPeriodStart: "2026-10-01T00:00:00.000Z",
  currentPeriodEnd: "2026-11-01T00:00:00.000Z",
  canceledAt: null,
  suspendedAt: null,
  expiredAt: null
});

const BODY = {
  plan: "PRO",
  billingPeriod: "MONTHLY",
  tokenId: "tkn_test_TOKEN0000000001",
  acceptTerms: true,
  customer: { firstName: "Ana", lastName: "Pérez", phoneNumber: "999888777", address: "Av. Lima 123", addressCity: "Lima", countryCode: "PE" }
};

/** Culqi fake routed by method + path; records every call. */
function culqiFake(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Array<{ key: string; body: unknown; authorization: string | null }> = [];
  const defaults: Record<string, { status: number; body: unknown }> = {
    "GET /v2/recurrent/plans/pln_test_PROMONTHLY": { status: 200, body: { id: "pln_test_PROMONTHLY", amount: 3990, currency: "PEN", interval_unit_time: 3 } },
    "POST /v2/customers": { status: 201, body: { id: "cus_test_CUSTOMER1" } },
    "POST /v2/cards": { status: 201, body: { id: "crd_test_CARD1" } },
    "POST /v2/recurrent/subscriptions/create": { status: 201, body: { id: "sxn_test_SUB1", status: 1 } }
  };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? "GET"} ${pathname}`;
    calls.push({ key: `${key}${search}`, body: init.body ? JSON.parse(String(init.body)) : undefined, authorization: (init.headers as Record<string, string>).Authorization ?? null });
    const response = overrides[key] ?? defaults[key] ?? { status: 404, body: { object: "error" } };
    return new Response(JSON.stringify(response.body), { status: response.status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

async function setup(options: { culqi?: ApiConfig["culqi"]; role?: "OWNER" | "ADMIN" | "VIEWER"; fetch?: typeof globalThis.fetch } = {}) {
  const user = makeUser({ [ORG_A]: options.role ?? "OWNER" });
  const context = await createTestApp({
    users: [user],
    config: { culqi: options.culqi === undefined ? CULQI : options.culqi },
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  const { billing, repos } = context;
  billing.resolvePrice.mockImplementation(async (plan: CommercialPlan, period: "MONTHLY" | "YEARLY") => price(plan, period));
  billing.planOrder.mockResolvedValue(ORDER);
  billing.hasPending.mockResolvedValue(false);
  billing.providerPlanId.mockImplementation(async (planPriceId: string) => `pln_test_${planPriceId.replace(/^price-|-/g, "")}`);
  billing.customerId.mockResolvedValue(null);
  billing.saveCustomer.mockImplementation(async (_org: string, _env: string, id: string) => id);
  billing.createPending.mockResolvedValue("bill-1");
  billing.attachCulqiSubscription.mockResolvedValue(undefined);
  billing.markFailed.mockResolvedValue(undefined);
  billing.get.mockResolvedValue(summary());
  repos.plans.entitlements.mockResolvedValue(noAccess());
  repos.plans.subscription.mockResolvedValue(null);
  return { ...context, user, headers: authHeaders(user, ORG_A) };
}

const checkout = (ctx: Awaited<ReturnType<typeof setup>>, plan: string, period = "MONTHLY") =>
  ctx.app.inject({ method: "GET", url: `/api/billing/checkout?plan=${plan}&billingPeriod=${period}`, headers: ctx.headers });
const subscribe = (ctx: Awaited<ReturnType<typeof setup>>, body: unknown = BODY) =>
  ctx.app.inject({ method: "POST", url: "/api/billing/subscriptions", headers: ctx.headers, payload: body as Record<string, unknown> });

describe("configuration: sandbox keys only", () => {
  const base = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", TOKEN_ENCRYPTION_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3)).toString("base64"), OAUTH_STATE_SECRET: "x".repeat(32) };

  it("disabled by default; enabled with an sk_test_ / pk_test_ pair", () => {
    expect(loadConfig(base).culqi).toBeNull();
    expect(loadConfig({ ...base, CULQI_SECRET_KEY: SECRET, CULQI_PUBLIC_KEY: PUBLIC }).culqi).toMatchObject({ secretKey: SECRET, publicKey: PUBLIC, apiUrl: "https://api.culqi.com" });
  });

  it.each([
    [{ CULQI_SECRET_KEY: "sk_live_SECRETkey1234567890", CULQI_PUBLIC_KEY: PUBLIC }, /CULQI_SECRET_KEY: live keys are not enabled/],
    [{ CULQI_SECRET_KEY: SECRET, CULQI_PUBLIC_KEY: "pk_live_PUBLICkey123456" }, /CULQI_PUBLIC_KEY: live keys are not enabled/],
    [{ CULQI_SECRET_KEY: SECRET }, /must be set together/],
    [{ CULQI_SECRET_KEY: PUBLIC, CULQI_PUBLIC_KEY: SECRET }, /must be a Culqi secret key/]
  ])("refuses %o", (extra, message) => {
    expect(() => loadConfig({ ...base, ...extra })).toThrow(message);
    expect(() => loadConfig({ ...base, ...extra })).not.toThrow(/sk_live_SECRETkey|pk_live_PUBLICkey/);
  });
});

describe("checkout policy (upgrades only)", () => {
  const decide = (current: CommercialPlan | null, target: CommercialPlan, paymentMethod: OrganizationSubscriptionSummary["paymentMethod"] | null = "CULQI", hasPending = false) =>
    decideCheckout({
      entitlements: current ? entitlementsFor(current) : noAccess(),
      subscription: current && paymentMethod ? subscriptionBy(paymentMethod, current) : null,
      target,
      order: ORDER,
      hasPending
    });

  it.each([
    ["BASIC", "PRO"],
    ["BASIC", "BUSINESS"],
    ["PRO", "BUSINESS"]
  ] as const)("%s -> %s is an upgrade", (from, to) => {
    expect(decide(from, to)).toEqual({ ok: true, kind: "upgrade" });
  });

  it("no commercial access: any plan is a purchase", () => {
    for (const plan of ["BASIC", "PRO", "BUSINESS"] as const) expect(decide(null, plan)).toEqual({ ok: true, kind: "purchase" });
  });

  it("no automatic downgrade; the same plan only to move a manual / legacy plan to card payments; one checkout at a time", () => {
    expect(decide("BUSINESS", "PRO")).toMatchObject({ ok: false, code: "DOWNGRADE_NOT_SUPPORTED" });
    expect(decide("PRO", "PRO", "CULQI")).toMatchObject({ ok: false, code: "PLAN_ALREADY_ACTIVE" });
    expect(decide("PRO", "PRO", "YAPE")).toEqual({ ok: true, kind: "purchase" });
    expect(decideCheckout({ entitlements: entitlementsFor("PRO", "LEGACY"), subscription: null, target: "PRO", order: ORDER, hasPending: false })).toEqual({ ok: true, kind: "purchase" });
    expect(decide("BASIC", "PRO", "CULQI", true)).toMatchObject({ ok: false, code: "CHECKOUT_IN_PROGRESS" });
  });
});

describe("GET /api/billing/config and /api/billing/checkout", () => {
  it("without Culqi configured: config disabled, checkout 503 BILLING_NOT_CONFIGURED", async () => {
    const ctx = await setup({ culqi: null });
    expect((await ctx.app.inject({ method: "GET", url: "/api/billing/config", headers: ctx.headers })).json()).toEqual({ enabled: false, environment: null });
    const response = await checkout(ctx, "PRO");
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("BILLING_NOT_CONFIGURED");
  });

  it("price resolved by the backend from the catalog; only the PUBLIC key reaches the browser", async () => {
    const ctx = await setup();
    expect((await ctx.app.inject({ method: "GET", url: "/api/billing/config", headers: ctx.headers })).json()).toEqual({ enabled: true, environment: "test" });
    const response = await checkout(ctx, "BUSINESS", "YEARLY");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      publicKey: PUBLIC,
      environment: "test",
      plan: "BUSINESS",
      planName: "Business",
      billingPeriod: "YEARLY",
      currency: "PEN",
      amount: "89.90",
      amountCents: 8990,
      kind: "purchase",
      customerEmail: ctx.user.email
    });
    expect(response.body).not.toContain(SECRET);
    expect(ctx.billing.resolvePrice).toHaveBeenCalledWith("BUSINESS", "YEARLY");
  });

  it("only OWNER / ADMIN (organization:update) can start a checkout; members can read the config", async () => {
    const ctx = await setup({ role: "VIEWER" });
    expect((await checkout(ctx, "PRO")).statusCode).toBe(403);
    expect((await subscribe(ctx)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: "/api/billing/config", headers: ctx.headers })).statusCode).toBe(200);
  });

  it("refuses a downgrade and a plan without a Culqi mapping", async () => {
    const ctx = await setup();
    ctx.repos.plans.entitlements.mockResolvedValue(entitlementsFor("BUSINESS"));
    ctx.repos.plans.subscription.mockResolvedValue(subscriptionBy("CULQI", "BUSINESS"));
    expect((await checkout(ctx, "PRO")).json().error.code).toBe("DOWNGRADE_NOT_SUPPORTED");

    const unmapped = await setup();
    unmapped.billing.providerPlanId.mockResolvedValue(null);
    const response = await checkout(unmapped, "PRO");
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("BILLING_PLAN_NOT_MAPPED");
  });

  it.each([
    ["BASIC", "PRO"],
    ["BASIC", "BUSINESS"],
    ["PRO", "BUSINESS"]
  ] as const)("upgrade %s -> %s is offered with the target plan's catalog price", async (from, to) => {
    const ctx = await setup();
    ctx.repos.plans.entitlements.mockResolvedValue(entitlementsFor(from));
    ctx.repos.plans.subscription.mockResolvedValue(subscriptionBy("CULQI", from));
    expect((await checkout(ctx, to)).json()).toMatchObject({ kind: "upgrade", plan: to, amountCents: PRICES[to].cents });
  });
});

describe("POST /api/billing/subscriptions", () => {
  it("token -> Culqi customer, card and subscription with the MAPPED plan; PENDING (202); reconciliation queued; audited", async () => {
    const culqi = culqiFake();
    const ctx = await setup({ fetch: culqi.fetch });
    const response = await subscribe(ctx);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ billingSubscription: summary() });
    expect(culqi.calls.map((call) => call.key)).toEqual([
      "GET /v2/recurrent/plans/pln_test_PROMONTHLY",
      "POST /v2/customers",
      "POST /v2/cards",
      "POST /v2/recurrent/subscriptions/create"
    ]);
    expect(culqi.calls.every((call) => call.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(culqi.calls[1]?.body).toMatchObject({ first_name: "Ana", last_name: "Pérez", email: ctx.user.email, country_code: "PE", metadata: { organization_id: ORG_A } });
    expect(culqi.calls[2]?.body).toMatchObject({ customer_id: "cus_test_CUSTOMER1", token_id: "tkn_test_TOKEN0000000001" });
    expect(culqi.calls[3]?.body).toEqual({ card_id: "crd_test_CARD1", plan_id: "pln_test_PROMONTHLY", tyc: true, metadata: { organization_id: ORG_A, billing_subscription_id: "bill-1" } });
    expect(ctx.billing.createPending).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A, planPriceId: "price-PRO-MONTHLY", externalPlanId: "pln_test_PROMONTHLY", environment: "test" }));
    expect(ctx.billing.attachCulqiSubscription).toHaveBeenCalledWith("bill-1", { externalCardId: "crd_test_CARD1", externalSubscriptionId: "sxn_test_SUB1", providerStatus: 1 });
    expect(ctx.queue.enqueueEmailEvent).toHaveBeenCalledWith({ type: "CULQI_RECONCILE", billingSubscriptionId: "bill-1" }, { jobId: "culqi-sync-bill-1" });
    // Nothing is activated here: access only changes when the worker confirms the payment.
    expect(ctx.privileged.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityType: "billing_subscription", metadata: expect.objectContaining({ event: "billing.checkout.started" }) }));
    expect(response.body).not.toContain(SECRET);
  });

  it.each([
    ["amount", { amount: 1 }],
    ["currency", { currency: "USD" }],
    ["limits", { limits: { EMAIL_ACCOUNTS: 999 } }],
    ["card data", { cardNumber: "4111111111111111", cvv: "123" }]
  ])("a client-sent %s is refused (400) before any Culqi call", async (_label, extra) => {
    const culqi = culqiFake();
    const ctx = await setup({ fetch: culqi.fetch });
    expect((await subscribe(ctx, { ...BODY, ...extra })).statusCode).toBe(400);
    expect(culqi.calls).toEqual([]);
  });

  it("a token is required (no token, no Culqi call)", async () => {
    const culqi = culqiFake();
    const ctx = await setup({ fetch: culqi.fetch });
    const { tokenId: _tokenId, ...withoutToken } = BODY;
    expect((await subscribe(ctx, withoutToken)).statusCode).toBe(400);
    expect(culqi.calls).toEqual([]);
  });

  it("the Culqi plan must match the EmailBot price: a mismatch stops before creating anything", async () => {
    const culqi = culqiFake({ "GET /v2/recurrent/plans/pln_test_PROMONTHLY": { status: 200, body: { id: "pln_test_PROMONTHLY", amount: 100, currency: "PEN", interval_unit_time: 3 } } });
    const ctx = await setup({ fetch: culqi.fetch });
    const response = await subscribe(ctx);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("BILLING_PLAN_MISMATCH");
    expect(culqi.calls.map((call) => call.key)).toEqual(["GET /v2/recurrent/plans/pln_test_PROMONTHLY"]);
    expect(ctx.billing.createPending).not.toHaveBeenCalled();
  });

  it("declined card: 402 PAYMENT_DECLINED, the checkout is marked FAILED, no subscription is created", async () => {
    const culqi = culqiFake({ "POST /v2/cards": { status: 402, body: { object: "error", type: "card_error", code: "card_declined", merchant_message: "Tarjeta rechazada" } } });
    const ctx = await setup({ fetch: culqi.fetch });
    const response = await subscribe(ctx);
    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({ code: "PAYMENT_DECLINED", details: { providerCode: "card_declined" } });
    expect(ctx.billing.markFailed).toHaveBeenCalledWith("bill-1", "card_declined", "Tarjeta rechazada", expect.any(String));
    expect(culqi.calls.map((call) => call.key)).not.toContain("POST /v2/recurrent/subscriptions/create");
  });

  it("a card that needs 3-D Secure: 422 THREE_DS_REQUIRED (not supported yet), checkout FAILED", async () => {
    const culqi = culqiFake({ "POST /v2/cards": { status: 200, body: { action_code: "REVIEW", user_message: "El usuario necesita autenticarse" } } });
    const ctx = await setup({ fetch: culqi.fetch });
    const response = await subscribe(ctx);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("THREE_DS_REQUIRED");
    expect(ctx.billing.markFailed).toHaveBeenCalledWith("bill-1", "three_ds_required", null, expect.any(String));
  });

  it("an existing Culqi customer of the organization is reused; Culqi down -> 502", async () => {
    const culqi = culqiFake({ "POST /v2/recurrent/subscriptions/create": { status: 503, body: { object: "error", type: "api_error" } } });
    const ctx = await setup({ fetch: culqi.fetch });
    ctx.billing.customerId.mockResolvedValue("cus_test_EXISTING");
    const response = await subscribe(ctx);
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("PAYMENT_PROVIDER_ERROR");
    expect(culqi.calls.map((call) => call.key)).not.toContain("POST /v2/customers");
    expect(culqi.calls.find((call) => call.key === "POST /v2/cards")?.body).toMatchObject({ customer_id: "cus_test_EXISTING" });
    expect(ctx.billing.markFailed).toHaveBeenCalled();
  });

  it("one checkout at a time (409 CHECKOUT_IN_PROGRESS)", async () => {
    const ctx = await setup({ fetch: culqiFake().fetch });
    ctx.billing.hasPending.mockResolvedValue(true);
    const response = await subscribe(ctx);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHECKOUT_IN_PROGRESS");
  });

  it("GET /api/billing/subscriptions/current returns the organization's latest Culqi subscription", async () => {
    const ctx = await setup();
    ctx.billing.current.mockResolvedValue(summary({ status: "ACTIVE" }));
    const response = await ctx.app.inject({ method: "GET", url: "/api/billing/subscriptions/current", headers: ctx.headers });
    expect(response.json()).toEqual({ billingSubscription: summary({ status: "ACTIVE" }) });
    expect(ctx.billing.current).toHaveBeenCalledWith(ORG_A);
  });
});

describe("POST /webhooks/culqi", () => {
  const EVT = "evt_test_0CjjdWhFpEAZlxlz";
  const post = (ctx: Awaited<ReturnType<typeof setup>>, body: unknown, query = "") =>
    ctx.app.inject({ method: "POST", url: `/webhooks/culqi${query}`, payload: body as Record<string, unknown> });

  it("valid event: recorded once and queued for the worker (only its id), 200", async () => {
    const ctx = await setup();
    ctx.billing.recordWebhookEvent.mockResolvedValue({ isNew: true, status: "RECEIVED", attempts: 0 });
    const response = await post(ctx, { object: "event", id: EVT, type: "subscription.charge.succeeded", data: "{\"amount\":1}" });
    expect(response.statusCode).toBe(200);
    expect(ctx.billing.recordWebhookEvent).toHaveBeenCalledWith("test", EVT);
    expect(ctx.queue.enqueueEmailEvent).toHaveBeenCalledWith({ type: "CULQI_EVENT", eventId: EVT }, { jobId: `culqi-evt-${EVT}` });
  });

  it("duplicate of a processed event: acknowledged, not queued again", async () => {
    const ctx = await setup();
    ctx.billing.recordWebhookEvent.mockResolvedValue({ isNew: false, status: "PROCESSED", attempts: 1 });
    const response = await post(ctx, { id: EVT });
    expect(response.json()).toEqual({ received: true, duplicate: true });
    expect(ctx.queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("redelivery of a FAILED event gets a new job", async () => {
    const ctx = await setup();
    ctx.billing.recordWebhookEvent.mockResolvedValue({ isNew: false, status: "FAILED", attempts: 3 });
    await post(ctx, { id: EVT });
    expect(ctx.queue.enqueueEmailEvent).toHaveBeenCalledWith({ type: "CULQI_EVENT", eventId: EVT }, { jobId: `culqi-evt-${EVT}-3` });
  });

  it("malformed body -> 400, nothing recorded; a live event in the sandbox -> acknowledged, never recorded", async () => {
    const ctx = await setup();
    expect((await post(ctx, { type: "subscription.charge.succeeded" })).statusCode).toBe(400);
    expect((await post(ctx, { id: "'; drop table x" })).statusCode).toBe(400);
    expect((await post(ctx, { id: "evt_live_0CjjdWhFpEAZlxlz" })).statusCode).toBe(200);
    expect(ctx.billing.recordWebhookEvent).not.toHaveBeenCalled();
    expect(ctx.queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("optional URL token (CULQI_WEBHOOK_TOKEN): required when configured", async () => {
    const token = "t".repeat(40);
    const ctx = await setup({ culqi: { ...CULQI, webhookToken: token } });
    ctx.billing.recordWebhookEvent.mockResolvedValue({ isNew: true, status: "RECEIVED", attempts: 0 });
    expect((await post(ctx, { id: EVT })).statusCode).toBe(401);
    expect((await post(ctx, { id: EVT }, "?token=wrong")).statusCode).toBe(401);
    expect((await post(ctx, { id: EVT }, `?token=${token}`)).statusCode).toBe(200);
  });

  it("Culqi not configured: the route does not exist (404); queue down -> 503 so Culqi retries", async () => {
    expect((await post(await setup({ culqi: null }), { id: EVT })).statusCode).toBe(404);
    const ctx = await setup();
    ctx.billing.recordWebhookEvent.mockResolvedValue({ isNew: true, status: "RECEIVED", attempts: 0 });
    ctx.queue.enqueueEmailEvent.mockRejectedValueOnce(new Error("redis down"));
    expect((await post(ctx, { id: EVT })).statusCode).toBe(503);
  });
});
