import { CulqiApiError, type CulqiCharge, type CulqiClient, type CulqiEvent, type CulqiPlan, type CulqiSubscription } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CULQI_PENDING_CONFIRMATION_TIMEOUT_MS,
  CULQI_PENDING_INCOMPLETE_TIMEOUT_MS,
  CULQI_RENEWAL_GRACE_MS,
  CulqiStillPendingError,
  expireStalePending,
  handleCulqiEvent,
  periodForCharge,
  reconcileCulqiSubscription,
  reconcileDueCulqiSubscriptions,
  syncCulqiSubscription,
  verifyCulqiCharge,
  verifyCulqiSubscription,
  type BillingDeps
} from "../pipeline/billing.js";
import { handleEmailEvent } from "../pipeline/handle-email-event.js";
import type { BillingStore, BillingSubscriptionRow, WebhookEventRow } from "../pipeline/ports.js";
import { silentLogger } from "./fakes.js";

/*
 * Commercial V1 phase 2 (Culqi sandbox), after the review (F1-F4):
 * only a charge verified with GET /v2/charges/{id} activates, keyed by its
 * charge id; the Culqi subscription must match EmailBot first; renewals and
 * stale checkouts are reconciled periodically through the SAME path.
 */

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY = 24 * 3600_000;
const SXN = "sxn_test_SUBSCRIPTION1";
const PLAN = "pln_test_PROMONTHLY0001";
const CARD = "crd_test_CARD00000001";
const CUSTOMER = "cus_test_CUSTOMER0001";
const EVT = "evt_test_EVENT0000000001";
const CHR = "chr_test_CHARGE00000001";

const row = (overrides: Partial<BillingSubscriptionRow> = {}): BillingSubscriptionRow => ({
  id: "bill-1",
  organizationId: "org-1",
  status: "PENDING",
  environment: "test",
  externalSubscriptionId: SXN,
  externalPlanId: PLAN,
  externalCustomerId: CUSTOMER,
  externalCardId: CARD,
  billingPeriod: "MONTHLY",
  amountCents: 3990,
  currency: "PEN",
  cancelReason: null,
  createdAt: new Date(NOW - DAY).toISOString(),
  ...overrides
});

const paidCharge = (overrides: Partial<CulqiCharge> = {}): CulqiCharge => ({
  id: CHR,
  amount: 3990,
  currency_code: "PEN",
  paid: true,
  creation_date: NOW - 60_000,
  outcome: { type: "venta_exitosa", code: "succesfull_charge" },
  source: { object: "card", id: CARD },
  ...overrides
});

/** In-memory store with the database's idempotency (one application per charge) and transitions. */
function makeStore(rows: BillingSubscriptionRow[], events: Record<string, WebhookEventRow> = {}) {
  const applied = new Set<string>();
  const failures = new Set<string>();
  const updates: Array<{ eventId: string; patch: Record<string, unknown> }> = [];
  const byId = (id: string) => rows.find((item) => item.id === id);
  const store = {
    rows,
    events,
    updates,
    applied,
    cancellations: [] as Array<{ id: string; externalSubscriptionId: string }>,
    stale: [] as BillingSubscriptionRow[],
    due: [] as BillingSubscriptionRow[],
    getWebhookEvent: vi.fn(async (eventId: string) => events[eventId] ?? null),
    updateWebhookEvent: vi.fn(async (eventId: string, patch: Record<string, unknown>) => {
      updates.push({ eventId, patch });
      const current = events[eventId];
      if (current && typeof patch.status === "string") current.status = patch.status as WebhookEventRow["status"];
    }),
    getBillingSubscription: vi.fn(async (id: string) => {
      const found = byId(id);
      return found ? { ...found } : null;
    }),
    findBillingSubscriptionByExternalId: vi.fn(async (sxn: string) => rows.find((item) => item.externalSubscriptionId === sxn) ?? null),
    activate: vi.fn(async (input: { billingSubscriptionId: string; activationKey: string; externalChargeId: string | null }) => {
      const target = byId(input.billingSubscriptionId);
      if (!target || target.status === "CANCELED" || target.status === "EXPIRED") return { outcome: "IGNORED", subscriptionId: null, supersededExternalIds: [] };
      if (applied.has(input.activationKey) || failures.has(input.activationKey)) return { outcome: "DUPLICATE", subscriptionId: "sub-1", supersededExternalIds: [] };
      applied.add(input.activationKey);
      const outcome = target.status === "PENDING" || target.status === "FAILED" ? "ACTIVATED" : "RENEWED";
      target.status = "ACTIVE";
      return { outcome, subscriptionId: "sub-1", supersededExternalIds: [] };
    }),
    recordChargeFailure: vi.fn(async (input: { billingSubscriptionId: string; externalEventId: string; externalChargeId: string | null }) => {
      const key = input.externalChargeId ?? input.externalEventId;
      if (failures.has(key) || applied.has(key)) return "DUPLICATE";
      failures.add(key);
      const target = byId(input.billingSubscriptionId);
      if (target) target.status = target.status === "ACTIVE" || target.status === "PAST_DUE" ? "PAST_DUE" : "FAILED";
      return "RECORDED";
    }),
    setStatus: vi.fn(async (input: { billingSubscriptionId: string; status: BillingSubscriptionRow["status"]; failureCode: string | null }) => {
      const target = byId(input.billingSubscriptionId);
      if (!target) return "IGNORED";
      if (target.status === input.status) return "UNCHANGED";
      if (target.status === "CANCELED" || target.status === "EXPIRED") return "IGNORED";
      target.status = input.status;
      return "CHANGED";
    }),
    listUnconfirmedCancellations: vi.fn(async () => store.cancellations.splice(0)),
    markProviderCanceled: vi.fn(async () => undefined),
    listDueForReconciliation: vi.fn(async () => store.due),
    listStalePending: vi.fn(async () => store.stale)
  };
  return store as typeof store & BillingStore;
}

interface CulqiOptions {
  subscription?: Partial<CulqiSubscription> | null;
  plan?: Partial<CulqiPlan> | null;
  charges?: Record<string, CulqiCharge | null>;
  event?: CulqiEvent | null;
  environment?: "test" | "live";
}

function makeCulqi(options: CulqiOptions = {}) {
  const subscription: CulqiSubscription | null =
    options.subscription === null
      ? null
      : { id: SXN, status: 3, current_period: 1, plan: { plan_id: PLAN }, metadata: { organization_id: "org-1", billing_subscription_id: "bill-1" }, ...(options.subscription ?? {}) };
  const plan: CulqiPlan | null = options.plan === null ? null : { id: PLAN, amount: 3990, currency: "PEN", interval_unit_time: 3, ...(options.plan ?? {}) };
  const charges = options.charges ?? {};
  return {
    environment: options.environment ?? "test",
    getEvent: vi.fn(async () => (options.event === undefined ? { id: EVT, type: "subscription.charge.succeeded", data: JSON.stringify({ subscription_id: SXN, charge_id: CHR }) } : options.event)),
    getSubscription: vi.fn(async () => subscription),
    getPlan: vi.fn(async () => plan),
    getCharge: vi.fn(async (id: string) => (id in charges ? charges[id] : null)),
    cancelSubscription: vi.fn(async () => true),
    createCustomer: vi.fn(),
    findCustomerByEmail: vi.fn(),
    createCard: vi.fn(),
    createPlan: vi.fn(),
    createSubscription: vi.fn()
  } as unknown as CulqiClient & Record<string, ReturnType<typeof vi.fn>>;
}

const deps = (store: BillingStore, culqi: CulqiClient | null): BillingDeps => ({ store, culqi, logger: silentLogger, now: () => NOW });
const culqiDeps = (store: BillingStore, culqi: CulqiClient) => ({ store, culqi, logger: silentLogger, now: () => NOW });
const received = (): Record<string, WebhookEventRow> => ({ [EVT]: { status: "RECEIVED", attempts: 0 } });
const NO_TRIGGER = { eventId: null, eventType: null, chargeIds: [] as string[] };

describe("F1: only a verified charge activates", () => {
  it("subscription.creation.succeeded without a charge: stays PENDING, nothing activated", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ event: { id: EVT, type: "subscription.creation.succeeded", data: { id: SXN } } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("pending");
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).toBe("PENDING");
    expect(store.updates.at(-1)?.patch).toMatchObject({ status: "PROCESSED", lastError: "NO_VERIFIED_CHARGE" });
  });

  it("Culqi status 3 without a charge: no activation; the reconciliation waits (retried)", async () => {
    const store = makeStore([row()]);
    await expect(reconcileCulqiSubscription("bill-1", deps(store, makeCulqi({ subscription: { status: 3 } })))).rejects.toBeInstanceOf(CulqiStillPendingError);
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("charge paid=true, succesfull_charge, catalog amount and currency, own card: ACTIVE, keyed by the charge id", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ charges: { [CHR]: paidCharge() } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("activated");
    expect(culqi.getCharge).toHaveBeenCalledWith(CHR);
    expect(store.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        billingSubscriptionId: "bill-1",
        activationKey: CHR,
        externalChargeId: CHR,
        eventType: "subscription.charge.succeeded",
        periodStart: new Date(NOW - 60_000).toISOString(),
        periodEnd: new Date(Date.parse("2026-11-07T11:59:00.000Z") + CULQI_RENEWAL_GRACE_MS).toISOString()
      })
    );
    expect(store.rows[0]?.status).toBe("ACTIVE");
  });

  it.each([
    ["paid=false", paidCharge({ paid: false, outcome: { code: "card_declined", decline_code: "insufficient_funds" } }), "DECLINED"],
    ["wrong amount", paidCharge({ amount: 100 }), "CHARGE_AMOUNT_MISMATCH"],
    ["wrong currency", paidCharge({ currency_code: "USD" }), "CHARGE_CURRENCY_MISMATCH"],
    ["no success outcome", paidCharge({ outcome: { code: "other" } }), "CHARGE_NOT_CONFIRMED"],
    ["another card", paidCharge({ source: { object: "card", id: "crd_test_OTHERCARD0001" } }), "CHARGE_CARD_MISMATCH"],
    ["another customer", paidCharge({ source: { object: "card", customer_id: "cus_test_OTHER" } }), "CHARGE_CUSTOMER_MISMATCH"],
    ["a live charge", paidCharge({ id: "chr_live_CHARGE00000001" }), "CHARGE_ID_MISMATCH"],
    ["not found at Culqi", null, "CHARGE_NOT_FOUND"]
  ] as const)("%s: never ACTIVE", async (_label, charge, expected) => {
    const store = makeStore([row()], received());
    await handleCulqiEvent(EVT, deps(store, makeCulqi({ charges: { [CHR]: charge } })));
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).not.toBe("ACTIVE");
    const verdict = verifyCulqiCharge(row(), CHR, charge, true);
    expect(verdict.kind === "REJECTED" ? verdict.reason : verdict.kind).toBe(expected);
  });

  it("a charge not listed in the subscription and not made with its card / customer is not linked", () => {
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ source: null }), false)).toEqual({ kind: "REJECTED", reason: "CHARGE_NOT_LINKED" });
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ source: null }), true)).toEqual({ kind: "PAID" });
  });

  it("declined first charge: recorded once (charge id), FAILED, the Culqi subscription is cancelled (cannot charge later)", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ event: { id: EVT, type: "subscription.charge.failed", data: { id: SXN, charge: CHR } }, subscription: { status: 5 }, charges: { [CHR]: paidCharge({ paid: false, outcome: { code: "card_declined" } }) } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("charge_failed");
    expect(store.recordChargeFailure).toHaveBeenCalledWith(expect.objectContaining({ externalEventId: CHR, externalChargeId: CHR, eventType: "subscription.charge.failed" }));
    expect(store.rows[0]?.status).toBe("FAILED");
    expect(culqi.cancelSubscription).toHaveBeenCalledWith(SXN);
    expect(store.markProviderCanceled).toHaveBeenCalledWith("bill-1");
  });

  it("the same charge from the webhook and from the reconciliation: one application", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ subscription: { periods: [{ charges: { charge_id: CHR } }] } as Partial<CulqiSubscription>, charges: { [CHR]: paidCharge() } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("activated");
    expect(await reconcileCulqiSubscription("bill-1", deps(store, culqi))).toBe("duplicate");
    const keys = store.activate.mock.calls.map(([input]) => (input as { activationKey: string }).activationKey);
    expect(keys).toEqual([CHR, CHR]);
    expect(store.applied.size).toBe(1);
  });

  it("a charge event that does not name its subscription is resolved through the charge itself", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi({
      event: { id: EVT, type: "charge.creation.succeeded", data: { id: CHR } },
      charges: { [CHR]: paidCharge({ metadata: { subscription_id: SXN } }) }
    });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("activated");
  });
});

describe("F2: the Culqi subscription must match EmailBot before anything is applied", () => {
  it.each([
    ["another plan", { subscription: { plan: { plan_id: "pln_test_OTHERPLAN000001" } } }, "PLAN_MISMATCH"],
    ["plan not reported", { subscription: { plan: null } }, "PLAN_NOT_REPORTED"],
    ["Culqi plan amount", { plan: { amount: 2990 } }, "PLAN_AMOUNT_MISMATCH"],
    ["Culqi plan currency", { plan: { currency: "USD" } }, "PLAN_CURRENCY_MISMATCH"],
    ["Culqi plan interval", { plan: { interval_unit_time: 4 } }, "PLAN_INTERVAL_MISMATCH"],
    ["Culqi plan missing", { plan: null }, "PLAN_NOT_FOUND"],
    ["another organization", { subscription: { metadata: { organization_id: "org-2", billing_subscription_id: "bill-1" } } }, "ORGANIZATION_MISMATCH"],
    ["another billing subscription", { subscription: { metadata: { organization_id: "org-1", billing_subscription_id: "bill-9" } } }, "BILLING_SUBSCRIPTION_MISMATCH"],
    ["another subscription id", { subscription: { id: "sxn_test_OTHERSUBSCRIPT1" } }, "SUBSCRIPTION_ID_MISMATCH"]
  ] as const)("%s -> rejected, nothing activated, event IGNORED with the reason", async (_label, options, reason) => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ ...(options as CulqiOptions), charges: { [CHR]: paidCharge() } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("ignored");
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.updates.at(-1)?.patch).toMatchObject({ status: "IGNORED", lastError: `REJECTED:${reason}` });
  });

  it("a subscription of another environment is rejected", () => {
    expect(verifyCulqiSubscription(row(), { id: SXN, status: 3, plan: { plan_id: PLAN } }, { id: PLAN, amount: 3990, currency: "PEN", interval_unit_time: 3 }, "live")).toEqual({ ok: false, reason: "ENVIRONMENT_MISMATCH" });
    expect(verifyCulqiSubscription(row({ externalSubscriptionId: "sxn_live_SUBSCRIPTION1" }), { id: "sxn_live_SUBSCRIPTION1", status: 3, plan: { plan_id: PLAN } }, null, "test")).toEqual({ ok: false, reason: "ENVIRONMENT_MISMATCH" });
  });

  it("an unknown subscription -> IGNORED (UNKNOWN_SUBSCRIPTION); a live event in the sandbox -> IGNORED without calling Culqi", async () => {
    const unknown = makeStore([], received());
    expect(await handleCulqiEvent(EVT, deps(unknown, makeCulqi({ charges: { [CHR]: paidCharge() } })))).toBe("ignored");
    expect(unknown.updates.at(-1)?.patch).toMatchObject({ lastError: "UNKNOWN_SUBSCRIPTION" });

    const live = "evt_live_EVENT0000000001";
    const store = makeStore([row()], { [live]: { status: "RECEIVED", attempts: 0 } });
    const culqi = makeCulqi();
    expect(await handleCulqiEvent(live, deps(store, culqi))).toBe("ignored");
    expect(culqi.getEvent).not.toHaveBeenCalled();
  });
});

describe("F3: periodic reconciliation (same application path)", () => {
  it("renewal: a new verified charge of an ACTIVE subscription extends it (RENEWED)", async () => {
    const renewal = paidCharge({ id: "chr_test_RENEWAL0000001", creation_date: NOW - 1000 });
    const store = makeStore([row({ status: "ACTIVE" })]);
    store.applied.add(CHR);
    const culqi = makeCulqi({ subscription: { periods: [{ charges: [{ charge_id: CHR }, { charge_id: renewal.id }] }] } as Partial<CulqiSubscription>, charges: { [CHR]: paidCharge({ creation_date: NOW - 31 * DAY }), [renewal.id]: renewal } });
    const result = await syncCulqiSubscription(row({ status: "ACTIVE" }), NO_TRIGGER, culqiDeps(store, culqi));
    expect(result.outcome).toBe("activated");
    const keys = store.activate.mock.calls.map(([input]) => (input as { activationKey: string }).activationKey);
    expect(keys).toEqual([CHR, renewal.id]); // oldest first; the first is a DUPLICATE
  });

  it("failed renewal: the declined charge is recorded once and the subscription becomes PAST_DUE (access unchanged by the database)", async () => {
    const declinedId = "chr_test_DECLINED000001";
    const store = makeStore([row({ status: "ACTIVE" })]);
    const culqi = makeCulqi({ subscription: { status: 5, periods: [{ charges: { charge_id: declinedId } }] } as Partial<CulqiSubscription>, charges: { [declinedId]: paidCharge({ id: declinedId, paid: false, outcome: { code: "card_declined" } }) } });
    expect((await syncCulqiSubscription(row({ status: "ACTIVE" }), NO_TRIGGER, culqiDeps(store, culqi))).outcome).toBe("charge_failed");
    expect(store.rows[0]?.status).toBe("PAST_DUE");
    expect(culqi.cancelSubscription).not.toHaveBeenCalled(); // a renewal failure is retried by Culqi
    expect((await syncCulqiSubscription(row({ status: "PAST_DUE" }), NO_TRIGGER, culqiDeps(store, culqi))).outcome).toBe("duplicate");
    expect(store.recordChargeFailure).toHaveBeenCalledTimes(2);
  });

  it("repeated reconciliation applies nothing twice", async () => {
    const store = makeStore([row()]);
    const culqi = makeCulqi({ subscription: { periods: [{ charges: { charge_id: CHR } }] } as Partial<CulqiSubscription>, charges: { [CHR]: paidCharge() } });
    expect((await syncCulqiSubscription(row(), NO_TRIGGER, culqiDeps(store, culqi))).outcome).toBe("activated");
    expect((await syncCulqiSubscription(row({ status: "ACTIVE" }), NO_TRIGGER, culqiDeps(store, culqi))).outcome).toBe("duplicate");
    expect((await syncCulqiSubscription(row({ status: "ACTIVE" }), NO_TRIGGER, culqiDeps(store, culqi))).outcome).toBe("duplicate");
    expect(store.applied.size).toBe(1);
  });

  it("out of order: a charge whose paid period already ended is not applied (nothing shortened)", async () => {
    const old = paidCharge({ id: "chr_test_OLDCHARGE000001", creation_date: NOW - 60 * DAY });
    const store = makeStore([row({ status: "ACTIVE" })]);
    const culqi = makeCulqi({ subscription: { periods: [{ charges: { charge_id: old.id } }] } as Partial<CulqiSubscription>, charges: { [old.id]: old } });
    expect((await syncCulqiSubscription(row({ status: "ACTIVE" }), NO_TRIGGER, culqiDeps(store, culqi))).outcome).toBe("duplicate");
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("status 3 alone during a periodic run: no activation of a PENDING row", async () => {
    const store = makeStore([row()]);
    expect((await syncCulqiSubscription(row(), NO_TRIGGER, culqiDeps(store, makeCulqi({ subscription: { status: 3 } })))).outcome).toBe("pending");
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("the periodic job reconciles the due subscriptions, closes stale checkouts and survives a failing one", async () => {
    const store = makeStore([row({ id: "bill-a", status: "ACTIVE" }), row({ id: "bill-b", status: "ACTIVE", externalSubscriptionId: "sxn_test_SUBSCRIPTION2" })]);
    store.due = [store.rows[0] as BillingSubscriptionRow, store.rows[1] as BillingSubscriptionRow];
    const culqi = makeCulqi({ subscription: { metadata: {} } });
    vi.mocked(culqi.getSubscription).mockImplementationOnce(async () => {
      throw new CulqiApiError(503, "api_error", null, null, "getSubscription");
    });
    const result = await reconcileDueCulqiSubscriptions(deps(store, culqi));
    expect(result).toEqual({ reconciled: 1, failed: 1, expired: 0 });
    expect(store.listDueForReconciliation).toHaveBeenCalledWith({
      endBefore: new Date(NOW + CULQI_RENEWAL_GRACE_MS + DAY).toISOString(),
      endAfter: new Date(NOW - 7 * DAY).toISOString(),
      limit: 100
    });
    expect(store.listStalePending).toHaveBeenCalledWith({
      withSubscriptionCreatedBefore: new Date(NOW - CULQI_PENDING_CONFIRMATION_TIMEOUT_MS).toISOString(),
      withoutSubscriptionCreatedBefore: new Date(NOW - CULQI_PENDING_INCOMPLETE_TIMEOUT_MS).toISOString(),
      limit: 100
    });
  });

  it("is reached through the email-events queue (CULQI_RECONCILE_DUE)", async () => {
    const store = makeStore([]);
    const outcome = await handleEmailEvent({ type: "CULQI_RECONCILE_DUE" }, { billing: { store, culqi: makeCulqi() }, logger: silentLogger, now: () => NOW } as never);
    expect(outcome).toEqual({ accounts: 0, enqueued: 0, billingReconcile: { reconciled: 0, expired: 0, failed: 0 } });
  });
});

describe("F4: stale PENDING checkouts", () => {
  it("old PENDING without a paid charge: cancelled at Culqi, then FAILED (confirmation_timeout)", async () => {
    const store = makeStore([row({ createdAt: new Date(NOW - 3 * DAY).toISOString() })]);
    const culqi = makeCulqi({ subscription: { status: 1 } });
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("expired_pending");
    expect(culqi.cancelSubscription).toHaveBeenCalledWith(SXN);
    expect(store.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", failureCode: "confirmation_timeout" }));
    expect(store.markProviderCanceled).toHaveBeenCalledWith("bill-1");
    expect(store.rows[0]?.status).toBe("FAILED");
  });

  it("a recent PENDING is not selected (the timeouts are passed to the store)", async () => {
    const store = makeStore([row({ createdAt: new Date(NOW - 60_000).toISOString() })]);
    const culqi = makeCulqi();
    const result = await reconcileDueCulqiSubscriptions(deps(store, culqi));
    expect(result.expired).toBe(0);
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(CULQI_PENDING_CONFIRMATION_TIMEOUT_MS).toBe(48 * 3600_000);
    expect(CULQI_PENDING_INCOMPLETE_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it("PENDING with a verified paid charge: activated, never cancelled", async () => {
    const store = makeStore([row({ createdAt: new Date(NOW - 3 * DAY).toISOString() })]);
    const culqi = makeCulqi({ subscription: { periods: [{ charges: { charge_id: CHR } }] } as Partial<CulqiSubscription>, charges: { [CHR]: paidCharge() } });
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("activated");
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).toBe("ACTIVE");
  });

  it("a charge that appears right before the cancellation still activates", async () => {
    const store = makeStore([row({ createdAt: new Date(NOW - 3 * DAY).toISOString() })]);
    const culqi = makeCulqi({ charges: { [CHR]: paidCharge() } });
    vi.mocked(culqi.getSubscription)
      .mockResolvedValueOnce({ id: SXN, status: 1, plan: { plan_id: PLAN }, metadata: {} })
      .mockResolvedValueOnce({ id: SXN, status: 3, plan: { plan_id: PLAN }, metadata: {}, periods: [{ charges: { charge_id: CHR } }] } as CulqiSubscription);
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("activated");
    expect(store.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ failureCode: "confirmation_timeout" }));
  });

  it("PENDING without a Culqi subscription id: FAILED (checkout_incomplete), no Culqi call", async () => {
    const store = makeStore([row({ externalSubscriptionId: null, createdAt: new Date(NOW - 3600_000).toISOString() })]);
    const culqi = makeCulqi();
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("expired_pending");
    expect(store.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", failureCode: "checkout_incomplete" }));
    expect(culqi.getSubscription).not.toHaveBeenCalled();
  });
});

describe("CULQI_EVENT basics", () => {
  it("duplicate delivery: an already processed event does nothing (no Culqi call)", async () => {
    const store = makeStore([row()], { [EVT]: { status: "PROCESSED", attempts: 1 } });
    const culqi = makeCulqi();
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("duplicate");
    expect(culqi.getEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["forged / unknown at Culqi (404)", { event: null }, "NOT_FOUND_AT_CULQI"],
    ["an event type EmailBot does not handle", { event: { id: EVT, type: "order.status.changed", data: {} } }, "UNHANDLED_EVENT_TYPE"],
    ["a malformed event (no type)", { event: { id: EVT, data: {} } as unknown as CulqiEvent }, "UNHANDLED_EVENT_TYPE"],
    ["no subscription anywhere", { event: { id: EVT, type: "charge.creation.succeeded", data: { id: "chr_test_X" } } }, "NO_SUBSCRIPTION"]
  ])("%s -> IGNORED, nothing applied", async (_label, options, reason) => {
    const store = makeStore([row()], received());
    expect(await handleCulqiEvent(EVT, deps(store, makeCulqi(options as CulqiOptions)))).toBe("ignored");
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.updates.at(-1)?.patch).toMatchObject({ status: "IGNORED", lastError: reason, processed: true });
  });

  it("Culqi unavailable: event FAILED with the error code and the job is retried (thrown)", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi();
    vi.mocked(culqi.getEvent).mockRejectedValueOnce(new CulqiApiError(503, "api_error", null, null, "getEvent"));
    await expect(handleCulqiEvent(EVT, deps(store, culqi))).rejects.toBeInstanceOf(CulqiApiError);
    expect(store.updates.at(-1)?.patch).toMatchObject({ status: "FAILED", lastError: "getEvent: HTTP 503 api_error" });
  });

  it("worker without CULQI_SECRET_KEY: FAILED (BILLING_NOT_CONFIGURED), no crash", async () => {
    const store = makeStore([row()], received());
    expect(await handleCulqiEvent(EVT, deps(store, null))).toBe("not_configured");
    expect(store.updates.at(-1)?.patch).toMatchObject({ status: "FAILED", lastError: "BILLING_NOT_CONFIGURED" });
  });

  it("is reached through the email-events queue (handleEmailEvent)", async () => {
    const store = makeStore([row()], received());
    const outcome = await handleEmailEvent({ type: "CULQI_EVENT", eventId: EVT }, { billing: { store, culqi: makeCulqi({ charges: { [CHR]: paidCharge() } }) }, logger: silentLogger, now: () => NOW } as never);
    expect(outcome).toEqual({ accounts: 0, enqueued: 0, billing: "activated" });
  });

  it("upgrade: once the new subscription has a verified charge, the replaced Culqi subscription is cancelled and marked", async () => {
    const store = makeStore([row()], received());
    store.cancellations.push({ id: "bill-old", externalSubscriptionId: "sxn_test_OLD" });
    const culqi = makeCulqi({ charges: { [CHR]: paidCharge() } });
    await handleCulqiEvent(EVT, deps(store, culqi));
    expect(culqi.cancelSubscription).toHaveBeenCalledWith("sxn_test_OLD");
    expect(store.markProviderCanceled).toHaveBeenCalledWith("bill-old");
  });
});

describe("period of a verified charge", () => {
  it("one calendar interval from the charge, plus the renewal grace", () => {
    const start = Date.parse("2026-01-31T10:00:00.000Z");
    expect(periodForCharge(paidCharge({ creation_date: start }), "MONTHLY", NOW)).toEqual({
      start: "2026-01-31T10:00:00.000Z",
      end: new Date(Date.parse("2026-03-03T10:00:00.000Z") + CULQI_RENEWAL_GRACE_MS).toISOString()
    });
    expect(periodForCharge(paidCharge({ creation_date: start / 1000 }), "YEARLY", NOW).end).toBe(new Date(Date.parse("2027-01-31T10:00:00.000Z") + CULQI_RENEWAL_GRACE_MS).toISOString());
  });
});
