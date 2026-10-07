import type { AdminOrganizationDetail } from "@emailbot/types";
import { afterEach, describe, expect, it } from "vitest";
import { fromDatabaseError } from "../lib/errors.js";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";

/*
 * Commercial V1.1: subscriptions administered by the Super Admin (manual
 * payments). The admin.* / private.* SQL (state machine, idempotency, plan
 * cache, audit) is covered by packages/database/test/subscriptions.test.ts;
 * here: who may call, what is validated and what reaches the database.
 */

const SUB = "66666666-6666-4666-8666-666666666666";
const owner = makeUser({ [ORG_A]: "OWNER" });
const platformAdmin = makeUser({});

const organization: AdminOrganizationDetail = {
  id: ORG_A,
  name: "Org A",
  slug: "org-a",
  plan: "PRO",
  status: "ACTIVE",
  owner: null,
  membersCount: 1,
  botsCount: 0,
  customersCount: 0,
  emailAccountsCount: 0,
  processedEmailsCount: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  rulesCount: 0,
  emailsCount: 0,
  deliveriesCount: 0
};

const activation = {
  plan: "PRO",
  billingPeriod: "MONTHLY",
  paymentMethod: "YAPE",
  amount: "39.90",
  periodStart: "2026-10-06T00:00:00-05:00",
  periodEnd: "2026-11-06T00:00:00-05:00",
  reference: "OP-123456",
  note: "Pago por Yape"
};

let ctx: Awaited<ReturnType<typeof createTestApp>> | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function setup() {
  ctx = await createTestApp({ users: [owner, platformAdmin], platformAdmins: [platformAdmin.id] });
  ctx.admin.getOrganization.mockResolvedValue(organization);
  return ctx;
}

const send = (method: "GET" | "POST", url: string, user = platformAdmin, payload?: unknown) =>
  ctx!.app.inject({ method, url, headers: authHeaders(user), ...(payload === undefined ? {} : { payload: payload as object }) });

describe("only the Super Admin administers subscriptions", () => {
  it.each([
    ["GET", "/api/admin/plan-prices"],
    ["GET", `/api/admin/organizations/${ORG_A}/subscription`],
    ["POST", `/api/admin/organizations/${ORG_A}/subscription/activate`],
    ["POST", `/api/admin/subscriptions/${SUB}/suspend`],
    ["POST", `/api/admin/subscriptions/${SUB}/reactivate`],
    ["POST", `/api/admin/subscriptions/${SUB}/cancel`],
    ["POST", `/api/admin/subscriptions/${SUB}/expire`]
  ] as const)("an organization OWNER gets 403 on %s %s and nothing reaches the database", async (method, url) => {
    const { admin } = await setup();
    const response = await send(method, url, owner, method === "POST" ? activation : undefined);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
    expect(admin.activateSubscription).not.toHaveBeenCalled();
    expect(admin.updateSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("anonymous -> 401", async () => {
    await setup();
    expect((await ctx!.app.inject({ method: "POST", url: `/api/admin/organizations/${ORG_A}/subscription/activate`, payload: activation })).statusCode).toBe(401);
  });
});

describe("reading", () => {
  it("GET /api/admin/plan-prices lists the active catalog prices", async () => {
    const { admin } = await setup();
    const prices = [{ id: SUB, plan: "PRO", planName: "Pro", billingPeriod: "MONTHLY", currency: "PEN", amount: "39.90", amountCents: 3990 }];
    admin.listPlanPrices.mockResolvedValue(prices);
    const response = await send("GET", "/api/admin/plan-prices");
    expect(response.json()).toEqual({ items: prices });
    expect(admin.listPlanPrices).toHaveBeenCalledWith(platformAdmin.id);
  });

  it("GET /api/admin/organizations/:id/subscription returns subscriptions and payments; unknown organization -> 404", async () => {
    const { admin } = await setup();
    admin.listSubscriptions.mockResolvedValue([{ id: SUB, status: "ACTIVE" }]);
    admin.listPaymentEvents.mockResolvedValue([{ id: "e1", amount: "39.90" }]);
    const response = await send("GET", `/api/admin/organizations/${ORG_A}/subscription`);
    expect(response.json()).toEqual({ subscriptions: [{ id: SUB, status: "ACTIVE" }], paymentEvents: [{ id: "e1", amount: "39.90" }] });
    expect(admin.listPaymentEvents).toHaveBeenCalledWith(platformAdmin.id, ORG_A, 25);

    admin.getOrganization.mockResolvedValue(null);
    expect((await send("GET", `/api/admin/organizations/${SUB}/subscription`)).statusCode).toBe(404);
  });
});

describe("manual activation (YAPE / CASH / TRANSFER / MANUAL)", () => {
  it.each(["YAPE", "CASH", "TRANSFER", "MANUAL"])("%s reaches the single activation core with the decimal amount as a string", async (paymentMethod) => {
    const { admin } = await setup();
    admin.activateSubscription.mockResolvedValue({ subscriptionId: SUB, outcome: "ACTIVATED" });
    const response = await send("POST", `/api/admin/organizations/${ORG_A}/subscription/activate`, platformAdmin, { ...activation, paymentMethod });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ subscriptionId: SUB, outcome: "ACTIVATED", organization: { id: ORG_A, plan: "PRO" } });
    expect(admin.activateSubscription).toHaveBeenCalledWith(platformAdmin.id, ORG_A, { ...activation, paymentMethod }, expect.any(String));
  });

  it.each(["BASIC", "PRO", "BUSINESS"])("plan %s, monthly or yearly", async (plan) => {
    const { admin } = await setup();
    admin.activateSubscription.mockResolvedValue({ subscriptionId: SUB, outcome: "PLAN_CHANGED" });
    for (const billingPeriod of ["MONTHLY", "YEARLY"]) {
      const response = await send("POST", `/api/admin/organizations/${ORG_A}/subscription/activate`, platformAdmin, { ...activation, plan, billingPeriod });
      expect(response.statusCode).toBe(200);
    }
    expect(admin.activateSubscription).toHaveBeenCalledTimes(2);
  });

  it("the same payment reference twice -> 409 PAYMENT_ALREADY_RECORDED (nothing changed)", async () => {
    const { admin } = await setup();
    admin.activateSubscription.mockResolvedValue({ subscriptionId: SUB, outcome: "DUPLICATE" });
    const response = await send("POST", `/api/admin/organizations/${ORG_A}/subscription/activate`, platformAdmin, activation);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PAYMENT_ALREADY_RECORDED");
  });

  it.each([
    ["CULQI is never manual", { paymentMethod: "CULQI" }],
    ["FREE is not a plan", { plan: "FREE" }],
    ["amount as a float number", { amount: 39.9 }],
    ["amount with 3 decimals", { amount: "39.901" }],
    ["zero amount", { amount: "0" }],
    ["negative amount", { amount: "-39.90" }],
    ["end before start", { periodEnd: "2026-10-01T00:00:00-05:00" }],
    ["date without offset", { periodStart: "2026-10-06" }],
    ["a forged status", { status: "ACTIVE" }],
    ["a forged price", { planPriceId: SUB }],
    ["a forged period end field", { currentPeriodEnd: "2099-01-01T00:00:00Z" }]
  ])("rejects %s with 400 and nothing reaches the database", async (_label, change) => {
    const { admin } = await setup();
    const response = await send("POST", `/api/admin/organizations/${ORG_A}/subscription/activate`, platformAdmin, { ...activation, ...change });
    expect(response.statusCode).toBe(400);
    expect(admin.activateSubscription).not.toHaveBeenCalled();
  });

  it("a database business rule (e.g. inactive price, ended period) -> 422 with its message", async () => {
    const { admin } = await setup();
    admin.activateSubscription.mockRejectedValue(fromDatabaseError({ code: "P0001", message: "The period has already ended" }));
    const response = await send("POST", `/api/admin/organizations/${ORG_A}/subscription/activate`, platformAdmin, activation);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toBe("The period has already ended");
  });
});

describe("status changes", () => {
  it.each(["suspend", "reactivate", "cancel", "expire"])("%s goes through the audited status function", async (action) => {
    const { admin } = await setup();
    admin.updateSubscriptionStatus.mockResolvedValue({ subscriptionId: SUB, organizationId: ORG_A, status: "SUSPENDED" });
    const response = await send("POST", `/api/admin/subscriptions/${SUB}/${action}`, platformAdmin, { reason: "Falta de pago" });
    expect(response.statusCode).toBe(200);
    expect(admin.updateSubscriptionStatus).toHaveBeenCalledWith(platformAdmin.id, SUB, action, "Falta de pago", expect.any(String));
    expect(response.json().organization.id).toBe(ORG_A);
  });

  it("unknown action -> 400; unknown subscription -> 404; extra fields -> 400", async () => {
    const { admin } = await setup();
    expect((await send("POST", `/api/admin/subscriptions/${SUB}/delete`, platformAdmin, {})).statusCode).toBe(400);
    expect((await send("POST", `/api/admin/subscriptions/${SUB}/suspend`, platformAdmin, { status: "ACTIVE" })).statusCode).toBe(400);
    admin.updateSubscriptionStatus.mockResolvedValue(null);
    expect((await send("POST", `/api/admin/subscriptions/${SUB}/cancel`, platformAdmin, {})).statusCode).toBe(404);
  });
});
