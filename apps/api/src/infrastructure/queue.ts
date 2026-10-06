import { addCoalescedSync, DEFAULT_JOB_OPTIONS, isSyncPending, POLL_SCHEDULER_ID, QUEUE_NAMES, type EmailEventJob } from "@emailbot/shared";
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
    async requestAccountSync(account, reason, requestedBy = null) {
      return (await addCoalescedSync(emailEvents as never, account, reason, requestedBy)) ? "QUEUED" : "ALREADY_QUEUED";
    },
    async isAccountSyncPending(emailAccountId) {
      return isSyncPending(emailEvents as never, emailAccountId);
    },
    async pollSchedulerState() {
      // Read-only (HGETALL / ZSCORE of the scheduler): never creates or changes it.
      const scheduler = await emailEvents.getJobScheduler(POLL_SCHEDULER_ID);
      const next = Number(scheduler?.next);
      const every = Number(scheduler?.every);
      return scheduler && Number.isFinite(next) && Number.isFinite(every) && every > 0 ? { next, every } : null;
    },
    async close() {
      await emailEvents.close();
    }
  };
}
