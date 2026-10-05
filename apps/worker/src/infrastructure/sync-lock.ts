import { randomUUID } from "node:crypto";
import type { SyncLock } from "../pipeline/ports.js";

/*
 * Per-account sync lease in Redis (the same Redis as BullMQ): SET NX PX to
 * acquire, compare-and-delete (Lua) to release only our own lease. Different
 * accounts never block each other. If a lease expires mid-run, the cursor
 * compare-and-set still prevents a lost or regressed cursor.
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
      const result = await redis.set(`${prefix}${emailAccountId}`, token, "PX", ttlMs, "NX");
      return result === "OK" ? token : null;
    },
    async release(emailAccountId, token) {
      await redis.eval(RELEASE_SCRIPT, 1, `${prefix}${emailAccountId}`, token);
    }
  };
}
