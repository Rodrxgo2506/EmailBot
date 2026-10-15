import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import {
  ACCELERATED_CANCEL_MS,
  createJobTracker,
  createShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MIN_SHUTDOWN_TIMEOUT_MS,
  shutdownLimits,
  type ShutdownDeps,
  type ShutdownLimits,
  type ShutdownWorker
} from "../infrastructure/shutdown.js";
import { silentLogger } from "./fakes.js";

/*
 * F5.1: the shutdown orchestrator (infrastructure/shutdown.ts) with controllable doubles and short limits. The
 * real BullMQ / Valkey behaviour and the real process exit are in worker-shutdown-bullmq.test.ts.
 */

const LIMITS: ShutdownLimits = { totalMs: 4_000, graceMs: 400, cancelMs: 300, closeMs: 300, releaseMs: 300, flushMs: 200 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => undefined);

function harness(
  options: {
    limits?: Partial<ShutdownLimits>;
    worker?: Partial<Record<"pause" | "close", () => Promise<void>>>;
    release?: () => Promise<unknown>;
    disconnect?: () => void;
    flush?: () => Promise<unknown>;
  } = {}
) {
  const calls: string[] = [];
  /** The structured events logged ("worker.shutdown.phase:grace", "worker.shutdown.deadline", ...). */
  const events: string[] = [];
  const record = (fields: Record<string, unknown>) => void events.push([fields.event, fields.phase ?? fields.step].filter(Boolean).join(":"));
  const exits: number[] = [];
  const tracker = createJobTracker();
  const worker = (name: string): ShutdownWorker => ({
    name,
    pause: async (doNotWait?: boolean) => {
      calls.push(`pause ${name} ${doNotWait}`);
      await options.worker?.pause?.();
    },
    close: async (force?: boolean) => {
      calls.push(`close ${name} force=${force}`);
      await options.worker?.close?.();
    }
  });
  let interrupt: () => void = () => undefined;
  const deps: ShutdownDeps = {
    logger: { ...silentLogger, info: record, warn: record, error: record },
    workers: [worker("events"), worker("processing")],
    tracker,
    markStopping: () => calls.push("markStopping"),
    abortImap: () => calls.push("abortImap"),
    interruptBlockedClients: () => {
      calls.push("interrupt");
      interrupt();
    },
    release: [{ name: "queues", run: async () => (calls.push("release queues"), options.release?.()) }],
    disconnect: () => {
      calls.push("disconnect");
      options.disconnect?.();
    },
    flush: async () => (calls.push("flush"), options.flush?.()),
    exit: (code) => exits.push(code)
  };
  const shutdown = createShutdown(deps, { ...LIMITS, ...options.limits });
  /** A job that runs until `finish()`, or fails when the blocked clients are interrupted (like a hung PUBLISH). */
  const job = (opts: { failOnInterrupt?: boolean } = {}) => {
    let finish: () => void = () => undefined;
    const run = tracker.wrap(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          if (opts.failOnInterrupt) interrupt = () => reject(new Error("Connection is closed."));
        })
    );
    const done = run().catch(() => "failed");
    return { finish: () => finish(), done };
  };
  return { shutdown, calls, events, exits, tracker, job };
}

describe("F5.1: shutdown orchestrator", () => {
  it("1. no job in flight: stop, pause, close (not forced), release, disconnect, flush, exit 0", async () => {
    const box = harness();
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(0);
    expect(Date.now() - started).toBeLessThan(200);
    expect(box.calls).toEqual([
      "markStopping",
      "abortImap",
      "pause events true",
      "pause processing true",
      "close events force=false",
      "close processing force=false",
      "release queues",
      "disconnect",
      "flush"
    ]);
    expect(box.exits).toEqual([0]);
  });

  it("2. jobs that finish within the grace period: waited for, nothing interrupted or forced, exit 0", async () => {
    const box = harness();
    const a = box.job();
    const b = box.job();
    setTimeout(() => a.finish(), 100);
    setTimeout(() => b.finish(), 200);
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(box.calls).not.toContain("interrupt");
    expect(box.calls.filter((call) => call.startsWith("close"))).toEqual(["close events force=false", "close processing force=false"]);
  });

  it("3. a job that never finishes: grace, interrupt, cancel window, close FORCED (the job is not completed), exit 1 - within the budget", async () => {
    const box = harness();
    const hung = box.job();
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(1);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(LIMITS.graceMs + LIMITS.cancelMs - 20);
    expect(elapsed).toBeLessThan(LIMITS.graceMs + LIMITS.cancelMs + LIMITS.closeMs + 200);
    expect(box.calls).toContain("interrupt");
    expect(box.calls.filter((call) => call.startsWith("close"))).toEqual(["close events force=true", "close processing force=true"]);
    expect(box.tracker.active()).toBe(1); // still running: left to BullMQ (stays active, retried after its lock expires)
    expect(box.exits).toEqual([1]);
    void hung;
  });

  it("3b. a job waiting on the interrupted client fails in the cancel window: close not forced (it is retried by BullMQ), exit 1", async () => {
    const box = harness();
    const blocked = box.job({ failOnInterrupt: true });
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(1);
    expect(await blocked.done).toBe("failed");
    expect(box.calls.filter((call) => call.startsWith("close"))).toEqual(["close events force=false", "close processing force=false"]);
  });

  it("4. a second signal skips the rest of the grace period (and shortens the cancel window)", async () => {
    const box = harness({ limits: { graceMs: 10_000, cancelMs: 3_000, totalMs: 20_000 } });
    box.job();
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    setTimeout(() => box.shutdown.onSignal("SIGTERM"), 100);
    expect(await box.shutdown.running).toBe(1);
    expect(Date.now() - started).toBeLessThan(100 + 1_000 + LIMITS.closeMs + 400);
  });

  it("5. simultaneous signals: ONE sequence (each step once); a third signal exits at once, exit is called only once", async () => {
    const box = harness({ limits: { graceMs: 5_000, totalMs: 10_000 } });
    box.job();
    box.shutdown.onSignal("SIGTERM");
    box.shutdown.onSignal("SIGINT");
    box.shutdown.onSignal("SIGTERM");
    expect(box.exits).toEqual([1]); // third signal
    await box.shutdown.running;
    expect(box.calls.filter((call) => call === "markStopping")).toHaveLength(1);
    expect(box.calls.filter((call) => call.startsWith("pause"))).toHaveLength(2);
    expect(box.exits).toEqual([1]); // the sequence's own exit is ignored
  });

  it("6. a step that never returns (pause, close or a release) is bounded; the sequence goes on and exits 1", async () => {
    const box = harness({ worker: { close: never }, release: never });
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(1);
    expect(Date.now() - started).toBeLessThan(LIMITS.closeMs + LIMITS.releaseMs + 200);
    expect(box.calls).toContain("disconnect");
  });

  it("6b. worst case, EVERY step hangs (pause, the job, close, release, flush): the phases still end by themselves within the total budget, exit 1 - not by the emergency exit", async () => {
    // Limits summed without the budget: 300 pause + 900 grace + 300 cancel + 300 close + 300 release + 200 flush = 2300 > 2000.
    const limits = { totalMs: 2_000, graceMs: 900 };
    const box = harness({ limits, worker: { pause: never, close: never }, release: never, flush: never });
    box.job();
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(1);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(limits.totalMs);
    expect(elapsed).toBeGreaterThanOrEqual(limits.totalMs - 200);
    expect(box.events).not.toContain("worker.shutdown.deadline");
    expect(box.events).toContain("worker.shutdown.phase:exit");
    // the parallel steps were bounded once, not once per worker / item
    expect(box.events.filter((event) => event.startsWith("worker.shutdown.timeout:"))).toEqual([
      "worker.shutdown.timeout:pause events",
      "worker.shutdown.timeout:pause processing",
      "worker.shutdown.timeout:grace (active jobs)",
      "worker.shutdown.timeout:cancel (active jobs)",
      "worker.shutdown.timeout:close events",
      "worker.shutdown.timeout:close processing",
      "worker.shutdown.timeout:queues",
      "worker.shutdown.timeout:flush"
    ]);
  });

  it("6c. a Sentry flush that does not finish in time makes the exit code 1", async () => {
    const box = harness({ flush: never });
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(1);
    expect(box.exits).toEqual([1]);
  });

  it("4b. a second signal DURING the cancel window shortens it to ACCELERATED_CANCEL_MS", async () => {
    const box = harness({ limits: { graceMs: 300, cancelMs: 5_000, totalMs: 20_000 } });
    box.job();
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    setTimeout(() => box.shutdown.onSignal("SIGTERM"), 300 + 200);
    expect(await box.shutdown.running).toBe(1);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(300 + ACCELERATED_CANCEL_MS - 20);
    expect(elapsed).toBeLessThan(300 + ACCELERATED_CANCEL_MS + 400);
  });

  it("7. the emergency exit is the backstop: an event loop blocked past the deadline exits at the budget (logged as a deadline, nothing reported as cancelled)", async () => {
    const busy = (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        // blocks the event loop, like a synchronous step that takes too long
      }
    };
    const box = harness({ limits: { totalMs: 600, graceMs: 100 }, disconnect: () => busy(700), flush: never });
    const started = Date.now();
    box.shutdown.onSignal("SIGTERM");
    expect(await box.shutdown.running).toBe(1); // the sequence itself ends only after the emergency exit
    expect(box.exits).toEqual([1]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(box.events).toContain("worker.shutdown.deadline");
    // the emergency exit came first; the sequence's own exit afterwards is ignored (a real process is gone by then)
    expect(box.events.indexOf("worker.shutdown.deadline")).toBeLessThan(box.events.indexOf("worker.shutdown.phase:exit"));
  });

  it("the tracker counts processors in flight, also when they fail, and wakes the waiters when idle", async () => {
    const tracker = createJobTracker();
    await expect(tracker.whenIdle()).resolves.toBeUndefined();
    let release: () => void = () => undefined;
    const ok = tracker.wrap(() => new Promise<string>((resolve) => (release = () => resolve("ok"))))();
    const failing = tracker.wrap(async () => {
      throw new Error("x");
    })();
    await expect(failing).rejects.toThrow("x");
    expect(tracker.active()).toBe(1);
    let idle = false;
    void tracker.whenIdle().then(() => (idle = true));
    await sleep(20);
    expect(idle).toBe(false);
    release();
    await expect(ok).resolves.toBe("ok");
    await sleep(0);
    expect(idle).toBe(true);
  });

  it("budget: 25 s by default (11.9 s grace + 3 cancel + 3 close + 5 release + 2 flush + 0.1 margin), at least 15 s, configurable", () => {
    expect(shutdownLimits(DEFAULT_SHUTDOWN_TIMEOUT_MS)).toEqual({ totalMs: 25_000, graceMs: 11_900, cancelMs: 3_000, closeMs: 3_000, releaseMs: 5_000, flushMs: 2_000 });
    expect(shutdownLimits(MIN_SHUTDOWN_TIMEOUT_MS).graceMs).toBe(1_900);
    for (const limits of [shutdownLimits(DEFAULT_SHUTDOWN_TIMEOUT_MS), shutdownLimits(MIN_SHUTDOWN_TIMEOUT_MS)]) {
      expect(limits.graceMs + limits.cancelMs + limits.closeMs + limits.releaseMs + limits.flushMs).toBeLessThan(limits.totalMs);
    }
    const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };
    expect(loadWorkerConfig(base).shutdownTimeoutMs).toBe(25_000);
    expect(loadWorkerConfig({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }).shutdownTimeoutMs).toBe(60_000);
    expect(() => loadWorkerConfig({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: "14999" })).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS/);
    expect(() => loadWorkerConfig({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: "600001" })).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS/);
    expect(() => loadWorkerConfig({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: "20000.5" })).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS/);
    expect(() => loadWorkerConfig({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: "abc" })).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS/);
    expect(loadWorkerConfig(base).imapSyncEnabled).toBe(false); // 10. IMAP stays disabled
  });
});
