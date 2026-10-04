/*
 * Rate-limit store for @fastify/rate-limit that never turns a route into
 * "unlimited" when Redis fails.
 *
 * - Redis available: counters are shared by every API instance (atomic Lua
 *   INCR + PEXPIRE).
 * - Redis failing (down, timeout, network): the same request is counted in a
 *   bounded in-memory counter of THIS instance instead. Limits keep applying
 *   (per instance, so N instances allow up to N x max during the outage) and
 *   the API stays available. The previous behaviour (`skipOnError: true`)
 *   skipped limiting entirely.
 */

type Result = { current: number; ttl: number };
type Callback = (error: Error | null, result?: Result) => void;

/** The single ioredis method used (fakes in tests). */
export interface RateLimitRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

const MAX_LOCAL_KEYS = 10_000;

/** Fixed-window counters kept in memory (bounded: oldest keys are evicted first). */
export class LocalCounters {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  increment(key: string, windowMs: number, now = Date.now()): Result {
    let entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.#entries.delete(key);
      if (this.#entries.size >= MAX_LOCAL_KEYS) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
      this.#entries.set(key, entry);
    }
    entry.count += 1;
    return { current: entry.count, ttl: entry.resetAt - now };
  }
}

export interface ResilientStoreOptions {
  prefix: string;
  /** Called when Redis fails and the local fallback is used. */
  onFallback(error: unknown): void;
}

export function createResilientRateLimitStore(redis: RateLimitRedis | undefined, options: ResilientStoreOptions) {
  return class ResilientRateLimitStore {
    readonly prefix: string;
    readonly local = new LocalCounters();

    // @fastify/rate-limit instantiates the store with its global params.
    constructor(_globalParams?: unknown, prefix: string = options.prefix) {
      this.prefix = prefix;
    }

    incr(key: string, callback: Callback, timeWindow: number): void {
      const fallback = () => callback(null, this.local.increment(key, timeWindow));
      if (!redis) return fallback();

      redis.eval(INCR_SCRIPT, 1, `${this.prefix}${key}`, timeWindow).then(
        (reply) => {
          const [current, ttl] = reply as [number, number];
          callback(null, { current: Number(current), ttl: Number(ttl) });
        },
        (error: unknown) => {
          options.onFallback(error);
          fallback();
        }
      );
    }

    /** Per-route store (route-specific limits get their own key space and local counters). */
    child(routeOptions: object) {
      // @fastify/rate-limit passes the route's method/url as `routeInfo` (not in its typings).
      const route = (routeOptions as { routeInfo?: { method?: string; url?: string } }).routeInfo;
      return new ResilientRateLimitStore(undefined, `${this.prefix}${route?.method ?? ""}${route?.url ?? ""}-`);
    }
  };
}
