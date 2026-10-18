/*
 * Worker without CULQI_SECRET_KEY (billing.culqi = null): the reconciliation paths never call Culqi and never touch the
 * billing store.
 *  - store: a Proxy that records ANY method call (read or write) and fails it;
 *  - network: globalThis.fetch replaced by a spy that fails if called (the Culqi client is built on fetch);
 *  - the paths: reconcileCulqiSubscription, reconcileDueCulqiSubscriptions, and both job types through handleEmailEvent
 *    (CULQI_RECONCILE, CULQI_RECONCILE_DUE), the way the queue reaches them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileCulqiSubscription, reconcileDueCulqiSubscriptions, type BillingDeps } from "../pipeline/billing.js";
import { handleEmailEvent } from "../pipeline/handle-email-event.js";
import { silentLogger } from "./fakes.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function trackingStore() {
  const calls: string[] = [];
  const store = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined; // not a thenable
        return (..._args: unknown[]) => {
          calls.push(String(property));
          throw new Error(`billing store must not be used without Culqi (called ${String(property)})`);
        };
      }
    }
  ) as BillingDeps["store"];
  return { store, calls };
}

function logger() {
  return { ...silentLogger, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as BillingDeps["logger"] & {
    error: ReturnType<typeof vi.fn>;
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("no network call is allowed without Culqi");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("Culqi not configured on the worker (culqi = null)", () => {
  it("reconcileCulqiSubscription: not_configured, logged as an error, no store call, no network", async () => {
    const { store, calls } = trackingStore();
    const log = logger();
    const outcome = await reconcileCulqiSubscription("11111111-1111-4111-8111-111111111111", { store, culqi: null, logger: log, now: () => NOW });
    expect(outcome).toBe("not_configured");
    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "billing.culqi.not_configured" }), expect.any(String));
  });

  it("reconcileDueCulqiSubscriptions: all counters 0, no store call (no read of PENDING / due rows), no network", async () => {
    const { store, calls } = trackingStore();
    const result = await reconcileDueCulqiSubscriptions({ store, culqi: null, logger: logger(), now: () => NOW });
    expect(result).toEqual({ reconciled: 0, expired: 0, reviewRequired: 0, reviewed: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("through the queue: CULQI_RECONCILE_DUE and CULQI_RECONCILE jobs do nothing, no store call, no network", async () => {
    const { store, calls } = trackingStore();
    const deps = { billing: { store, culqi: null }, logger: logger(), now: () => NOW } as never;
    const due = await handleEmailEvent({ type: "CULQI_RECONCILE_DUE" } as never, deps);
    const one = await handleEmailEvent({ type: "CULQI_RECONCILE", billingSubscriptionId: "11111111-1111-4111-8111-111111111111" } as never, deps);
    expect(due).toMatchObject({ accounts: 0, enqueued: 0, billingReconcile: { reconciled: 0, expired: 0, reviewRequired: 0, reviewed: 0, failed: 0 } });
    expect(one).toMatchObject({ accounts: 0, enqueued: 0, billing: "not_configured" });
    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a worker without billing wiring at all (deps.billing undefined): same, nothing called", async () => {
    const deps = { logger: logger(), now: () => NOW } as never;
    expect(await handleEmailEvent({ type: "CULQI_RECONCILE_DUE" } as never, deps)).toMatchObject({ billingReconcile: { reconciled: 0, expired: 0, failed: 0 } });
    expect(await handleEmailEvent({ type: "CULQI_RECONCILE", billingSubscriptionId: "x" } as never, deps)).toMatchObject({ billing: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
