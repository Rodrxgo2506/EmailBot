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

/** Why an account sync was requested (logs only; never authority). */
export type SyncReason = "PUBSUB" | "POLL" | "MANUAL" | "PORTAL" | "CONTINUATION" | "CONNECT";

/**
 * Account sync. Every ingestion path (Pub/Sub push, recovery polling, manual
 * sync from the panel or the portal) ends here, and the worker processes the
 * listed messages with the same pipeline. Never carries credentials.
 */
export interface SyncAccountJob {
  type: "SYNC_ACCOUNT";
  emailAccountId: string;
  organizationId: string;
  requestedBy: string | null;
  reason?: SyncReason | undefined;
}

/** Create or renew the Gmail push subscription (users.watch) of one account. */
export interface WatchAccountJob {
  type: "WATCH_ACCOUNT";
  emailAccountId: string;
  organizationId: string;
}

/** Periodic: enqueue WATCH_ACCOUNT for Gmail accounts whose watch is missing or expiring. */
export interface RenewWatchesJob {
  type: "RENEW_WATCHES";
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

export type EmailEventJob =
  | GmailNotificationJob
  | MicrosoftNotificationJob
  | SyncAccountJob
  | PollAccountsJob
  | RecoverIncompleteJob
  | WatchAccountJob
  | RenewWatchesJob;

/**
 * Sync jobs are coalesced per account: at most one waiting job
 * (`sync-<id>`) plus, while that one is running, one follow-up
 * (`sync-<id>-next`) so a notification that arrives during a sync is not
 * lost. Any number of notifications / polls / clicks therefore produce at
 * most two queued syncs per account.
 */
export function syncAccountJobId(emailAccountId: string): string {
  return `sync-${emailAccountId}`;
}

export function syncFollowUpJobId(emailAccountId: string): string {
  return `sync-${emailAccountId}-next`;
}

export function watchAccountJobId(emailAccountId: string): string {
  return `watch-${emailAccountId}`;
}

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
  /** Only in-app notifications exist (the never-implemented "email" channel was removed in V2 phase 7). */
  channel: "in_app";
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

/** Job options of sync / watch jobs: removed when finished so the next request can be queued. */
export const COALESCED_JOB_OPTIONS = { ...DEFAULT_JOB_OPTIONS, removeOnComplete: true, removeOnFail: true } as const;

/** The two BullMQ Queue methods used to coalesce syncs (structural: no bullmq dependency here). */
export interface CoalescingQueue {
  getJob(id: string): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | undefined | null>;
  add(name: string, data: EmailEventJob, options: Record<string, unknown>): Promise<unknown>;
}

/**
 * Coalesced sync request, shared by the API (manual sync) and the worker
 * (push, polling, continuations): one waiting job per account (sync-<id>);
 * while that one runs, one follow-up (sync-<id>-next) so changes notified
 * during a run are not lost. Adding a job whose id exists is a no-op in
 * BullMQ. Returns whether a new job was queued. Payload: ids and a reason only.
 */
export async function addCoalescedSync(
  queue: CoalescingQueue,
  account: { id: string; organizationId: string },
  reason: SyncReason,
  requestedBy: string | null = null
): Promise<boolean> {
  const data: SyncAccountJob = { type: "SYNC_ACCOUNT", emailAccountId: account.id, organizationId: account.organizationId, requestedBy, reason };
  const primary = await queue.getJob(syncAccountJobId(account.id));
  const state = primary ? await primary.getState() : null;
  if (state === "waiting" || state === "delayed" || state === "prioritized" || state === "waiting-children") return false;
  // A finished job kept by an older retention policy would block its id forever.
  if (primary && (state === "completed" || state === "failed")) await primary.remove().catch(() => undefined);
  const jobId = state === "active" ? syncFollowUpJobId(account.id) : syncAccountJobId(account.id);
  if (state === "active" && (await queue.getJob(jobId))) return false;
  await queue.add("SYNC_ACCOUNT", data, { ...COALESCED_JOB_OPTIONS, jobId });
  return true;
}

/** A sync of the account is waiting, delayed or running. */
export async function isSyncPending(queue: Pick<CoalescingQueue, "getJob">, emailAccountId: string): Promise<boolean> {
  for (const id of [syncAccountJobId(emailAccountId), syncFollowUpJobId(emailAccountId)]) {
    const job = await queue.getJob(id);
    const state = job ? await job.getState() : null;
    if (state && state !== "completed" && state !== "failed") return true;
  }
  return false;
}
