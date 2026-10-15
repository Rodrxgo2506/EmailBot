import type { ImapSyncSlots } from "../pipeline/handle-email-event.js";

/*
 * IMAP A2: how many IMAP synchronizations one worker process runs at once. They share the email-events
 * queue (and its WORKER_EVENTS_CONCURRENCY slots) with Gmail / Microsoft; this keeps at least one slot that
 * IMAP can never take. A SYNC_ACCOUNT of an IMAP mailbox that finds no free slot is moved back to "delayed"
 * by the job runner (job-processors.ts), so it does not hold a BullMQ slot while it waits.
 */

/** IMAP runs allowed in one process: the configured value, always leaving at least one events slot to the others. */
export function imapSyncSlotCount(eventsConcurrency: number, configured: number): number {
  return Math.max(1, Math.min(configured, eventsConcurrency - 1));
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
