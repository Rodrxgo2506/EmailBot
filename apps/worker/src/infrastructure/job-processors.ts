import type { EmailEventJob, EmailProcessingJob } from "@emailbot/shared";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { handleAccountFailure, NonRetryableError } from "../pipeline/failures.js";
import { handleEmailEvent, ImapSlotsBusyError, SyncBusyError, type HandleEventDeps, type ImapSyncSlots } from "../pipeline/handle-email-event.js";
import type { AccountStore, Logger, RealtimePublisher } from "../pipeline/ports.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { IMAP_PROCESSING_BUDGET, withImapRunBudget, type ImapRunBudgetLimits } from "../providers/imap/deadline.js";
import { withImapMessageScope } from "../providers/imap/message-scope.js";
import type { FailedJob } from "./sentry.js";

/*
 * The BullMQ processors of the email-events and email-processing queues (moved out of index.ts unchanged, so
 * the queue-level tests run the very same code). IMAP A2 adds one case: a SYNC_ACCOUNT of an IMAP mailbox that
 * finds every IMAP slot of this process busy (ImapSlotsBusyError) is moved back to "delayed" with the job's own
 * lock token: its BullMQ slot is freed at once for Gmail / Microsoft jobs, no attempt is used, its id stays the
 * same (the coalescing of addCoalescedSync treats "delayed" as pending) and nothing was touched.
 *
 * IMAP A2.1: the same for the email-processing queue (recovery of incomplete emails, RECOVER_INCOMPLETE): a job
 * of an IMAP mailbox takes one of this process's IMAP processing slots (or goes back to "delayed" the same way),
 * runs under IMAP_PROCESSING_BUDGET (deadline.ts: no IMAP operation starts after 6 min, a started one keeps its
 * own deadline, everything still open is closed at 9 min; the attachments not started stay pending) and in its own
 * message scope (message-scope.ts: the message it read serves its attachment downloads, released when the job
 * ends). Gmail / Microsoft jobs never reach that path.
 */

/** Delay of an IMAP job that found no free IMAP slot (plus up to 5 s of jitter). */
export const IMAP_SLOT_RETRY_DELAY_MS = 15_000;

/** The worker's pino logger (a child logger per job). */
export interface JobLogger extends Logger {
  child(bindings: Record<string, unknown>): JobLogger;
}

export interface JobProcessorDeps {
  eventDeps: Omit<HandleEventDeps, "logger">;
  processDeps: Omit<ProcessEmailDeps, "logger">;
  accounts: AccountStore;
  realtime: RealtimePublisher;
  logger: JobLogger;
  reportJobFailure(error: unknown, job: FailedJob, tags: { queue: string; type?: string | undefined }): void;
  jobType(data: unknown): string | undefined;
  /**
   * IMAP A2.1: IMAP email-processing jobs allowed at once in this process (infrastructure/imap-slots.ts). Absent:
   * IMAP jobs take the unchanged path (IMAP disabled: processEmail skips them without connecting).
   */
  imapProcessingSlots?: ImapSyncSlots;
  /** IMAP A2.1: budget of one IMAP email-processing job (default IMAP_PROCESSING_BUDGET; shorter only in tests). */
  imapProcessingBudget?: ImapRunBudgetLimits;
  /** Tests only. */
  random?: () => number;
}

export function createJobProcessors(deps: JobProcessorDeps) {
  const { accounts, realtime, logger } = deps;
  const random = deps.random ?? Math.random;

  /**
   * Maps domain failures to BullMQ semantics (UnrecoverableError = no retry).
   * Unexpected failures are reported to Sentry once, on the job's final attempt.
   */
  async function runWithFailureHandling<T>(
    job: FailedJob,
    account: { id: string; organizationId: string } | null,
    jobLogger: JobLogger,
    run: () => Promise<T>
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // Another run holds the account: expected, retried with backoff (no error report).
      if (error instanceof SyncBusyError) throw error;
      // IMAP A2: no free IMAP slot here: delayed by the events processor (never an account failure).
      if (error instanceof ImapSlotsBusyError) throw error;
      try {
        return await handleAccountFailure(error, account, { accounts, realtime, logger: jobLogger });
      } catch (handled) {
        if (handled instanceof NonRetryableError) throw new UnrecoverableError(handled.message);
        deps.reportJobFailure(handled, job, { queue: job.queueName, type: deps.jobType(job.data) });
        throw handled;
      }
    }
  }

  async function events(job: Job<EmailEventJob>, token?: string) {
    const jobLogger = logger.child({ queue: job.queueName, jobId: job.id, type: job.data.type });
    const account =
      job.data.type === "SYNC_ACCOUNT" || job.data.type === "WATCH_ACCOUNT" ? { id: job.data.emailAccountId, organizationId: job.data.organizationId } : null;
    try {
      return await runWithFailureHandling(job, account, jobLogger, () =>
        handleEmailEvent(job.data, {
          ...deps.eventDeps,
          // Every ingestion path (push, recovery polling, manual sync) uses the same pipeline.
          processMessage: (message) => processEmail(message, { ...deps.processDeps, logger: jobLogger }, { attempt: 1 }),
          logger: jobLogger
        })
      );
    } catch (error) {
      if (error instanceof ImapSlotsBusyError) return delayImapJob(job, token, jobLogger, "imap.sync.slot_busy", error.emailAccountId, "IMAP slots busy; sync delayed");
      throw error;
    }
  }

  /**
   * Moves an IMAP job that found no free IMAP slot back to "delayed" with its own lock token (BullMQ requires the
   * token of the active job; a refusal, e.g. a lost lock, is thrown as is and fails the job like any error).
   * DelayedError tells the worker the job was moved: not completed, not failed, no attempt used.
   */
  async function delayImapJob(job: Job, token: string | undefined, jobLogger: JobLogger, event: string, emailAccountId: string, message: string): Promise<never> {
    await job.moveToDelayed(Date.now() + IMAP_SLOT_RETRY_DELAY_MS + Math.floor(random() * 5_000), token);
    jobLogger.debug({ event, emailAccountId }, message);
    throw new DelayedError();
  }

  async function processing(job: Job<EmailProcessingJob>, token?: string) {
    const slots = deps.imapProcessingSlots;
    // IMAP A2.1: only jobs of an IMAP mailbox (RECOVER_INCOMPLETE sets `provider` from email_accounts.provider).
    if (job.data.provider !== "IMAP" || !slots) return processJob(job);
    if (!slots.tryAcquire()) {
      const jobLogger = logger.child({ queue: job.queueName, jobId: job.id, organizationId: job.data.organizationId, emailAccountId: job.data.emailAccountId });
      return delayImapJob(job, token, jobLogger, "imap.processing.slot_busy", job.data.emailAccountId, "IMAP slots busy; email processing delayed");
    }
    try {
      return await withImapRunBudget(deps.imapProcessingBudget ?? IMAP_PROCESSING_BUDGET, () => withImapMessageScope(() => processJob(job)));
    } finally {
      slots.release();
    }
  }

  /** The email-processing processor as before A2.1 (Gmail / Microsoft, and IMAP while IMAP is disabled). */
  async function processJob(job: Job<EmailProcessingJob>) {
    const jobLogger = logger.child({
      queue: job.queueName,
      jobId: job.id,
      organizationId: job.data.organizationId,
      emailAccountId: job.data.emailAccountId
    });
    const outcome = await runWithFailureHandling(
      job,
      { id: job.data.emailAccountId, organizationId: job.data.organizationId },
      jobLogger,
      // Whether an email is resumed is decided by its processing_status in the
      // database (migration 9), not by BullMQ's attempt counters; `attempt`
      // only seeds processing_attempts of a newly stored email.
      () => processEmail(job.data, { ...deps.processDeps, logger: jobLogger }, { attempt: job.attemptsMade + 1 })
    );
    jobLogger.debug({ outcome: outcome.status, ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}) }, "job done");
    return outcome;
  }

  return { events, processing };
}
