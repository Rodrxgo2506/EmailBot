import { LocalCounters, type RateLimitRedis } from "./rate-limit-store.js";

/*
 * Portal login lockout (EmailBot V2 phase 4): after MAX_FAILURES failed
 * logins from one IP within the failure window, that IP is locked for
 * LOCK_MS. Complements the 5/minute route rate limit.
 *
 * Same mechanism as the resilient rate-limit store: counters in Redis
 * (shared by every API instance, atomic Lua) and, when Redis fails, the same
 * bounded per-instance LocalCounters (limits keep applying per instance).
 * Keys contain the IP only, never the submitted Access ID.
 *
 * The thresholds are a policy (default LOGIN_LOCKOUT, the portal's); other
 * consumers (IMAP connection tests) pass their own.
 *
 * failClosed (IMAP): no per-instance fallback. Without Redis, or when it fails,
 * every call rejects with LockoutStoreUnavailableError, so the caller refuses
 * the operation instead of counting per instance. Default false (the portal).
 */

/** maxFailures refused attempts within failureWindowMs lock the key for lockMs. */
export interface LockoutPolicy {
  readonly maxFailures: number;
  readonly failureWindowMs: number;
  readonly lockMs: number;
}

export const LOGIN_LOCKOUT = {
  maxFailures: 10,
  failureWindowMs: 15 * 60_000,
  lockMs: 15 * 60_000
} as const satisfies LockoutPolicy;

export const FAIL_SCRIPT = `
local failures = redis.call('INCR', KEYS[1])
if failures == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if failures >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return tonumber(ARGV[3])
end
return 0
`;
export const LOCK_TTL_SCRIPT = "local ttl = redis.call('PTTL', KEYS[1]) if ttl > 0 then return ttl end return 0";
export const RESET_SCRIPT = "redis.call('DEL', KEYS[1]) return 0";

/** The shared lockout store could not be used (failClosed only). Never carries the Redis error text to clients. */
export class LockoutStoreUnavailableError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The lockout store is unavailable");
    this.name = "LockoutStoreUnavailableError";
  }
}

export interface LoginThrottle {
  /** Milliseconds until the key is unlocked (0 = not locked). */
  lockedFor(key: string): Promise<number>;
  /** Counts a failure; returns the lock duration when this failure triggers the lock (else 0). */
  recordFailure(key: string): Promise<number>;
  /** A successful login clears the failure counter. */
  recordSuccess(key: string): Promise<void>;
}

export function createLoginThrottle(
  redis: RateLimitRedis | undefined,
  options: { prefix?: string; onFallback(error: unknown): void; now?: () => number; policy?: LockoutPolicy; failClosed?: boolean; timeoutMs?: number }
): LoginThrottle {
  const prefix = options.prefix ?? "emailbot-portal-login:";
  const policy = options.policy ?? LOGIN_LOCKOUT;
  const now = options.now ?? Date.now;
  const failures = new LocalCounters();
  const locks = new Map<string, number>();

  const local = {
    lockedFor(key: string) {
      const until = locks.get(key) ?? 0;
      if (until <= now()) {
        locks.delete(key);
        return 0;
      }
      return until - now();
    },
    recordFailure(key: string) {
      const { current } = failures.increment(key, policy.failureWindowMs, now());
      if (current < policy.maxFailures) return 0;
      failures.reset(key);
      if (locks.size >= 10_000) locks.delete(locks.keys().next().value as string);
      locks.set(key, now() + policy.lockMs);
      return policy.lockMs;
    },
    recordSuccess(key: string) {
      failures.reset(key);
    }
  };

  async function withFallback<T>(remote: (redis: RateLimitRedis) => Promise<T>, fallback: () => T): Promise<T> {
    if (options.failClosed) {
      if (!redis) throw new LockoutStoreUnavailableError();
      try {
        return await withTimeout(remote(redis), options.timeoutMs);
      } catch (error) {
        throw new LockoutStoreUnavailableError(error);
      }
    }
    if (!redis) return fallback();
    try {
      return await remote(redis);
    } catch (error) {
      options.onFallback(error);
      return fallback();
    }
  }

  return {
    lockedFor: (key) =>
      withFallback(async (r) => Number(await r.eval(LOCK_TTL_SCRIPT, 1, `${prefix}lock:${key}`)), () => local.lockedFor(key)),
    recordFailure: (key) =>
      withFallback(
        async (r) =>
          Number(
            await r.eval(
              FAIL_SCRIPT,
              2,
              `${prefix}fail:${key}`,
              `${prefix}lock:${key}`,
              policy.failureWindowMs,
              policy.maxFailures,
              policy.lockMs
            )
          ),
        () => local.recordFailure(key)
      ),
    recordSuccess: (key) =>
      withFallback(
        async (r) => {
          await r.eval(RESET_SCRIPT, 1, `${prefix}fail:${key}`);
        },
        () => local.recordSuccess(key)
      )
  };
}

/** Rejects when `promise` takes longer than `ms` (no timeout when ms is undefined). */
export function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("store timeout")), ms);
  });
  // The losing promise still settles later: never an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
