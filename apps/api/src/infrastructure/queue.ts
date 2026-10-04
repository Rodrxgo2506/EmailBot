import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, type EmailEventJob } from "@emailbot/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { JobQueue } from "../deps.js";

/**
 * Creates a Redis connection from REDIS_URL. `enableOfflineQueue: false`
 * makes producers fail fast when Redis is down (webhooks then answer 503
 * and the provider retries) instead of buffering in memory.
 */
export function createRedisConnection(url: string, options: { forProducer: boolean }): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: options.forProducer ? 1 : null,
    enableOfflineQueue: !options.forProducer,
    // Producer commands (enqueue, OAuth nonces, rate limiting) must not hang a
    // request when Redis is slow; the subscriber holds a long-lived SUBSCRIBE.
    ...(options.forProducer ? { commandTimeout: 5000 } : {}),
    lazyConnect: false
  });
}

export function createBullJobQueue(connection: Redis): JobQueue {
  const emailEvents = new Queue<EmailEventJob>(QUEUE_NAMES.emailEvents, { connection });

  return {
    async enqueueEmailEvent(job, options) {
      await emailEvents.add(job.type, job, {
        ...DEFAULT_JOB_OPTIONS,
        // Manual syncs are deduplicated only while pending, so they are
        // removed as soon as they finish to allow the next request.
        ...(job.type === "SYNC_ACCOUNT" ? { removeOnComplete: true, removeOnFail: true } : {}),
        ...(options?.jobId ? { jobId: options.jobId } : {})
      });
    },
    async close() {
      await emailEvents.close();
    }
  };
}
