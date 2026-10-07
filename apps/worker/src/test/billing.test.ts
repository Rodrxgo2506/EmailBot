import { CulqiApiError, type CulqiClient, type CulqiEvent, type CulqiSubscription } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  activationKey,
  confirmedPeriod,
  CULQI_RENEWAL_GRACE_MS,
  CulqiStillPendingError,
  handleCulqiEvent,
  reconcileCulqiSubscription,
  type BillingDeps
} from "../pipeline/billing.js";
import { handleEmailEvent } from "../pipeline/handle-email-event.js";
import type { BillingStore, BillingSubscriptionRow, WebhookEventRow } from "../pipeline/ports.js";
import { silentLogger } from "./fakes.js";

/*
 * Commercial V1 phase 2 (Culqi sandbox): webhook events and reconciliation.
 * The webhook body is never trusted (the event and the subscription are read
 * back from Culqi); every path converges to the same idempotent activation.
 */

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const NEXT = Date.parse("2026-11-07T12:00:00.000Z");
const SXN = "sxn_test_SUBSCRIPTION1";
const EVT = "evt_test_EVENT0000000001";

function makeStore(rows: BillingSubscriptionRow[] = [], events: Record<string, WebhookEventRow> = {}) {
  const updates: Array<{ eventId: string; patch: Record<string, unknown> }> = [];
  const cancellations: Array<{ id: string; externalSubscriptionId: string }> = [];
  const store = {
    updates,
    cancellations,
    events,
    getWebhookEvent: vi.fn(async (eventId: string) => events[eventId] ?? null),
    updateWebhookEvent: vi.fn(async (eventId: string, patch: Record<string, unknown>) => {
      updates.push({ eventId, patch });
      const current = events[eventId];
      if (current && typeof patch.status === "string") current.status = patch.status as WebhookEventRow["status"];
    }),
    getBillingSubscription: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    findBillingSubscriptionByExternalId: vi.fn(async (sxn: string) => rows.find((row) => row.externalSubscriptionId === sxn) ?? null),
    activate: vi.fn(async () => ({ outcome: "ACTIVATED", subscriptionId: "sub-1", supersededExternalIds: [] as string[] })),
    recordChargeFailure: vi.fn(async () => "RECORDED"),
    setStatus: vi.fn(async () => "CHANGED"),
    listUnconfirmedCancellations: vi.fn(async () => cancellations.splice(0)),
    markProviderCanceled: vi.fn(async () => undefined)
  };
  return store as typeof store & BillingStore;
}

function makeCulqi(options: { event?: CulqiEvent | null; subscription?: Partial<CulqiSubscription> | null; environment?: "test" | "live" } = {}) {
  return {
    environment: options.environment ?? "test",
    getEvent: vi.fn(async () => (options.event === undefined ? { id: EVT, type: "subscription.charge.succeeded", data: { id: SXN, charge_id: "chr_test_CHARGE1" } } : options.event)),
    getSubscription: vi.fn(async () =>
      options.subscription === null ? null : { id: SXN, status: 3, current_period: 1, next_billing_date: NEXT, ...(options.subscription ?? {}) }
    ),
    cancelSubscription: vi.fn(async () => true),
    createCustomer: vi.fn(),
    findCustomerByEmail: vi.fn(),
    createCard: vi.fn(),
    createPlan: vi.fn(),
    getPlan: vi.fn(),
    createSubscription: vi.fn()
  } as unknown as CulqiClient & Record<string, ReturnType<typeof vi.fn>>;
}

const row = (overrides: Partial<BillingSubscriptionRow> = {}): BillingSubscriptionRow => ({
  id: "bill-1",
  organizationId: "org-1",
  status: "PENDING",
  externalSubscriptionId: SXN,
  billingPeriod: "MONTHLY",
  cancelReason: null,
  ...overrides
});

const deps = (store: BillingStore, culqi: CulqiClient | null): BillingDeps => ({ store, culqi, logger: silentLogger, now: () => NOW });
const received = (): Record<string, WebhookEventRow> => ({ [EVT]: { status: "RECEIVED", attempts: 0 } });

describe("CULQI_EVENT", () => {
  it("valid subscription.charge.succeeded: re-read from Culqi, activated once per billing cycle, event PROCESSED", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi();
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("activated");

    expect(culqi.getEvent).toHaveBeenCalledWith(EVT);
    expect(culqi.getSubscription).toHaveBeenCalledWith(SXN);
    expect(store.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        billingSubscriptionId: "bill-1",
        activationKey: `culqi:${SXN}:${NEXT}`,
        eventType: "subscription.charge.succeeded",
        externalChargeId: "chr_test_CHARGE1",
        periodStart: new Date(NOW).toISOString(),
        periodEnd: new Date(NEXT + CULQI_RENEWAL_GRACE_MS).toISOString(),
        providerStatus: 3
      })
    );
    expect(store.events[EVT]?.status).toBe("PROCESSED");
  });

  it("duplicate delivery: an already processed event does nothing (no Culqi call)", async () => {
    const store = makeStore([row()], { [EVT]: { status: "PROCESSED", attempts: 1 } });
    const culqi = makeCulqi();
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("duplicate");
    expect(culqi.getEvent).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
  });

  it.each([
    ["forged / unknown at Culqi (404)", { event: null }, "NOT_FOUND_AT_CULQI"],
    ["an event type EmailBot does not handle", { event: { id: EVT, type: "order.status.changed", data: {} } }, "UNHANDLED_EVENT_TYPE"],
    ["no subscription in the event", { event: { id: EVT, type: "charge.creation.succeeded", data: { id: "chr_test_X" } } }, "NO_SUBSCRIPTION"],
    ["a malformed event (no type)", { event: { id: EVT, data: {} } as unknown as CulqiEvent }, "UNHANDLED_EVENT_TYPE"]
  ])("%s -> IGNORED, nothing applied", async (_label, options, reason) => {
    const store = makeStore([row()], received());
    expect(await handleCulqiEvent(EVT, deps(store, makeCulqi(options)))).toBe("ignored");
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.updates.at(-1)?.patch).toMatchObject({ status: "IGNORED", lastError: reason, processed: true });
  });

  it("a subscription EmailBot did not create -> IGNORED", async () => {
    const store = makeStore([], received());
    expect(await handleCulqiEvent(EVT, deps(store, makeCulqi()))).toBe("ignored");
    expect(store.updates.at(-1)?.patch).toMatchObject({ lastError: "UNKNOWN_SUBSCRIPTION" });
  });

  it("a live event in the sandbox configuration -> IGNORED without calling Culqi", async () => {
    const live = "evt_live_EVENT0000000001";
    const store = makeStore([row()], { [live]: { status: "RECEIVED", attempts: 0 } });
    const culqi = makeCulqi();
    expect(await handleCulqiEvent(live, deps(store, culqi))).toBe("ignored");
    expect(culqi.getEvent).not.toHaveBeenCalled();
  });

  it("declined charge: recorded once by event id (FAILED / PAST_DUE in the database), no activation", async () => {
    const store = makeStore([row({ status: "ACTIVE" })], received());
    const culqi = makeCulqi({ event: { id: EVT, type: "subscription.charge.failed", data: JSON.stringify({ subscription_id: SXN, charge: "chr_test_DECLINED" }) }, subscription: { status: 5 } });
    expect(await handleCulqiEvent(EVT, deps(store, culqi))).toBe("charge_failed");
    expect(store.recordChargeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: EVT, eventType: "subscription.charge.failed", externalChargeId: "chr_test_DECLINED", failureCode: "charge_failed" })
    );
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("canceled at Culqi (status 4) -> CANCELED (PROVIDER); expired (6) -> EXPIRED", async () => {
    const store = makeStore([row({ status: "ACTIVE" })], received());
    await handleCulqiEvent(EVT, deps(store, makeCulqi({ event: { id: EVT, type: "subscription.cancel.succeeded", data: { id: SXN } }, subscription: { status: 4 } })));
    expect(store.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "CANCELED", cancelReason: "PROVIDER" }));
    expect(store.activate).not.toHaveBeenCalled();

    const expired = makeStore([row({ status: "ACTIVE" })], received());
    await handleCulqiEvent(EVT, deps(expired, makeCulqi({ event: { id: EVT, type: "subscription.charge.succeeded", data: { id: SXN } }, subscription: { status: 6 } })));
    expect(expired.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "EXPIRED" }));
    expect(expired.activate).not.toHaveBeenCalled();
  });

  it("out of order: an older cycle reported by the database as ALREADY_COVERED never shortens anything", async () => {
    const store = makeStore([row({ status: "ACTIVE" })], received());
    store.activate.mockResolvedValueOnce({ outcome: "ALREADY_COVERED", subscriptionId: "sub-1", supersededExternalIds: [] });
    expect(await handleCulqiEvent(EVT, deps(store, makeCulqi()))).toBe("already_covered");
  });

  it("Culqi unavailable: event FAILED with the error code and the job is retried (thrown)", async () => {
    const store = makeStore([row()], received());
    const culqi = makeCulqi();
    culqi.getEvent.mockRejectedValueOnce(new CulqiApiError(503, "api_error", null, null, "getEvent"));
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
    const outcome = await handleEmailEvent({ type: "CULQI_EVENT", eventId: EVT }, {
      billing: { store, culqi: makeCulqi() },
      logger: silentLogger,
      now: () => NOW
    } as never);
    expect(outcome).toEqual({ accounts: 0, enqueued: 0, billing: "activated" });
  });
});

describe("CULQI_RECONCILE (confirmation without webhooks)", () => {
  it("not charged yet (status 1) -> retried later (CulqiStillPendingError); nothing applied", async () => {
    const store = makeStore([row()]);
    await expect(reconcileCulqiSubscription("bill-1", deps(store, makeCulqi({ subscription: { status: 1 } })))).rejects.toBeInstanceOf(CulqiStillPendingError);
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("active at Culqi -> the SAME activation key as the webhook for that cycle (applied once overall)", async () => {
    const store = makeStore([row()]);
    expect(await reconcileCulqiSubscription("bill-1", deps(store, makeCulqi()))).toBe("activated");
    expect(store.activate).toHaveBeenCalledWith(expect.objectContaining({ activationKey: `culqi:${SXN}:${NEXT}`, eventType: "subscription.charge.reconciled" }));
  });

  it("upgrade: once the new subscription is active, the replaced Culqi subscription is canceled at Culqi and marked", async () => {
    const store = makeStore([row()]);
    store.cancellations.push({ id: "bill-old", externalSubscriptionId: "sxn_test_OLD" });
    const culqi = makeCulqi();
    await reconcileCulqiSubscription("bill-1", deps(store, culqi));
    expect(culqi.cancelSubscription).toHaveBeenCalledWith("sxn_test_OLD");
    expect(store.markProviderCanceled).toHaveBeenCalledWith("bill-old");
  });

  it("a failed cancellation at Culqi is retried with the job (not marked)", async () => {
    const store = makeStore([row({ status: "ACTIVE" })]);
    store.cancellations.push({ id: "bill-old", externalSubscriptionId: "sxn_test_OLD" });
    const culqi = makeCulqi();
    culqi.cancelSubscription.mockRejectedValueOnce(new CulqiApiError(500, "api_error", null, null, "cancelSubscription"));
    await expect(reconcileCulqiSubscription("bill-1", deps(store, culqi))).rejects.toBeInstanceOf(CulqiApiError);
    expect(store.markProviderCanceled).not.toHaveBeenCalled();
  });

  it("terminal or never-created subscriptions are ignored", async () => {
    for (const status of ["CANCELED", "EXPIRED"] as const) {
      expect(await reconcileCulqiSubscription("bill-1", deps(makeStore([row({ status })]), makeCulqi()))).toBe("ignored");
    }
    expect(await reconcileCulqiSubscription("bill-1", deps(makeStore([row({ externalSubscriptionId: null })]), makeCulqi()))).toBe("ignored");
  });
});

describe("billing cycle helpers", () => {
  it("period ends at Culqi's next billing date + grace; without it, one plan interval + grace", () => {
    expect(confirmedPeriod({ id: SXN, status: 3, next_billing_date: NEXT / 1000 }, "MONTHLY", NOW).end).toBe(new Date(NEXT + CULQI_RENEWAL_GRACE_MS).toISOString());
    expect(Date.parse(confirmedPeriod({ id: SXN, status: 3 }, "YEARLY", NOW).end) - NOW).toBe(366 * 24 * 3600_000 + CULQI_RENEWAL_GRACE_MS);
  });

  it("activation key: per subscription and billing cycle (seconds or milliseconds give the same key)", () => {
    expect(activationKey({ id: SXN, status: 3, next_billing_date: NEXT })).toBe(activationKey({ id: SXN, status: 3, next_billing_date: NEXT / 1000 }));
    expect(activationKey({ id: SXN, status: 3, current_period: 2 })).toBe(`culqi:${SXN}:p2`);
  });
});
