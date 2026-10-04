import { createHash } from "node:crypto";
import type { EmailProvider } from "@emailbot/types";

/*
 * Queue contracts shared by the API (producer) and the worker (consumer).
 *
 *   provider webhook -> API -> [email-events] -> worker resolves account and
 *   lists new message ids -> [email-processing] (one job per message) ->
 *   worker fetches, normalizes, evaluates rules, persists -> [notifications]
 */

export const QUEUE_NAMES = {
  emailEvents: "email-events",
  emailProcessing: "email-processing",
  notifications: "notifications"
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Gmail Pub/Sub push notification (already decoded and verified by the API). */
export interface GmailNotificationJob {
  type: "GMAIL_NOTIFICATION";
  emailAddress: string;
  historyId: string;
}

/** Microsoft Graph change notification (clientState already verified). */
export interface MicrosoftNotificationJob {
  type: "MICROSOFT_NOTIFICATION";
  subscriptionId: string;
  resource: string;
  messageId: string | null;
}

/** Explicit sync request (manual "sync now" or polling fallback). */
export interface SyncAccountJob {
  type: "SYNC_ACCOUNT";
  emailAccountId: string;
  organizationId: string;
  requestedBy: string | null;
}

/** Periodic fallback (job scheduler in the worker): sync every active account. */
export interface PollAccountsJob {
  type: "POLL_ACCOUNTS";
}

/**
 * Periodic recovery (job scheduler in the worker): emails left RECEIVED /
 * PROCESSING by a job that exhausted its retries are resumed.
 */
export interface RecoverIncompleteJob {
  type: "RECOVER_INCOMPLETE";
}

export type EmailEventJob = GmailNotificationJob | MicrosoftNotificationJob | SyncAccountJob | PollAccountsJob | RecoverIncompleteJob;

export interface EmailProcessingJob {
  organizationId: string;
  emailAccountId: string;
  provider: EmailProvider;
  providerMessageId: string;
}

export interface NotificationJob {
  organizationId: string;
  emailId: string;
  ruleId: string;
  channel: "in_app" | "email";
  title: string;
  body: string;
}

/**
 * Deterministic BullMQ job id for a provider message. Adding the same message
 * twice while a job with this id exists is a no-op. BullMQ forbids ":" in
 * custom ids, so the provider id is hashed.
 */
export function emailProcessingJobId(emailAccountId: string, providerMessageId: string): string {
  const digest = createHash("sha256").update(providerMessageId).digest("hex").slice(0, 40);
  return `msg-${emailAccountId}-${digest}`;
}

/**
 * Job id of a recovery run for an email. `generation` is the email's
 * processing_attempts, which every run increments: one recovery job per
 * generation, even while older jobs are still retained by BullMQ.
 */
export function resumeProcessingJobId(emailId: string, generation: number): string {
  return `resume-${emailId}-${generation}`;
}

/**
 * Deterministic BullMQ job id for a rule notification of an email. Enqueuing
 * it again (retried or resumed processing) is a no-op while the job exists
 * (completed jobs are kept 24 h by DEFAULT_JOB_OPTIONS).
 */
export function notificationJobId(job: Pick<NotificationJob, "emailId" | "ruleId" | "channel">): string {
  return `notify-${job.emailId}-${job.ruleId}-${job.channel}`;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 }
} as const;
