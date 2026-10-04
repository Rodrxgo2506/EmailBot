import type { Redis } from "ioredis";
import type { NonceStore } from "../deps.js";

/** SET NX EX: the first consumer wins; later attempts are replays. */
export function createRedisNonceStore(redis: Redis): NonceStore {
  return {
    async consume(nonce, ttlSeconds) {
      const result = await redis.set(`emailbot:oauth-nonce:${nonce}`, "1", "EX", ttlSeconds, "NX");
      return result === "OK";
    }
  };
}

/** In-memory store (single process; tests and local development without Redis). */
export function createMemoryNonceStore(): NonceStore {
  const seen = new Map<string, number>();
  return {
    async consume(nonce, ttlSeconds) {
      const now = Date.now();
      for (const [key, expiresAt] of seen) if (expiresAt <= now) seen.delete(key);
      if (seen.has(nonce)) return false;
      seen.set(nonce, now + ttlSeconds * 1000);
      return true;
    }
  };
}
