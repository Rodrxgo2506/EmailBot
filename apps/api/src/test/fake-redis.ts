import { FAIL_SCRIPT, LOCK_TTL_SCRIPT, RESET_SCRIPT } from "../infrastructure/login-throttle.js";
import { INCR_SCRIPT, type RateLimitRedis } from "../infrastructure/rate-limit-store.js";
import { ACQUIRE_SLOT_SCRIPT, RELEASE_SCRIPT, RESERVE_SCRIPT } from "../modules/email-accounts/imap-connection.js";

/*
 * In-memory stand-in for the Redis EVAL calls of the API's limiters (tests only).
 * It runs the semantics of each KNOWN Lua script (identified by its exact text:
 * a changed script fails loudly here) on keys with millisecond expiry, using
 * Date.now() so fake timers apply. One instance can be shared by several test
 * apps to model API instances sharing one Redis.
 *
 * This is NOT Redis: it proves the limiter logic and the call sequence, not the
 * Lua itself nor real multi-process behaviour (see docs/imap.md).
 *
 *   mode "up"    normal
 *   mode "down"  every call rejects (connection refused)
 *   mode "slow"  calls never settle (a hung Redis; callers must time out); `slowOnly`
 *               limits it to some keys (e.g. the IMAP ones, so the per-IP limiter,
 *               bounded by ioredis commandTimeout in production, is not involved)
 */
export class FakeRedis implements RateLimitRedis {
  mode: "up" | "down" | "slow" = "up";
  slowOnly: ((keys: string[]) => boolean) | null = null;
  readonly calls: Array<{ script: string; keys: string[] }> = [];
  readonly #entries = new Map<string, { value: number | string; expiresAt: number | null }>();

  /** Keys currently alive (for assertions on what is stored). */
  keys(): string[] {
    for (const key of [...this.#entries.keys()]) this.#live(key);
    return [...this.#entries.keys()];
  }

  async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys).map(String);
    const argv = args.slice(numberOfKeys).map(String);
    this.calls.push({ script: this.#name(script), keys });
    if (this.mode === "down") throw new Error("connect ECONNREFUSED fake-redis");
    if (this.mode === "slow" && (this.slowOnly === null || this.slowOnly(keys))) return new Promise(() => undefined);
    const [k1, k2] = keys as [string, string];
    switch (script) {
      case INCR_SCRIPT: {
        const current = this.#incr(k1, 1);
        let ttl = this.#pttl(k1);
        if (current === 1 || ttl < 0) {
          this.#pexpire(k1, Number(argv[0]));
          ttl = Number(argv[0]);
        }
        return [current, ttl];
      }
      case FAIL_SCRIPT: {
        const failures = this.#incr(k1, 1);
        if (failures === 1) this.#pexpire(k1, Number(argv[0]));
        if (failures >= Number(argv[1])) {
          this.#entries.set(k2, { value: "1", expiresAt: Date.now() + Number(argv[2]) });
          this.#entries.delete(k1);
          return Number(argv[2]);
        }
        return 0;
      }
      case LOCK_TTL_SCRIPT: {
        const ttl = this.#pttl(k1);
        return ttl > 0 ? ttl : 0;
      }
      case RESET_SCRIPT:
        this.#entries.delete(k1);
        return 0;
      case RESERVE_SCRIPT: {
        const current = this.#incr(k1, 1);
        if (current === 1 || this.#pttl(k1) < 0) this.#pexpire(k1, Number(argv[0]));
        if (current > Number(argv[1])) {
          this.#incr(k1, -1);
          return 0;
        }
        return 1;
      }
      case RELEASE_SCRIPT: {
        const current = Number(this.#live(k1)?.value ?? 0);
        if (current > 0) this.#incr(k1, -1);
        return 0;
      }
      case ACQUIRE_SLOT_SCRIPT: {
        const current = this.#incr(k1, 1);
        if (current > Number(argv[0])) {
          this.#incr(k1, -1);
          if (this.#pttl(k1) < 0) this.#pexpire(k1, Number(argv[1]));
          return 0;
        }
        this.#pexpire(k1, Number(argv[1]));
        return 1;
      }
      default:
        throw new Error("FakeRedis: unknown script");
    }
  }

  #name(script: string): string {
    const names: Array<[string, string]> = [
      [INCR_SCRIPT, "INCR"],
      [FAIL_SCRIPT, "FAIL"],
      [LOCK_TTL_SCRIPT, "LOCK_TTL"],
      [RESET_SCRIPT, "RESET"],
      [RESERVE_SCRIPT, "RESERVE"],
      [RELEASE_SCRIPT, "RELEASE"],
      [ACQUIRE_SLOT_SCRIPT, "ACQUIRE_SLOT"]
    ];
    return names.find(([text]) => text === script)?.[1] ?? "UNKNOWN";
  }

  #live(key: string) {
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** INCRBY that keeps the expiry (like Redis INCR / DECR). */
  #incr(key: string, by: number): number {
    const entry = this.#live(key);
    const value = Number(entry?.value ?? 0) + by;
    this.#entries.set(key, { value, expiresAt: entry?.expiresAt ?? null });
    return value;
  }

  #pexpire(key: string, ms: number): void {
    const entry = this.#live(key);
    if (entry) entry.expiresAt = Date.now() + ms;
  }

  /** -2 missing, -1 no expiry, else remaining ms. */
  #pttl(key: string): number {
    const entry = this.#live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - Date.now();
  }
}
