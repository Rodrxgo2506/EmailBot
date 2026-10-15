import { CulqiApiError, type CulqiCharge, type CulqiClient, type CulqiEvent, type CulqiPlan, type CulqiSubscription } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  CULQI_PENDING_CONFIRMATION_TIMEOUT_MS,
  CULQI_PENDING_INCOMPLETE_TIMEOUT_MS,
  CULQI_RECONCILE_RETRY_WINDOW_MS,
  CULQI_RENEWAL_GRACE_MS,
  CULQI_REVIEW_CODE,
  CULQI_REVIEW_RECONCILE_INTERVAL_MS,
  CULQI_REVIEW_RECONCILE_MAX_AGE_MS,
  CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS,
  CULQI_UNCONFIRMED_REVIEW_AFTER_MS,
  reconcileReviewRequired,
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
  planCode: "PRO",
  reviewRequiredAt: null,
  lastReconciledAt: null,
  ...overrides
});

/**
 * An approved subscription charge, shaped like the one the Culqi sandbox returned in the first real test
 * (GET /v2/charges/{id}): captured, outcome venta_exitosa / AUT0000, authorization and reference codes, nothing
 * refunded, no dispute, and paid: false. Fake ids, no secrets.
 */
const paidCharge = (overrides: Partial<CulqiCharge> = {}): CulqiCharge => ({
  id: CHR,
  amount: 3990,
  current_amount: 3990,
  amount_refunded: 0,
  currency_code: "PEN",
  capture: true,
  authorization_code: "000001",
  reference_code: "700000000001",
  dispute: false,
  paid: false,
  creation_date: NOW - 60_000,
  outcome: { type: "venta_exitosa", code: "AUT0000", merchant_message: "La operación de venta ha sido autorizada exitosamente" },
  source: { object: "card", id: CARD, customer_id: CUSTOMER },
  ...overrides
});
/** Culqi's documented decline (outcome code "card_declined"). */
const declinedCharge = (overrides: Partial<CulqiCharge> = {}): CulqiCharge =>
  paidCharge({ capture: false, authorization_code: null, outcome: { type: "tarjeta_denegada", code: "card_declined", decline_code: "insufficient_funds" }, ...overrides });

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
    reviews: [] as BillingSubscriptionRow[],
    /** Emulates the database rule: the organization moved on since a REVIEW_REQUIRED checkout began. */
    reviewConflict: false,
    reconciliations: [] as Array<{ id: string; at: string; charge: unknown }>,
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
      if (target.status === "REVIEW_REQUIRED" && store.reviewConflict) return { outcome: "CONFLICT", subscriptionId: null, supersededExternalIds: [] };
      applied.add(input.activationKey);
      const outcome = target.status === "PENDING" || target.status === "FAILED" || target.status === "REVIEW_REQUIRED" ? "ACTIVATED" : "RENEWED";
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
    listStalePending: vi.fn(async () => store.stale),
    listReviewRequired: vi.fn(async () => store.reviews),
    recordReconciliation: vi.fn(async (id: string, input: { at: string; charge: unknown }) => {
      const target = byId(id);
      if (target && (target.status === "PENDING" || target.status === "REVIEW_REQUIRED")) {
        target.lastReconciledAt = input.at;
        store.reconciliations.push({ id, ...input });
      }
    }),
    markReviewRequired: vi.fn(async (input: { billingSubscriptionId: string; reviewCode: string }) => {
      const target = byId(input.billingSubscriptionId);
      if (!target) return "IGNORED";
      if (target.status === "REVIEW_REQUIRED") return "UNCHANGED";
      if (target.status !== "PENDING") return "IGNORED";
      target.status = "REVIEW_REQUIRED";
      target.reviewRequiredAt = new Date(NOW).toISOString();
      return "CHANGED";
    })
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
  const plan: CulqiPlan | null = options.plan === null ? null : { id: PLAN, amount: 3990, currency: "PEN", interval_unit_time: 3, interval_count: 1, ...(options.plan ?? {}) };
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

  it("Culqi amounts with float noise (charge and plan in céntimos) are the catalog price: ACTIVE", async () => {
    const store = makeStore([row({ amountCents: 1990, externalPlanId: PLAN })], received());
    const culqi = makeCulqi({ plan: { amount: 1989.9999999999998 }, charges: { [CHR]: paidCharge({ amount: 1989.9999999999998 }) } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("activated");
    expect(verifyCulqiCharge(row({ amountCents: 1990 }), CHR, paidCharge({ amount: 1989.9999999999998 }), true)).toEqual({ kind: "PAID" });
  });

  it("confirmed sale (venta_exitosa / AUT0000, captured), catalog amount and currency, own card: ACTIVE, keyed by the charge id", async () => {
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
    ["confirmed decline (card_declined)", declinedCharge(), "DECLINED"],
    ["wrong amount", paidCharge({ amount: 100 }), "CHARGE_AMOUNT_MISMATCH"],
    ["one céntimo less (S/39.89)", paidCharge({ amount: 3989 }), "CHARGE_AMOUNT_MISMATCH"],
    ["an amount that is not a number", paidCharge({ amount: Number.NaN }), "CHARGE_AMOUNT_MISMATCH"],
    ["wrong currency", paidCharge({ currency_code: "USD" }), "CHARGE_CURRENCY_MISMATCH"],
    ["no success outcome", paidCharge({ outcome: { code: "other" } }), "UNCONFIRMED"],
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
    const culqi = makeCulqi({ event: { id: EVT, type: "subscription.charge.failed", data: { id: SXN, charge: CHR } }, subscription: { status: 5 }, charges: { [CHR]: declinedCharge() } });
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

describe("incident: an approved sandbox charge with paid: false was taken as declined (and its subscription cancelled)", () => {
  const recordingLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const listed = { periods: [{ charges: { charge_id: CHR } }] } as Partial<CulqiSubscription>;

  it("1. paid:false + capture + venta_exitosa / AUT0000 + authorization code + nothing refunded + no dispute: PAID, activated", async () => {
    expect(verifyCulqiCharge(row(), CHR, paidCharge(), true)).toEqual({ kind: "PAID" });
    const store = makeStore([row()]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: paidCharge() } });
    expect(await reconcileCulqiSubscription("bill-1", deps(store, culqi))).toBe("activated");
    expect(store.activate).toHaveBeenCalledWith(expect.objectContaining({ activationKey: CHR, externalChargeId: CHR }));
    expect(store.rows[0]?.status).toBe("ACTIVE");
    expect(store.recordChargeFailure).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("2. paid:false by itself is never a decline: nothing recorded as failed, nothing cancelled", async () => {
    for (const charge of [paidCharge({ paid: false }), paidCharge({ paid: false, outcome: null }), paidCharge({ paid: false, capture: false, authorization_code: null, outcome: {} })]) {
      expect(verifyCulqiCharge(row(), CHR, charge, true).kind).not.toBe("DECLINED");
    }
    const store = makeStore([row()]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: paidCharge({ paid: false, outcome: null }) } });
    await expect(reconcileCulqiSubscription("bill-1", deps(store, culqi))).rejects.toBeInstanceOf(CulqiStillPendingError);
    expect(store.recordChargeFailure).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).toBe("PENDING");
  });

  it("3. ambiguous charge: not activated, not cancelled, kept PENDING for the reconciliation, with an identifiable reason", async () => {
    const ambiguous = paidCharge({ outcome: { type: "venta_exitosa", code: "AUT9999" } });
    expect(verifyCulqiCharge(row(), CHR, ambiguous, true)).toEqual({ kind: "UNCONFIRMED", reason: "CHARGE_STATUS_UNCONFIRMED" });

    // Post-checkout reconciliation: retried (BullMQ backoff), nothing applied, nothing cancelled, logged with the reason.
    const logger = recordingLogger();
    const store = makeStore([row()]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous } });
    await expect(reconcileCulqiSubscription("bill-1", { store, culqi, logger, now: () => NOW })).rejects.toBeInstanceOf(CulqiStillPendingError);
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.recordChargeFailure).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).toBe("PENDING");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "billing.culqi.charge_unconfirmed", charge: CHR, reason: "CHARGE_STATUS_UNCONFIRMED", outcomeCode: "AUT9999", paid: false }),
      expect.any(String)
    );

    // The same result through syncCulqiSubscription: "pending" with the reason, flagged unconfirmed.
    expect(await syncCulqiSubscription(row(), NO_TRIGGER, culqiDeps(store, culqi))).toEqual({
      outcome: "pending",
      reason: "CHARGE_STATUS_UNCONFIRMED",
      paid: false,
      unconfirmed: true,
      unconfirmedCharge: { chargeId: CHR, outcomeType: "venta_exitosa", outcomeCode: "AUT9999", declineCode: null }
    });

    // Webhook: the event is processed with the reason recorded (the reconciliation keeps reading the charge).
    const hooked = makeStore([row()], received());
    expect(await handleCulqiEvent(EVT, deps(hooked, makeCulqi({ charges: { [CHR]: ambiguous } })))).toBe("pending");
    expect(hooked.updates.at(-1)?.patch).toMatchObject({ status: "PROCESSED", lastError: "CHARGE_STATUS_UNCONFIRMED" });

    // F4 after 48 h: a stale checkout with an ambiguous charge is NOT cancelled (it stays PENDING and is read again).
    const stale = makeStore([row({ createdAt: new Date(NOW - 3 * DAY).toISOString() })]);
    const staleCulqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous } });
    expect(await expireStalePending(stale.rows[0] as BillingSubscriptionRow, culqiDeps(stale, staleCulqi))).toBe("pending");
    expect(staleCulqi.cancelSubscription).not.toHaveBeenCalled();
    expect(stale.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ failureCode: "confirmation_timeout" }));
    expect(stale.markProviderCanceled).not.toHaveBeenCalled();
    expect(stale.rows[0]?.status).toBe("PENDING");

    // Once Culqi reports the confirmed sale, the next reconciliation activates it.
    const later = makeCulqi({ subscription: listed, charges: { [CHR]: paidCharge() } });
    expect(await reconcileCulqiSubscription("bill-1", deps(store, later))).toBe("activated");
  });

  it("4. F1 / F2 still apply to a confirmed sale: wrong amount, currency, plan, interval_count or subscription never activate", async () => {
    const cases: Array<[string, CulqiOptions, string]> = [
      ["amount", { charges: { [CHR]: paidCharge({ amount: 1990 }) } }, "REJECTED:CHARGE_AMOUNT_MISMATCH"],
      ["currency", { charges: { [CHR]: paidCharge({ currency_code: "USD" }) } }, "REJECTED:CHARGE_CURRENCY_MISMATCH"],
      ["plan", { subscription: { plan: { plan_id: "pln_test_OTHERPLAN000001" } }, charges: { [CHR]: paidCharge() } }, "REJECTED:PLAN_MISMATCH"],
      ["interval_count", { plan: { interval_count: 0 }, charges: { [CHR]: paidCharge() } }, "REJECTED:PLAN_INTERVAL_COUNT_MISMATCH"],
      ["subscription", { subscription: { id: "sxn_test_OTHERSUBSCRIPT1" }, charges: { [CHR]: paidCharge() } }, "REJECTED:SUBSCRIPTION_ID_MISMATCH"],
      ["card", { charges: { [CHR]: paidCharge({ source: { object: "card", id: "crd_test_OTHERCARD0001" } }) } }, "REJECTED:CHARGE_CARD_MISMATCH"],
      ["customer", { charges: { [CHR]: paidCharge({ source: { object: "card", customer_id: "cus_test_OTHER" } }) } }, "REJECTED:CHARGE_CUSTOMER_MISMATCH"]
    ];
    for (const [label, options, reason] of cases) {
      const store = makeStore([row()], received());
      const culqi = makeCulqi(options);
      expect(await handleCulqiEvent(EVT, deps(store, culqi)), label).toBe("ignored");
      expect(store.activate, label).not.toHaveBeenCalled();
      expect(culqi.cancelSubscription, label).not.toHaveBeenCalled();
      expect(store.updates.at(-1)?.patch, label).toMatchObject({ status: "IGNORED", lastError: reason });
    }
  });

  it("5. a refunded charge (amount_refunded > 0) is not a valid success", async () => {
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ amount_refunded: 3990 }), true)).toEqual({ kind: "REJECTED", reason: "CHARGE_REFUNDED" });
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ amount_refunded: 1 }), true)).toEqual({ kind: "REJECTED", reason: "CHARGE_REFUNDED" });
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ amount_refunded: null }), true).kind).toBe("UNCONFIRMED");
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ charges: { [CHR]: paidCharge({ amount_refunded: 3990 }) } });
    await handleCulqiEvent(EVT, deps(store, culqi));
    expect(store.activate).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("6. a disputed charge (dispute = true) is not a valid success", async () => {
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ dispute: true }), true)).toEqual({ kind: "REJECTED", reason: "CHARGE_DISPUTED" });
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ dispute: null }), true).kind).toBe("UNCONFIRMED");
    const store = makeStore([row()], received());
    const culqi = makeCulqi({ charges: { [CHR]: paidCharge({ dispute: true }) } });
    await handleCulqiEvent(EVT, deps(store, culqi));
    expect(store.activate).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("7. an uncaptured charge (capture = false), or one without authorization code, is not a success (and not a decline)", async () => {
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ capture: false }), true)).toEqual({ kind: "UNCONFIRMED", reason: "CHARGE_STATUS_UNCONFIRMED" });
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ authorization_code: null }), true).kind).toBe("UNCONFIRMED");
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ authorization_code: "  " }), true).kind).toBe("UNCONFIRMED");
    const store = makeStore([row()]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: paidCharge({ capture: false }) } });
    await expect(reconcileCulqiSubscription("bill-1", deps(store, culqi))).rejects.toBeInstanceOf(CulqiStillPendingError);
    expect(store.activate).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("only Culqi's documented decline code is a confirmed decline (then FAILED + cancelled); other codes are not assumed", () => {
    expect(verifyCulqiCharge(row(), CHR, declinedCharge(), true)).toEqual({ kind: "DECLINED", code: "insufficient_funds" });
    expect(verifyCulqiCharge(row(), CHR, declinedCharge({ outcome: { code: "card_declined" } }), true)).toEqual({ kind: "DECLINED", code: "card_declined" });
    // The specification's success example (paid: true, "succesfull_charge") is not what the sandbox returns: not assumed.
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ paid: true, outcome: { type: "succesfull_request", code: "succesfull_charge" } }), true).kind).toBe("UNCONFIRMED");
  });
});

describe("real sandbox decline: first charge of a subscription with the insufficient_funds test card", () => {
  /** Shaped like the declined charge the sandbox returned: operacion_denegada / DNGE0015, capture true, paid false, no authorization. */
  const deniedCharge = (overrides: Partial<CulqiCharge> = {}): CulqiCharge =>
    paidCharge({ authorization_code: null, capture: true, paid: false, outcome: { type: "operacion_denegada", code: "DNGE0015" }, ...overrides });
  const listed = { status: 5, periods: [{ charges: { charge_id: CHR } }] } as Partial<CulqiSubscription>;

  it("1. operacion_denegada / DNGE0015 is DECLINED (failure code DNGE0015, or the bank decline_code when present)", () => {
    expect(verifyCulqiCharge(row(), CHR, deniedCharge(), true)).toEqual({ kind: "DECLINED", code: "DNGE0015" });
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ outcome: { type: "operacion_denegada", code: "DNGE0015", decline_code: "insufficient_funds" } }), true)).toEqual({
      kind: "DECLINED",
      code: "insufficient_funds"
    });
  });

  it("2. paid does not change the classification by itself", () => {
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ paid: true }), true).kind).toBe("DECLINED");
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ paid: false }), true).kind).toBe("DECLINED");
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ paid: true }), true).kind).toBe("PAID");
    expect(verifyCulqiCharge(row(), CHR, paidCharge({ paid: false }), true).kind).toBe("PAID");
  });

  it("3. capture: true with operacion_denegada is never PAID", () => {
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ capture: true }), true).kind).not.toBe("PAID");
  });

  it("4. venta_exitosa / AUT0000 is still PAID; 5. card_declined is still DECLINED", () => {
    expect(verifyCulqiCharge(row(), CHR, paidCharge(), true)).toEqual({ kind: "PAID" });
    expect(verifyCulqiCharge(row(), CHR, declinedCharge(), true)).toEqual({ kind: "DECLINED", code: "insufficient_funds" });
  });

  it("6. unknown outcomes stay UNCONFIRMED (an unobserved DNGE code, an authorized denial, another type)", () => {
    for (const outcome of [{ type: "operacion_denegada", code: "DNGE9999" }, { type: "otro_tipo", code: "DNGE0015" }, { type: "venta_exitosa", code: "AUT9999" }]) {
      expect(verifyCulqiCharge(row(), CHR, deniedCharge({ outcome }), true)).toEqual({ kind: "UNCONFIRMED", reason: "CHARGE_STATUS_UNCONFIRMED" });
    }
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ authorization_code: "000001" }), true).kind).toBe("UNCONFIRMED");
  });

  it("integrity comes first: a denied charge of another amount, card or environment is REJECTED (never cancels)", () => {
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ amount: 1990 }), true)).toEqual({ kind: "REJECTED", reason: "CHARGE_AMOUNT_MISMATCH" });
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ source: { object: "card", id: "crd_test_OTHERCARD0001" } }), true)).toEqual({ kind: "REJECTED", reason: "CHARGE_CARD_MISMATCH" });
    expect(verifyCulqiCharge(row(), CHR, deniedCharge({ id: "chr_live_CHARGE00000001" }), true)).toEqual({ kind: "REJECTED", reason: "CHARGE_ID_MISMATCH" });
  });

  it("7. DECLINED first charge: recordChargeFailure once (DNGE0015), FAILED, the Culqi subscription cancelled and marked", async () => {
    const store = makeStore([row()]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: deniedCharge() } });
    expect(await reconcileCulqiSubscription("bill-1", deps(store, culqi))).toBe("charge_failed");
    expect(store.recordChargeFailure).toHaveBeenCalledTimes(1);
    expect(store.recordChargeFailure).toHaveBeenCalledWith(expect.objectContaining({ billingSubscriptionId: "bill-1", externalChargeId: CHR, failureCode: "DNGE0015" }));
    expect(store.rows[0]?.status).toBe("FAILED");
    expect(store.activate).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(culqi.cancelSubscription).toHaveBeenCalledWith(SXN);
    expect(store.markProviderCanceled).toHaveBeenCalledWith("bill-1");
    // A FAILED row is terminal for the post-checkout reconciliation: no second failure, no second cancellation.
    expect(await syncCulqiSubscription(row({ status: "FAILED" }), NO_TRIGGER, culqiDeps(store, culqi))).toMatchObject({ outcome: "duplicate" });
    expect(culqi.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("8. the PRO decline does not touch the active BÁSICO subscription of the organization", async () => {
    const basic = row({ id: "bill-basic", status: "ACTIVE", externalSubscriptionId: "sxn_test_BASICSUBSCRIP1", externalPlanId: "pln_test_BASICMONTHLY0001", amountCents: 1990 });
    const store = makeStore([row(), basic]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: deniedCharge() } });
    expect(await reconcileCulqiSubscription("bill-1", deps(store, culqi))).toBe("charge_failed");
    expect(store.rows.find((item) => item.id === "bill-basic")?.status).toBe("ACTIVE");
    expect(culqi.cancelSubscription).toHaveBeenCalledWith(SXN);
    expect(culqi.cancelSubscription).not.toHaveBeenCalledWith("sxn_test_BASICSUBSCRIP1");
    expect(store.recordChargeFailure).not.toHaveBeenCalledWith(expect.objectContaining({ billingSubscriptionId: "bill-basic" }));
    expect(store.markProviderCanceled).not.toHaveBeenCalledWith("bill-basic");
    expect(store.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ billingSubscriptionId: "bill-basic" }));
  });
});

describe("UNCONFIRMED over time: periodic reconciliation, then REVIEW_REQUIRED (never cancelled, never blocking)", () => {
  const HOUR = 3600_000;
  const ambiguous = () => paidCharge({ outcome: { type: "venta_exitosa", code: "AUT9999" } });
  const listed = { status: 3, periods: [{ charges: { charge_id: CHR } }] } as Partial<CulqiSubscription>;
  const recordingLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const aged = (ms: number, overrides: Partial<BillingSubscriptionRow> = {}) => row({ createdAt: new Date(NOW - ms).toISOString(), ...overrides });

  it("the review delay is centralised: 168 h (7 days); review rows are read daily for 30 days", () => {
    expect(CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS).toBe(168);
    expect(CULQI_UNCONFIRMED_REVIEW_AFTER_MS).toBe(7 * DAY);
    expect(CULQI_REVIEW_RECONCILE_INTERVAL_MS).toBe(DAY);
    expect(CULQI_REVIEW_RECONCILE_MAX_AGE_MS).toBe(30 * DAY);
    expect(CULQI_RECONCILE_RETRY_WINDOW_MS).toBe(2 * HOUR);
  });

  it("E. in the first hours the post-checkout reconciliation keeps retrying (nothing applied, nothing cancelled)", async () => {
    const store = makeStore([aged(HOUR)]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous() } });
    await expect(reconcileCulqiSubscription("bill-1", deps(store, culqi))).rejects.toBeInstanceOf(CulqiStillPendingError);
    expect(store.rows[0]?.status).toBe("PENDING");
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.reconciliations.at(-1)).toMatchObject({ id: "bill-1", charge: { chargeId: CHR, outcomeType: "venta_exitosa", outcomeCode: "AUT9999", declineCode: null } });
  });

  it("F. after ~2 h the hourly job finds it in the database and reads it again (no dependency on the first job)", async () => {
    const store = makeStore([aged(3 * HOUR)]);
    store.stale = [store.rows[0] as BillingSubscriptionRow];
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous() } });
    const result = await reconcileDueCulqiSubscriptions(deps(store, culqi));
    expect(store.listStalePending).toHaveBeenCalledWith(expect.objectContaining({ withSubscriptionCreatedBefore: new Date(NOW - 2 * HOUR).toISOString() }));
    expect(culqi.getCharge).toHaveBeenCalledWith(CHR);
    expect(result).toMatchObject({ expired: 0, reviewRequired: 0, failed: 0 });
    expect(store.rows[0]?.status).toBe("PENDING");
    expect(store.rows[0]?.lastReconciledAt).toBe(new Date(NOW).toISOString());
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("G. before 7 days it stays PENDING (even after the 48 h F4 timeout: an unconfirmed charge is never cancelled)", async () => {
    const store = makeStore([aged(7 * DAY - HOUR)]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous() } });
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("pending");
    expect(store.markReviewRequired).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(store.rows[0]?.status).toBe("PENDING");
  });

  it("H/I. after 7 days: REVIEW_REQUIRED with the alert; not activated, not cancelled, no failure recorded", async () => {
    const logger = recordingLogger();
    const store = makeStore([aged(7 * DAY + HOUR)]);
    store.stale = [store.rows[0] as BillingSubscriptionRow];
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous() } });
    const result = await reconcileDueCulqiSubscriptions({ store, culqi, logger, now: () => NOW });
    expect(result).toMatchObject({ reviewRequired: 1, expired: 0, failed: 0 });
    expect(store.markReviewRequired).toHaveBeenCalledWith(expect.objectContaining({ billingSubscriptionId: "bill-1", reviewCode: CULQI_REVIEW_CODE }));
    expect(store.rows[0]?.status).toBe("REVIEW_REQUIRED");
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.recordChargeFailure).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.markProviderCanceled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing.culqi.review_required",
        alert: true,
        reason: "CULQI_UNCONFIRMED_REVIEW",
        organizationId: "org-1",
        billingSubscriptionId: "bill-1",
        culqiSubscriptionId: SXN,
        chargeId: CHR,
        plan: "PRO",
        amountCents: 3990,
        currency: "PEN",
        createdAt: new Date(NOW - 7 * DAY - HOUR).toISOString(),
        lastReconciledAt: new Date(NOW).toISOString(),
        outcomeType: "venta_exitosa",
        outcomeCode: "AUT9999",
        declineCode: null
      }),
      expect.any(String)
    );
    const alert = JSON.stringify(logger.warn.mock.calls);
    expect(alert).not.toMatch(/sk_(test|live)_|pk_(test|live)_|tkn_/);
  });

  it("the review rows are read again at most daily, within 30 days (the store query bounds)", async () => {
    const store = makeStore([]);
    await reconcileDueCulqiSubscriptions(deps(store, makeCulqi()));
    expect(store.listReviewRequired).toHaveBeenCalledWith({
      createdAfter: new Date(NOW - 30 * DAY).toISOString(),
      reconciledBefore: new Date(NOW - DAY).toISOString(),
      limit: 100
    });
  });

  it("still ambiguous under review: nothing changes (no activation, no cancellation, no failure), the read is recorded", async () => {
    const store = makeStore([aged(10 * DAY, { status: "REVIEW_REQUIRED" })]);
    store.reviews = [store.rows[0] as BillingSubscriptionRow];
    const culqi = makeCulqi({ subscription: { ...listed, status: 4 } as Partial<CulqiSubscription>, charges: { [CHR]: ambiguous() } });
    const result = await reconcileDueCulqiSubscriptions(deps(store, culqi));
    expect(result).toMatchObject({ reviewed: 1, failed: 0 });
    expect(store.rows[0]?.status).toBe("REVIEW_REQUIRED"); // a Culqi status alone never changes a row under review
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.recordChargeFailure).not.toHaveBeenCalled();
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.rows[0]?.lastReconciledAt).toBe(new Date(NOW).toISOString());
  });

  it("J/L. a review whose charge is later a confirmed sale is activated (charge id = key), once", async () => {
    const store = makeStore([aged(10 * DAY, { status: "REVIEW_REQUIRED" })]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: paidCharge() } });
    expect(await reconcileReviewRequired(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("activated");
    expect(store.activate).toHaveBeenCalledWith(expect.objectContaining({ activationKey: CHR, externalChargeId: CHR }));
    expect(store.rows[0]?.status).toBe("ACTIVE");
    expect(await reconcileReviewRequired(row({ status: "ACTIVE" }), culqiDeps(store, culqi))).toBe("duplicate");
    expect(store.applied.size).toBe(1);
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
  });

  it("K/L. a review whose charge is later a confirmed decline ends FAILED and its live Culqi subscription is cancelled, once", async () => {
    const declined = paidCharge({ authorization_code: null, outcome: { type: "operacion_denegada", code: "DNGE0015" } });
    const store = makeStore([aged(10 * DAY, { status: "REVIEW_REQUIRED" })]);
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: declined } });
    expect(await reconcileReviewRequired(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("charge_failed");
    expect(store.recordChargeFailure).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.status).toBe("FAILED");
    expect(culqi.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(store.markProviderCanceled).toHaveBeenCalledWith("bill-1");
    expect(await reconcileReviewRequired(row({ status: "FAILED" }), culqiDeps(store, culqi))).toBe("duplicate");
    expect(culqi.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("K. a confirmed decline whose Culqi subscription already ended is not cancelled again nor marked", async () => {
    const declined = paidCharge({ authorization_code: null, outcome: { type: "operacion_denegada", code: "DNGE0015" } });
    const store = makeStore([aged(10 * DAY, { status: "REVIEW_REQUIRED" })]);
    const culqi = makeCulqi({ subscription: { ...listed, status: 4 } as Partial<CulqiSubscription>, charges: { [CHR]: declined } });
    expect(await reconcileReviewRequired(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("charge_failed");
    expect(store.recordChargeFailure).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.status).toBe("CANCELED"); // FAILED by the decline, then CANCELED as Culqi reports (provider side)
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.markProviderCanceled).not.toHaveBeenCalled();
  });

  it("O. the organization moved on (database CONFLICT): the late sale is not applied, the review stays, an alert is logged, nothing cancelled", async () => {
    const logger = recordingLogger();
    const store = makeStore([aged(10 * DAY, { status: "REVIEW_REQUIRED" })]);
    store.reviewConflict = true;
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: paidCharge() } });
    expect(await reconcileReviewRequired(store.rows[0] as BillingSubscriptionRow, { store, culqi, logger, now: () => NOW })).toBe("review_conflict");
    expect(store.rows[0]?.status).toBe("REVIEW_REQUIRED");
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.recordChargeFailure).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "billing.culqi.review_conflict", alert: true, charge: CHR }), expect.any(String));
  });

  it("M/N/P. a review and a newer checkout coexist: each keeps its own Culqi subscription; the active BÁSICO is untouched", async () => {
    const basic = row({ id: "bill-basic", status: "ACTIVE", externalSubscriptionId: "sxn_test_BASICSUBSCRIP1", planCode: "BASIC", amountCents: 1990 });
    const old = aged(10 * DAY, { status: "REVIEW_REQUIRED" });
    const store = makeStore([basic, old]);
    store.reviews = [old];
    const culqi = makeCulqi({ subscription: listed, charges: { [CHR]: ambiguous() } });
    await reconcileDueCulqiSubscriptions(deps(store, culqi));
    expect(culqi.getSubscription).toHaveBeenCalledWith(SXN);
    expect(culqi.getSubscription).not.toHaveBeenCalledWith("sxn_test_BASICSUBSCRIP1");
    expect(store.rows.find((item) => item.id === "bill-basic")?.status).toBe("ACTIVE");
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it("integrity REJECTED (a charge of another amount) or a mismatching subscription is never cancelled by F4: reviewed after 7 days", async () => {
    for (const options of [
      { subscription: listed, charges: { [CHR]: paidCharge({ amount: 1990 }) } },
      { subscription: { ...listed, plan: { plan_id: "pln_test_OTHERPLAN000001" } } as Partial<CulqiSubscription>, charges: { [CHR]: paidCharge() } }
    ]) {
      const store = makeStore([aged(3 * DAY)]);
      const culqi = makeCulqi(options);
      expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("rejected");
      expect(culqi.cancelSubscription).not.toHaveBeenCalled();
      expect(store.setStatus).not.toHaveBeenCalled();
      expect(store.rows[0]?.status).toBe("PENDING");

      const logger = recordingLogger();
      const late = makeStore([aged(8 * DAY)]);
      expect(await expireStalePending(late.rows[0] as BillingSubscriptionRow, { store: late, culqi: makeCulqi(options), logger, now: () => NOW })).toBe("review_required");
      expect(late.rows[0]?.status).toBe("REVIEW_REQUIRED");
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "billing.culqi.review_required", syncReason: expect.stringMatching(/MISMATCH/) }), expect.any(String));
    }
  });

  it("a PENDING with NO charge at all is still F4 after 48 h (cancelled + confirmation_timeout), as before", async () => {
    const store = makeStore([aged(3 * DAY)]);
    const culqi = makeCulqi({ subscription: { status: 1 } });
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("expired_pending");
    expect(culqi.cancelSubscription).toHaveBeenCalledWith(SXN);
    expect(store.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", failureCode: "confirmation_timeout" }));
  });

  it("a PENDING with no charge yet, between 2 h and 48 h, is only read (Culqi charges in a daily batch)", async () => {
    const store = makeStore([aged(5 * HOUR)]);
    const culqi = makeCulqi({ subscription: { status: 1 } });
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("pending");
    expect(culqi.cancelSubscription).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it("a charge that appears unconfirmed right at the F4 cancellation goes to review, never FAILED on it", async () => {
    const store = makeStore([aged(3 * DAY)]);
    const culqi = makeCulqi({ charges: { [CHR]: ambiguous() } });
    vi.mocked(culqi.getSubscription)
      .mockResolvedValueOnce({ id: SXN, status: 1, plan: { plan_id: PLAN }, metadata: {} })
      .mockResolvedValueOnce({ id: SXN, status: 1, plan: { plan_id: PLAN }, metadata: {}, periods: [{ charges: { charge_id: CHR } }] } as CulqiSubscription);
    expect(await expireStalePending(store.rows[0] as BillingSubscriptionRow, culqiDeps(store, culqi))).toBe("review_required");
    expect(store.rows[0]?.status).toBe("REVIEW_REQUIRED");
    expect(store.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ failureCode: "confirmation_timeout" }));
  });
});

describe("F2: the Culqi subscription must match EmailBot before anything is applied", () => {
  it.each([
    ["another plan", { subscription: { plan: { plan_id: "pln_test_OTHERPLAN000001" } } }, "PLAN_MISMATCH"],
    ["plan not reported", { subscription: { plan: null } }, "PLAN_NOT_REPORTED"],
    ["Culqi plan amount", { plan: { amount: 2990 } }, "PLAN_AMOUNT_MISMATCH"],
    ["Culqi plan currency", { plan: { currency: "USD" } }, "PLAN_CURRENCY_MISMATCH"],
    ["Culqi plan interval", { plan: { interval_unit_time: 4 } }, "PLAN_INTERVAL_MISMATCH"],
    ["Culqi plan interval_count 0 (open-ended)", { plan: { interval_count: 0 } }, "PLAN_INTERVAL_COUNT_MISMATCH"],
    ["Culqi plan interval_count 2", { plan: { interval_count: 2 } }, "PLAN_INTERVAL_COUNT_MISMATCH"],
    ["Culqi plan interval_count missing", { plan: { interval_count: undefined } }, "PLAN_INTERVAL_COUNT_MISMATCH"],
    ["Culqi returns another plan object", { plan: { id: "pln_test_OTHERPLAN000001" } }, "PLAN_ID_MISMATCH"],
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

  it("plan check: interval_count 1 + catalog price accepted; a live plan in a test row rejected", () => {
    const sub = { id: SXN, status: 3, plan: { plan_id: PLAN } };
    const plan = { id: PLAN, amount: 3990, currency: "PEN", interval_unit_time: 3, interval_count: 1 };
    expect(verifyCulqiSubscription(row(), sub, plan, "test")).toEqual({ ok: true });
    const live = "pln_live_PROMONTHLY0001";
    expect(verifyCulqiSubscription(row({ externalPlanId: live }), { ...sub, plan: { plan_id: live } }, { ...plan, id: live }, "test")).toEqual({ ok: false, reason: "PLAN_ENVIRONMENT_MISMATCH" });
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
    const culqi = makeCulqi({ subscription: { status: 5, periods: [{ charges: { charge_id: declinedId } }] } as Partial<CulqiSubscription>, charges: { [declinedId]: declinedCharge({ id: declinedId }) } });
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
    expect(result).toEqual({ reconciled: 1, failed: 1, expired: 0, reviewRequired: 0, reviewed: 0 });
    expect(store.listDueForReconciliation).toHaveBeenCalledWith({
      endBefore: new Date(NOW + CULQI_RENEWAL_GRACE_MS + DAY).toISOString(),
      endAfter: new Date(NOW - 7 * DAY).toISOString(),
      limit: 100
    });
    expect(store.listStalePending).toHaveBeenCalledWith({
      withSubscriptionCreatedBefore: new Date(NOW - CULQI_RECONCILE_RETRY_WINDOW_MS).toISOString(),
      withoutSubscriptionCreatedBefore: new Date(NOW - CULQI_PENDING_INCOMPLETE_TIMEOUT_MS).toISOString(),
      limit: 100
    });
  });

  it("is reached through the email-events queue (CULQI_RECONCILE_DUE)", async () => {
    const store = makeStore([]);
    const outcome = await handleEmailEvent({ type: "CULQI_RECONCILE_DUE" }, { billing: { store, culqi: makeCulqi() }, logger: silentLogger, now: () => NOW } as never);
    expect(outcome).toEqual({ accounts: 0, enqueued: 0, billingReconcile: { reconciled: 0, expired: 0, reviewRequired: 0, reviewed: 0, failed: 0 } });
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
