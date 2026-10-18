import { randomUUID } from "node:crypto";
import type { SyncLock } from "../pipeline/ports.js";
import { redisOutcome, type AppRedis } from "./app-redis.js";

/*
 * Per-account sync lease in Redis (the same Redis as BullMQ): SET NX PX to
 * acquire, compare-and-delete (Lua) to release only our own lease. Different
 * accounts never block each other. If a lease expires mid-run, the cursor
 * compare-and-set still prevents a lost or regressed cursor.
 *
 * F5.2: a failed acquire is never a lease (the error reaches the job, which is retried). When its result is
 * unknown (timed out after being sent: Redis may still set the key), our own token is released at once with the
 * same compare-and-delete: on the same connection it runs after the SET, so a late SET leaves no orphan lease
 * (otherwise the account's syncs would wait for the TTL). Releasing is idempotent; if it fails too, a late lease
 * expires with its TTL.
 */

const RELEASE_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/** The ioredis methods used (fakes in tests). */
export interface LockRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export function createRedisSyncLock(redis: LockRedis, prefix = "emailbot-sync-lock:"): SyncLock {
  return {
    async acquire(emailAccountId, ttlMs) {
      const token = randomUUID();
      const key = `${prefix}${emailAccountId}`;
      let result: string | null;
      try {
        result = await redis.set(key, token, "PX", ttlMs, "NX");
      } catch (error) {
        if (redisOutcome(error) === "unknown") void redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
        throw error;
      }
      return result === "OK" ? token : null;
    },
    async release(emailAccountId, token) {
      await redis.eval(RELEASE_SCRIPT, 1, `${prefix}${emailAccountId}`, token);
    }
  };
}

/** F5.2: the lease on the bounded application client (index.ts). */
export function createAppRedisSyncLock(app: AppRedis, prefix?: string): SyncLock {
  return createRedisSyncLock(
    {
      set: (key, value, px, ttl, nx) => app.run("sync lock acquire", (redis) => redis.set(key, value, px, ttl, nx)),
      eval: (script, keys, ...args) => app.run("sync lock release", (redis) => redis.eval(script, keys, ...args))
    },
    prefix
  );
}
