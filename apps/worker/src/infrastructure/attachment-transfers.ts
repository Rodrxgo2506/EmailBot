import { RequestCancelledError } from "./http-cancellation.js";

/*
 * F5.6: two per-process limits for storing attachment contents (each Render instance has its own; neither is a limit
 * across instances). Up to 25 attachment tasks may run at once in a process with the default concurrency: 10
 * email-processing jobs plus 5 events jobs, each sync processing up to 3 messages at once (MESSAGE_CONCURRENCY), every
 * message storing its attachments one after the other.
 *
 *   - transfers (WORKER_ATTACHMENT_TRANSFER_CONCURRENCY, k): the memory-heavy part of storing one attachment, its
 *     download (with the adapter's decoding) and its upload. Released during the waits between in-job upload retries.
 *   - contents (WORKER_ATTACHMENT_CONTENT_CONCURRENCY, m): decoded contents held in memory, from before the download
 *     until the attachment is stored or given up - the retry waits included. Retained contents <= m.
 *
 * Order (no deadlock): a task takes a content permit, then a transfer permit; it gives the transfer permit back for a
 * retry wait and takes it again, while keeping its content permit; it never waits for a content permit while holding
 * a transfer permit. Every holder of a transfer permit also holds a content permit, so it can always finish.
 *
 * Both queues: permits granted in FIFO order; a waiting task is not counted as active; a permit is released exactly
 * once (idempotent); once `cancelled` (the worker shutdown's cancel phase, F5.4) aborts, every waiting task is
 * rejected at once and no permit is granted any more - holders keep the F5.4 / F5.5 cancellation of their requests.
 * One listener on that signal per limiter for the whole process, none per waiting task.
 */

export const DEFAULT_ATTACHMENT_TRANSFER_CONCURRENCY = 1;
export const MIN_ATTACHMENT_TRANSFER_CONCURRENCY = 1;
/** An upper bound that keeps the limit meaningful (up to 25 attachment tasks at once with the default concurrency). */
export const MAX_ATTACHMENT_TRANSFER_CONCURRENCY = 16;

export const MIN_ATTACHMENT_CONTENT_CONCURRENCY = 1;
/** Above 25 (attachment tasks at once with the default concurrency) a limit has no effect; 32 leaves room. */
export const MAX_ATTACHMENT_CONTENT_CONCURRENCY = 32;
/**
 * Default content limit for a transfer limit `k`: k + 1, the smallest value with which a transfer can go on while one
 * content waits for its retry (with m = k a released transfer permit would serve nobody).
 */
export function defaultAttachmentContentConcurrency(transferConcurrency: number): number {
  return transferConcurrency + 1;
}

/** The wait for a transfer permit was cancelled by the worker shutdown (a RequestCancelledError: handled the same way). */
export class TransferSlotCancelledError extends RequestCancelledError {
  constructor() {
    super("attachment transfer slot");
    this.name = "TransferSlotCancelledError";
    this.message = "Waiting for an attachment transfer slot was cancelled by the worker shutdown";
  }
}

/** The wait for a content permit was cancelled by the worker shutdown (a RequestCancelledError: handled the same way). */
export class ContentSlotCancelledError extends RequestCancelledError {
  constructor() {
    super("attachment content slot");
    this.name = "ContentSlotCancelledError";
    this.message = "Waiting for an attachment content slot was cancelled by the worker shutdown";
  }
}

export interface Permit {
  /** Idempotent. */
  release(): void;
}

export interface PermitLimiter {
  readonly limit: number;
  /** Resolves with a permit (FIFO); rejects once the shutdown cancelled. */
  acquire(): Promise<Permit>;
  /** Permits held now. */
  active(): number;
  /** Tasks waiting for a permit now. */
  waiting(): number;
}
export type AttachmentTransfers = PermitLimiter;
export type AttachmentContents = PermitLimiter;

function createPermitLimiter(limit: number, range: { min: number; max: number; name: string }, cancelled: AbortSignal | undefined, cancelledError: () => Error): PermitLimiter {
  if (!Number.isInteger(limit) || limit < range.min || limit > range.max) {
    throw new RangeError(`${range.name} must be an integer from ${range.min} to ${range.max}`);
  }
  let active = 0;
  const queue: Array<{ grant: (permit: Permit) => void; refuse: (error: Error) => void }> = [];

  const permit = (): Permit => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active -= 1;
        next();
      }
    };
  };
  const next = () => {
    if (cancelled?.aborted) return;
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift()!;
      active += 1;
      waiter.grant(permit());
    }
  };
  cancelled?.addEventListener(
    "abort",
    () => {
      for (const waiter of queue.splice(0)) waiter.refuse(cancelledError());
    },
    { once: true }
  );

  return {
    limit,
    acquire() {
      if (cancelled?.aborted) return Promise.reject(cancelledError());
      if (active < limit && queue.length === 0) {
        active += 1;
        return Promise.resolve(permit());
      }
      return new Promise<Permit>((grant, refuse) => queue.push({ grant, refuse }));
    },
    active: () => active,
    waiting: () => queue.length
  };
}

export function createAttachmentTransfers(limit: number, cancelled?: AbortSignal): AttachmentTransfers {
  return createPermitLimiter(
    limit,
    { min: MIN_ATTACHMENT_TRANSFER_CONCURRENCY, max: MAX_ATTACHMENT_TRANSFER_CONCURRENCY, name: "attachment transfer concurrency" },
    cancelled,
    () => new TransferSlotCancelledError()
  );
}

export function createAttachmentContents(limit: number, cancelled?: AbortSignal): AttachmentContents {
  return createPermitLimiter(
    limit,
    { min: MIN_ATTACHMENT_CONTENT_CONCURRENCY, max: MAX_ATTACHMENT_CONTENT_CONCURRENCY, name: "attachment content concurrency" },
    cancelled,
    () => new ContentSlotCancelledError()
  );
}
