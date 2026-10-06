import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateSyncHealth, SYNC_HEALTH_CACHE_MS, type SyncHealthCounts } from "../modules/health/sync-health.js";
import type { ApiConfig } from "../config/env.js";
import { createTestApp } from "./helpers.js";

/*
 * F8-A B-4: GET /health/sync, public mail-synchronization health for an
 * external uptime monitor. Counts come from the database (fake here); the
 * response never carries ids, addresses, counts or organization data.
 */

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const counts = (overrides: Partial<SyncHealthCounts> = {}): SyncHealthCounts => ({ monitored: 3, stale: 0, erroring: 0, watchExpiring: 0, ...overrides });

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(options: { counts?: SyncHealthCounts | Error; redisUp?: boolean; config?: Partial<ApiConfig> } = {}) {
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
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  return ctx;
}

const get = () => ctx!.app.inject({ method: "GET", url: "/health/sync" });

describe("evaluateSyncHealth", () => {
  it.each([
    ["no monitored mailboxes", counts({ monitored: 0 }), 200, { status: "ok", sync: "idle" }],
    ["every mailbox fresh", counts(), 200, { status: "ok", sync: "healthy" }],
    ["one of three stale", counts({ stale: 1 }), 200, { status: "degraded", sync: "degraded" }],
    ["one of two stale (the other syncs)", counts({ monitored: 2, stale: 1 }), 200, { status: "degraded", sync: "degraded" }],
    ["exactly half stale", counts({ monitored: 4, stale: 2 }), 200, { status: "degraded", sync: "degraded" }],
    ["a recent sync error", counts({ erroring: 1 }), 200, { status: "degraded", sync: "degraded" }],
    ["a Gmail watch about to expire", counts({ watchExpiring: 1 }), 200, { status: "degraded", sync: "degraded" }],
    ["two of three stale", counts({ stale: 2 }), 503, { status: "down", sync: "stale" }],
    ["the only mailbox stale", counts({ monitored: 1, stale: 1 }), 503, { status: "down", sync: "stale" }],
    ["every mailbox stale", counts({ stale: 3, erroring: 3 }), 503, { status: "down", sync: "stale" }]
  ] as const)("%s", (_label, input, statusCode, body) => {
    expect(evaluateSyncHealth(input)).toEqual({ statusCode, body });
  });
});

describe("GET /health/sync", () => {
  it("healthy: 200 with only {status, sync}; public (no session) and never cached by intermediaries", async () => {
    await setup();
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", sync: "healthy" });
    expect(Object.keys(response.json()).sort()).toEqual(["status", "sync"]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("no mailboxes to monitor: 200 idle", async () => {
    await setup({ counts: counts({ monitored: 0 }) });
    expect((await get()).json()).toEqual({ status: "ok", sync: "idle" });
  });

  it("two mailboxes, one stale and one healthy: 200 degraded (the pipeline works)", async () => {
    await setup({ counts: counts({ monitored: 2, stale: 1 }) });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "degraded", sync: "degraded" });
  });

  it("synchronization stopped (only mailbox stale): 503", async () => {
    await setup({ counts: counts({ monitored: 1, stale: 1 }) });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "down", sync: "stale" });
  });

  it("a single failing mailbox among healthy ones does not fail the endpoint (200 degraded)", async () => {
    await setup({ counts: counts({ monitored: 5, stale: 1, erroring: 1 }) });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "degraded", sync: "degraded" });
  });

  it("recent error on the mailboxes: degraded", async () => {
    await setup({ counts: counts({ erroring: 2 }) });
    expect((await get()).json()).toEqual({ status: "degraded", sync: "degraded" });
  });

  it("Redis down: 503 unavailable, without reading the database", async () => {
    const { privileged } = await setup({ redisUp: false });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "down", sync: "unavailable" });
    expect(privileged.syncHealthCounts).not.toHaveBeenCalled();
  });

  it("database not readable: 503 unavailable (the error is not exposed)", async () => {
    await setup({ counts: new Error("connection refused to db.internal:5432") });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "down", sync: "unavailable" });
    expect(response.body).not.toContain("db.internal");
  });

  it("asks for mailboxes older than the threshold (default 20 min); without Gmail push, watches are not checked", async () => {
    const { privileged } = await setup();
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledWith({ staleBefore: new Date(NOW - 20 * 60_000).toISOString(), watchExpiringBefore: null });
  });

  it("with Gmail push, only watches within 12 h of expiry count (the worker renews from 24 h, so a normal renewal window is not flagged)", async () => {
    const { privileged } = await setup({ config: { gmailPubSubVerificationToken: "test-push-token-123456" } });
    await get();
    expect(privileged.syncHealthCounts.mock.calls[0]?.[0]).toMatchObject({ watchExpiringBefore: new Date(NOW + 12 * 3_600_000).toISOString() });
  });

  it("the stale threshold is configurable (SYNC_HEALTH_STALE_MINUTES)", async () => {
    const { privileged } = await setup({ config: { syncHealthStaleMinutes: 60 } });
    await get();
    expect(privileged.syncHealthCounts.mock.calls[0]?.[0]).toMatchObject({ staleBefore: new Date(NOW - 60 * 60_000).toISOString() });
  });

  it("is cached for 30 s: repeated calls do not hit the database again", async () => {
    const { privileged } = await setup();
    await get();
    await get();
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(NOW + SYNC_HEALTH_CACHE_MS);
    await get();
    expect(privileged.syncHealthCounts).toHaveBeenCalledTimes(2);
  });

  it("a clock moved backwards does not pin the cached result", async () => {
    const { privileged } = await setup();
    await get();
    vi.spyOn(Date, "now").mockReturnValue(NOW - 60_000);
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
