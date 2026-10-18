import { serializeError } from "@emailbot/shared";
import type { Logger } from "../pipeline/ports.js";

/*
 * F5.1: bounded, phased shutdown of the worker.
 *
 * BullMQ facts this relies on (bullmq 5.81.5, Worker):
 *   - close() is memoized: once called, a later close(true) returns the SAME promise and forces nothing, so the
 *     force decision is taken once, when close is first called;
 *   - close() (not forced) waits for every active job's processor to settle, with no timeout of its own;
 *   - close(true) does not wait for them: they stay "active" in Redis; once their lock expires (lockDuration,
 *     30 s by default) a stalled check of a running worker - another instance, or this one after the restart -
 *     moves them back to waiting and they run again (nothing is marked completed or deleted);
 *   - pause(true) stops fetching new jobs at once, without waiting for active ones and without Redis calls.
 *
 * Phases (all inside one total budget; an emergency exit fires when it is spent, whatever is still pending):
 *   1. stop: health "stopping", pause(true) on every worker (no new job), abortImapOperations() (real
 *      cancellation: IMAP sockets are closed and no IMAP operation may start, A2);
 *   2. grace: wait for the jobs in flight (counted by the JobTracker around each processor) to settle;
 *   3. cancel (only if some are still running): interrupt the clients whose pending commands may be dropped
 *      (the realtime publisher: its waiting commands are rejected - against a server that does not answer, only
 *      after ioredis' disconnectTimeout, 2 s by default, hence the 3 s cancel window - the jobs fail and BullMQ
 *      retries them; a job still running after the window is left to the forced close below);
 *      HTTP requests have no cancellation here (F5.4), Redis commands of the shared connection none either (F5.2);
 *   4. close: close(force) on every worker, force = some job is still running; each bounded;
 *   5. release: IMAP pool, queues, health server (each bounded, in parallel), then the Redis connections are
 *      disconnected (pending commands rejected) and Sentry flushed (bounded);
 *   6. exit: 0 when every phase finished on its own, 1 when anything had to be forced or timed out.
 * Every phase is bounded by its own limit AND by what the total budget leaves after it for the phases that follow,
 * so the sequence ends by itself within the budget (the emergency exit is only a backstop, e.g. for an event loop
 * blocked past the deadline). A second signal skips the rest of the grace period and shortens the cancel window to
 * ACCELERATED_CANCEL_MS (also when it arrives during it); a third one exits at once. Only one sequence ever runs.
 * Waiting that times out only stops the waiting, and neither exit code 1 nor the emergency exit means anything was
 * cancelled: an HTTP or SQL write already sent may still be committed by the server (see docs/render.md, "Apagado del worker").
 */

/** Fixed parts of the budget (ms); the grace period is what remains of the total (minus SHUTDOWN_EXIT_MARGIN_MS). */
export const SHUTDOWN_RESERVE = Object.freeze({ cancelMs: 3_000, closeMs: 3_000, releaseMs: 5_000, flushMs: 2_000 });
export const MIN_SHUTDOWN_TIMEOUT_MS = 15_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
/** Cancel window after a second signal. */
export const ACCELERATED_CANCEL_MS = 1_000;
/** The phases plan to end this long before the total budget, so they never race the emergency exit. */
export const SHUTDOWN_EXIT_MARGIN_MS = 100;

export interface ShutdownLimits {
  totalMs: number;
  graceMs: number;
  cancelMs: number;
  closeMs: number;
  releaseMs: number;
  flushMs: number;
}

/** The phases' limits for a total budget (validated by the config: >= MIN_SHUTDOWN_TIMEOUT_MS). */
export function shutdownLimits(totalMs: number): ShutdownLimits {
  const reserve = SHUTDOWN_RESERVE.cancelMs + SHUTDOWN_RESERVE.closeMs + SHUTDOWN_RESERVE.releaseMs + SHUTDOWN_RESERVE.flushMs + SHUTDOWN_EXIT_MARGIN_MS;
  return { totalMs, graceMs: Math.max(0, totalMs - reserve), ...SHUTDOWN_RESERVE };
}

/** Counts the processors in flight (wrap every BullMQ processor with it). */
export interface JobTracker {
  wrap<A extends unknown[], R>(processor: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
  active(): number;
  /** Resolves once no processor is running (at once when none is). */
  whenIdle(): Promise<void>;
}

export function createJobTracker(): JobTracker {
  let active = 0;
  let waiters: Array<() => void> = [];
  const settle = () => {
    active -= 1;
    if (active === 0) for (const wake of waiters.splice(0)) wake();
  };
  return {
    wrap(processor) {
      return async (...args) => {
        active += 1;
        try {
          return await processor(...args);
        } finally {
          settle();
        }
      };
    },
    active: () => active,
    whenIdle: () => (active === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)))
  };
}

export interface ShutdownWorker {
  readonly name: string;
  pause(doNotWaitActive?: boolean): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export interface ShutdownDeps {
  logger: Logger;
  workers: ShutdownWorker[];
  tracker: JobTracker;
  /** Health: report "stopping" (not ready). */
  markStopping(): void;
  /** Real cancellation of the IMAP operations; refuses new ones (A2). */
  abortImap(): void;
  /** After the grace period: clients whose pending commands may be dropped (the realtime publisher). */
  interruptBlockedClients(): void;
  /** Released in parallel after the workers, each bounded by releaseMs. */
  release: Array<{ name: string; run(): Promise<unknown> | unknown }>;
  /** Last: disconnect the Redis connections (synchronous; pending commands are rejected). */
  disconnect(): void;
  flush(): Promise<unknown>;
  exit(code: number): void;
}

type Outcome = "ok" | "timeout" | "error";

export interface Shutdown {
  /** SIGTERM / SIGINT handler: starts the sequence once; a second call speeds it up, a third exits at once. */
  onSignal(signal: string): void;
  /** The running sequence (tests). */
  readonly running: Promise<number> | null;
}

export function createShutdown(deps: ShutdownDeps, limits: ShutdownLimits): Shutdown {
  const { logger } = deps;
  let running: Promise<number> | null = null;
  let signals = 0;
  let exited = false;
  let accelerate: () => void = () => undefined;
  const accelerated = new Promise<void>((resolve) => (accelerate = resolve));

  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  /** Waits for `work` at most `ms` (or until `cut` settles); the work itself goes on (no cancellation). */
  async function bounded(name: string, work: () => Promise<unknown> | unknown, ms: number, cut?: Promise<void>): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    const started = Date.now();
    try {
      const promise = Promise.resolve().then(work);
      promise.catch(() => undefined);
      const outcome = await Promise.race<Outcome>([
        promise.then(() => "ok" as const),
        new Promise<Outcome>((resolve) => (timer = setTimeout(() => resolve("timeout"), ms))),
        ...(cut ? [cut.then(() => "timeout" as const)] : [])
      ]);
      if (outcome === "timeout") logger.warn({ event: "worker.shutdown.timeout", step: name, waitedMs: Date.now() - started }, "shutdown step did not finish in time");
      return outcome;
    } catch (error) {
      logger.warn({ event: "worker.shutdown.error", step: name, err: serializeError(error) }, "shutdown step failed");
      return "error";
    } finally {
      clearTimeout(timer);
    }
  }

  async function sequence(signal: string): Promise<number> {
    const started = Date.now();
    const deadline = started + limits.totalMs - SHUTDOWN_EXIT_MARGIN_MS;
    /** At most `ms`, and never more than leaves `reservedMs` of the total budget to the phases that follow. */
    const within = (ms: number, reservedMs: number) => Math.max(0, Math.min(ms, deadline - reservedMs - Date.now()));
    const phase = (name: string, extra: Record<string, unknown> = {}) =>
      logger.info({ event: "worker.shutdown.phase", phase: name, elapsedMs: Date.now() - started, activeJobs: deps.tracker.active(), ...extra }, `shutdown: ${name}`);
    const emergency = setTimeout(() => {
      logger.error({ event: "worker.shutdown.deadline", totalMs: limits.totalMs, activeJobs: deps.tracker.active() }, "shutdown deadline reached; exiting now");
      exit(1);
    }, limits.totalMs);
    const afterRelease = limits.flushMs;
    const afterClose = afterRelease + limits.releaseMs;
    const afterCancel = afterClose + limits.closeMs;
    const afterGrace = afterCancel + limits.cancelMs;
    let clean = true;

    phase("stop", { signal, limits });
    deps.markStopping();
    deps.abortImap();
    const pauseMs = within(limits.closeMs, afterGrace);
    const paused = await Promise.all(deps.workers.map((worker) => bounded(`pause ${worker.name}`, () => worker.pause(true), pauseMs)));
    if (paused.some((outcome) => outcome !== "ok")) clean = false;

    phase("grace");
    if ((await bounded("grace (active jobs)", () => deps.tracker.whenIdle(), within(limits.graceMs, afterGrace), accelerated)) !== "ok") {
      clean = false;
      phase("cancel");
      deps.interruptBlockedClients();
      const cancelStarted = Date.now();
      const shortened = accelerated.then(() => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, cancelStarted + ACCELERATED_CANCEL_MS - Date.now()))));
      await bounded("cancel (active jobs)", () => deps.tracker.whenIdle(), within(limits.cancelMs, afterCancel), shortened);
    }

    const force = deps.tracker.active() > 0;
    phase("close", { force });
    const closeMs = within(limits.closeMs, afterClose);
    const closed = await Promise.all(deps.workers.map((worker) => bounded(`close ${worker.name}`, () => worker.close(force), closeMs)));
    if (force || closed.some((outcome) => outcome !== "ok")) clean = false;

    phase("release");
    const releaseMs = within(limits.releaseMs, afterRelease);
    const released = await Promise.all(deps.release.map((item) => bounded(item.name, () => item.run(), releaseMs)));
    if (released.some((outcome) => outcome !== "ok")) clean = false;
    try {
      deps.disconnect();
    } catch (error) {
      clean = false;
      logger.warn({ event: "worker.shutdown.error", step: "disconnect", err: serializeError(error) }, "shutdown step failed");
    }
    if ((await bounded("flush", () => deps.flush(), within(limits.flushMs, 0))) !== "ok") clean = false;
    clearTimeout(emergency);
    phase("exit", { clean });
    const code = clean ? 0 : 1;
    exit(code);
    return code;
  }

  return {
    onSignal(signal) {
      signals += 1;
      if (signals === 1) {
        running = sequence(signal).catch((error: unknown) => {
          logger.error({ event: "worker.shutdown.error", err: serializeError(error) }, "error during shutdown");
          exit(1);
          return 1;
        });
        return;
      }
      if (signals === 2) {
        logger.warn({ event: "worker.shutdown.accelerated", signal }, "second signal: skipping the rest of the grace period");
        accelerate();
        return;
      }
      logger.error({ event: "worker.shutdown.forced", signal }, "third signal: exiting now");
      exit(1);
    },
    get running() {
      return running;
    }
  };
}
