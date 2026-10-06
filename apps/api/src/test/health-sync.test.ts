import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../config/env.js";
import {
  evaluateSyncHealth,
  isPollSchedulerStalled,
  SYNC_HEALTH_CACHE_MS,
  type PollSchedulerState,
  type SyncHealthCounts
} from "../modules/health/sync-health.js";
import { createTestApp } from "./helpers.js";

/*
 * F8-A B-4 / F8-B: GET /health/sync, public mail-synchronization health for
 * an external uptime monitor. Counts come from the database (fake here; the
 * real queries, including the ACTIVE / inactive organization filters, run in
 * e2e/sync-health.e2e.ts against a local Supabase); the polling scheduler
 * from Redis (fake here; checked against a local Valkey). The response never
 * carries ids, addresses, counts or organization data.
 */

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const MINUTE = 60_000;
const counts = (overrides: Partial<SyncHealthCounts> = {}): SyncHealthCounts => ({
  monitored: 3,
  errored: 0,
  stale: 0,
  erroring: 0,
  watchExpiring: 0,
  stuckEmails: 0,
  failedEmails: 0,
  ...overrides
});

const HEALTHY = { status: "ok", sync: "healthy" };
const IDLE = { status: "ok", sync: "idle" };
const DEGRADED = { status: "degraded", sync: "degraded" };
const ALL_ERROR = { status: "down", sync: "error" };
const STALE = { status: "down", sync: "stale" };
const STALLED = { status: "down", sync: "stalled" };
const UNAVAILABLE = { status: "down", sync: "unavailable" };

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(
  options: {
    counts?: SyncHealthCounts | Error;
    redisUp?: boolean;
    scheduler?: PollSchedulerState | null | Error;
    config?: Partial<ApiConfig>;
  } = {}
) {
  ctx = await createTestApp({ config: options.config ?? {} });
  ctx.deps.readinessChecks.push({
    name: "redis",
    check: async () => {
      if (options.redisUp === false) throw new Error("ECONNREFUSED");
    }
  });
  const value = options.counts ?? counts();
  ctx.privileged.syncHealthCounts.mockImplementation(async () => {
    if (value instanceof Error) throw value;
    return value;
  });
  const scheduler = options.scheduler === undefined ? { next: NOW + 2 * MINUTE, every: 5 * MINUTE } : options.scheduler;
  ctx.queue.pollSchedulerState.mockImplementation(async () => {
    if (scheduler instanceof Error) throw scheduler;
    return scheduler;
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  return ctx;
}

const get = () => ctx!.app.inject({ method: "GET", url: "/health/sync" });

describe("evaluateSyncHealth", () => {
  it.each([
    // Mailboxes in ERROR (D3).
    ["0 syncable accounts", counts({ monitored: 0 }), 200, IDLE],
    ["1 healthy account", counts({ monitored: 1 }), 200, HEALTHY],
    ["1 account, in ERROR", counts({ monitored: 0, errored: 1 }), 503, ALL_ERROR],
    ["2 accounts: one healthy, one in ERROR", counts({ monitored: 1, errored: 1 }), 200, DEGRADED],
    ["2 accounts, both in ERROR", counts({ monitored: 0, errored: 2 }), 503, ALL_ERROR],
    ["one ERROR and the only ACTIVE one stale", counts({ monitored: 1, errored: 1, stale: 1 }), 503, STALE],
    // Freshness of the ACTIVE ones (F8-A).
    ["every mailbox fresh", counts(), 200, HEALTHY],
    ["one of three stale", counts({ stale: 1 }), 200, DEGRADED],
    ["one of two stale (the other syncs)", counts({ monitored: 2, stale: 1 }), 200, DEGRADED],
    ["exactly half stale", counts({ monitored: 4, stale: 2 }), 200, DEGRADED],
    ["two of three stale", counts({ stale: 2 }), 503, STALE],
    ["the only mailbox stale", counts({ monitored: 1, stale: 1 }), 503, STALE],
    ["a recent sync error", counts({ erroring: 1 }), 200, DEGRADED],
    ["a Gmail watch about to expire", counts({ watchExpiring: 1 }), 200, DEGRADED],
    // Stuck / failed emails (never more than degraded).
    ["a stuck email", counts({ stuckEmails: 1 }), 200, DEGRADED],
    ["a failed email in the last 24 h", counts({ failedEmails: 1 }), 200, DEGRADED],
    ["many stuck and failed emails", counts({ stuckEmails: 40, failedEmails: 12 }), 200, DEGRADED],
    ["stuck emails and an account in ERROR", counts({ monitored: 2, errored: 1, stuckEmails: 3 }), 200, DEGRADED],
    ["stuck emails do not turn idle into degraded", counts({ monitored: 0, stuckEmails: 2, failedEmails: 1 }), 200, IDLE]
  ] as const)("%s", (_label, input, statusCode, body) => {
    expect(evaluateSyncHealth(input)).toEqual({ statusCode, body });
  });
});

describe("isPollSchedulerStalled", () => {
  const every = 5 * MINUTE;
  it.each([
    ["no scheduler (polling disabled)", null, NOW, false],
    ["next run in the future", { next: NOW + 3 * MINUTE, every }, NOW, false],
    ["next run due now", { next: NOW, every }, NOW, false],
    ["overdue by less than one interval (worker busy)", { next: NOW - 4 * MINUTE, every }, NOW, false],
    ["overdue by exactly two intervals", { next: NOW - 2 * every, every }, NOW, false],
    ["overdue by more than two intervals", { next: NOW - 2 * every - 1, every }, NOW, true],
    ["overdue by an hour", { next: NOW - 60 * MINUTE, every }, NOW, true],
    ["worker clock ahead of the API (next far in the future)", { next: NOW + 60 * MINUTE, every }, NOW, false],
    ["interval 0", { next: NOW - 60 * MINUTE, every: 0 }, NOW, false],
    ["negative interval", { next: NOW - 60 * MINUTE, every: -every }, NOW, false],
    ["next is not a number", { next: Number.NaN, every }, NOW, false],
    ["interval is not a number", { next: NOW - 60 * MINUTE, every: Number.NaN }, NOW, false],
    ["now is not a number", { next: NOW - 60 * MINUTE, every }, Number.NaN, false]
  ] as const)("%s", (_label, state, now, stalled) => {
    expect(isPollSchedulerStalled(state, now)).toBe(stalled);
  });
});

describe("GET /health/sync", () => {
  it("healthy: 200 with only {status, sync}; public (no session) and never cached by intermediaries", async () => {
    await setup();
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(HEALTHY);
    expect(Object.keys(response.json()).sort()).toEqual(["status", "sync"]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    ["idle", counts({ monitored: 0 }), 200, IDLE],
    ["all accounts in ERROR", counts({ monitored: 0, errored: 2 }), 503, ALL_ERROR],
    ["one account in ERROR", counts({ monitored: 1, errored: 1 }), 200, DEGRADED],
    ["stale", counts({ monitored: 1, stale: 1 }), 503, STALE],
    ["stuck and failed emails", counts({ stuckEmails: 7, failedEmails: 3 }), 200, DEGRADED]
  ] as const)("%s: exact body, no counts or ids leak", async (_label, input, statusCode, body) => {
    await setup({ counts: input });
    const response = await get();
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual(body);
    expect(response.body).not.toMatch(/\d/);
  });

  it("a single failing mailbox among healthy ones does not fail the endpoint (200 degraded)", async () => {
    await setup({ counts: counts({ monitored: 5, stale: 1, erroring: 1 }) });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEGRADED);
  });

  it("Redis down: 503 unavailable, without reading the scheduler or the database", async () => {
    const { privileged, queue } = await setup({ redisUp: false });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE);
    expect(queue.pollSchedulerState).not.toHaveBeenCalled();
    expect(privileged.syncHealthCounts).not.toHaveBeenCalled();
  });

  it("database not readable: 503 unavailable (the error is not exposed)", async () => {
    await setup({ counts: new Error("connection refused to db.internal:5432") });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(UNAVAILABLE);
    expect(response.body).not.toContain("db.internal");
  });

  describe("polling scheduler (worker stalled)", () => {
    it("present and on time: the normal evaluation runs", async () => {
      const { privileged } = await setup({ scheduler: { next: NOW + MINUTE, every: 5 * MINUTE } });
      const response = await get();
      expect(response.json()).toEqual(HEALTHY);
      expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(1);
    });

    it("overdue by more than two intervals: 503 stalled, before (and without) the database counts", async () => {
      const { privileged } = await setup({ scheduler: { next: NOW - 11 * MINUTE, every: 5 * MINUTE } });
      const response = await get();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(STALLED);
      expect(privileged.syncHealthCounts).not.toHaveBeenCalled();
    });

    it("stalled wins over every database state (even idle)", async () => {
      await setup({ scheduler: { next: NOW - 60 * MINUTE, every: 5 * MINUTE }, counts: counts({ monitored: 0 }) });
      expect((await get()).json()).toEqual(STALLED);
    });

    it("absent (polling disabled): not an error", async () => {
      const { privileged } = await setup({ scheduler: null });
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(HEALTHY);
      expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(1);
    });

    it("cannot be read (Redis failing after the readiness check): 503 unavailable", async () => {
      const { privileged } = await setup({ scheduler: new Error("Connection is closed.") });
      const response = await get();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(UNAVAILABLE);
      expect(privileged.syncHealthCounts).not.toHaveBeenCalled();
    });

    it("cache: a stalled result is served for 30 s, then the recovered state", async () => {
      const { queue } = await setup({ scheduler: { next: NOW - 11 * MINUTE, every: 5 * MINUTE } });
      expect((await get()).json()).toEqual(STALLED);
      queue.pollSchedulerState.mockImplementation(async () => ({ next: NOW + 4 * MINUTE, every: 5 * MINUTE }));
      vi.spyOn(Date, "now").mockReturnValue(NOW + SYNC_HEALTH_CACHE_MS - 1);
      expect((await get()).json()).toEqual(STALLED);
      expect(queue.pollSchedulerState).toHaveBeenCalledTimes(1);
      vi.spyOn(Date, "now").mockReturnValue(NOW + SYNC_HEALTH_CACHE_MS);
      expect((await get()).json()).toEqual(HEALTHY);
      expect(queue.pollSchedulerState).toHaveBeenCalledTimes(2);
    });

    it("the evaluation uses the request time: a scheduler that becomes overdue is detected on the next evaluation", async () => {
      await setup({ scheduler: { next: NOW, every: 5 * MINUTE } });
      expect((await get()).json()).toEqual(HEALTHY);
      vi.spyOn(Date, "now").mockReturnValue(NOW + 10 * MINUTE + 1);
      expect((await get()).json()).toEqual(STALLED);
    });
  });

  it("asks for stale mailboxes (20 min), stuck emails (30 min) and failed ones (24 h); without Gmail push, no watch check", async () => {
    const { privileged } = await setup();
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledWith({
      staleBefore: new Date(NOW - 20 * MINUTE).toISOString(),
      watchExpiringBefore: null,
      stuckBefore: new Date(NOW - 30 * MINUTE).toISOString(),
      failedSince: new Date(NOW - 24 * 60 * MINUTE).toISOString()
    });
  });

  it("with Gmail push, only watches within 12 h of expiry count (the worker renews from 24 h, so a normal renewal window is not flagged)", async () => {
    const { privileged } = await setup({ config: { gmailPubSubVerificationToken: "test-push-token-123456" } });
    await get();
    expect(privileged.syncHealthCounts.mock.calls[0]?.[0]).toMatchObject({ watchExpiringBefore: new Date(NOW + 12 * 60 * MINUTE).toISOString() });
  });

  it("the stale threshold is configurable (SYNC_HEALTH_STALE_MINUTES)", async () => {
    const { privileged } = await setup({ config: { syncHealthStaleMinutes: 60 } });
    await get();
    expect(privileged.syncHealthCounts.mock.calls[0]?.[0]).toMatchObject({ staleBefore: new Date(NOW - 60 * MINUTE).toISOString() });
  });

  it("is cached for 30 s: repeated calls do not hit Redis or the database again", async () => {
    const { privileged, queue } = await setup();
    await get();
    await get();
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(1);
    expect(queue.pollSchedulerState).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(NOW + SYNC_HEALTH_CACHE_MS);
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(2);
  });

  it("a clock moved backwards does not pin the cached result", async () => {
    const { privileged } = await setup();
    await get();
    vi.spyOn(Date, "now").mockReturnValue(NOW - MINUTE);
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(2);
  });

  it("the other health endpoints are unchanged", async () => {
    await setup({ redisUp: false });
    expect((await ctx!.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const ready = await ctx!.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready", checks: { redis: "error" } });
  });
});
