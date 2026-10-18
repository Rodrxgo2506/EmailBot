import type { ImapSyncSlots } from "../pipeline/handle-email-event.js";

/*
 * IMAP A2 / A2.1: how many IMAP jobs one worker process runs at once on a queue it shares with Gmail /
 * Microsoft: SYNC_ACCOUNT on email-events (WORKER_IMAP_SYNC_CONCURRENCY out of WORKER_EVENTS_CONCURRENCY) and
 * the recovery of incomplete emails on email-processing (WORKER_IMAP_PROCESSING_CONCURRENCY out of
 * WORKER_PROCESSING_CONCURRENCY), each with its own counter. A queue concurrency of 2 or more keeps at least one
 * slot IMAP can never take; with a concurrency of 1, IMAP still gets 1 slot (the only one): nothing is reserved.
 * An IMAP job that finds no free slot is moved back to "delayed" by the job runner (job-processors.ts), so it
 * does not hold a BullMQ slot while it waits.
 */

/** IMAP jobs allowed in one process: the configured value, leaving one slot to the others when the queue has 2 or more. */
export function imapSyncSlotCount(queueConcurrency: number, configured: number): number {
  return Math.max(1, Math.min(configured, queueConcurrency - 1));
}

export function createImapSyncSlots(max: number): ImapSyncSlots & { inUse(): number; readonly max: number } {
  let inUse = 0;
  return {
    max,
    tryAcquire() {
      if (inUse >= max) return false;
      inUse += 1;
      return true;
    },
    release() {
      inUse = Math.max(0, inUse - 1);
    },
    inUse: () => inUse
  };
}
