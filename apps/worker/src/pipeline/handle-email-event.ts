import { resumeProcessingJobId, SecretBoxError, serializeError, type EmailEventJob, type EmailProcessingJob, type SyncReason } from "@emailbot/shared";
import { ProviderHttpError } from "../providers/http.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderAuthError, ProviderTransientError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import type { AccountStore, AuditRecorder, EmailStore, JobProducer, Logger, SyncLock } from "./ports.js";
import { AttachmentsPendingError, type ProcessEmailOutcome } from "./process-email.js";

/*
 * Mailbox ingestion (EmailBot V2 phase 5.6).
 *
 *   Gmail push: users.watch -> Pub/Sub -> /webhooks/gmail -> GMAIL_NOTIFICATION
 *   recovery polling: POLL_ACCOUNTS (scheduler)            -> SYNC_ACCOUNT
 *   manual sync (panel, portal)                           -> SYNC_ACCOUNT
 *
 * Every path ends in syncAccount(): one locked run per account that lists the
 * provider's changes from the stored cursor, processes each message with the
 * SAME pipeline (processMessage = processEmail: normalize, extractors, rule
 * engine, bot selection, CustomerResolver, deliveries, attachments) and only
 * then advances the cursor (compare-and-set). Notifications carry no
 * authority: their historyId is only a trigger, the stored cursor decides.
 * Polling is the recovery mechanism, not the primary ingestion.
 */

export interface HandleEventDeps {
  accounts: AccountStore;
  emails: Pick<EmailStore, "listIncompleteEmails" | "updateProcessingState">;
  producer: JobProducer;
  providers: ProviderRegistry;
  createContext(account: WorkerAccount): ProviderContext;
  /** Coalesced per account (sync-<id> + one follow-up). */
  enqueueSync(account: Pick<WorkerAccount, "id" | "organizationId">, reason?: SyncReason): Promise<void>;
  /** Coalesced per account (watch-<id>). */
  enqueueWatch?(account: Pick<WorkerAccount, "id" | "organizationId">): Promise<void>;
  /** The existing processing pipeline (processEmail). */
  processMessage?(job: EmailProcessingJob): Promise<ProcessEmailOutcome>;
  lock?: SyncLock;
  audit?: AuditRecorder;
  /** projects/<project>/topics/<topic>; null = push disabled (polling only). */
  watchTopic?: string | null;
  now?: () => number;
  logger: Logger;
}

export interface HandleEventOutcome {
  accounts: number;
  /** Jobs queued (processing, sync or watch jobs). */
  enqueued: number;
  /** Messages handled by the pipeline in this run. */
  processed?: number;
}

const POLL_BATCH = 500;

/** An email still RECEIVED / PROCESSING this long after it started was abandoned by its job. */
export const RECOVERY_STALE_MS = 15 * 60 * 1000;
export const RECOVERY_BATCH = 100;
/**
 * Every run (first attempt, BullMQ retries, recovery runs) increments
 * processing_attempts. Past this, the email is marked FAILED instead of being
 * retried forever; its stored data is kept.
 */
export const MAX_PROCESSING_ATTEMPTS = 25;

/** Messages processed per sync run; the rest continue in a follow-up run (bounded jobs, gentle on Gmail quotas). */
export const MAX_MESSAGES_PER_SYNC = 200;
/** History-gap recovery: at most this many recent INBOX messages... */
export const MAX_RECOVERY_MESSAGES = 300;
/** ...received after the last successful sync (minus a margin), never more than 7 days back. */
export const RECOVERY_MARGIN_MS = 60 * 60 * 1000;
export const RECOVERY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECOVERY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Messages processed concurrently inside one sync run. */
export const MESSAGE_CONCURRENCY = 3;
/** Lease of the per-account sync lock (renewed by nothing: a run is bounded well below it). */
export const SYNC_LOCK_TTL_MS = 15 * 60 * 1000;
/** Gmail watches last 7 days; they are renewed when less than this remains. */
export const WATCH_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
export const WATCH_RENEW_BATCH = 100;

/** Another sync of the same account is running: retried with backoff (BullMQ). */
export class SyncBusyError extends Error {
  constructor(readonly emailAccountId: string) {
    super("Another synchronization of this account is running");
    this.name = "SyncBusyError";
  }
}

export interface SyncResult {
  found: number;
  processed: number;
  skipped: number;
  historyGap: boolean;
  hasMore: boolean;
  cursorAdvanced: boolean;
}

/** Start of the recovery window after a history gap. */
export function recoverySince(lastSyncedAt: string | null | undefined, now: number): Date {
  const last = lastSyncedAt ? Date.parse(lastSyncedAt) : Number.NaN;
  const start = Number.isNaN(last) ? now - RECOVERY_DEFAULT_WINDOW_MS : last - RECOVERY_MARGIN_MS;
  return new Date(Math.max(start, now - RECOVERY_MAX_WINDOW_MS));
}

/** Errors that must stop the whole run (credentials); everything else is per message. */
function isAccountFatal(error: unknown): boolean {
  return error instanceof ProviderAuthError || error instanceof SecretBoxError;
}

/**
 * Processes provider message ids with the existing pipeline. A message is
 * "durable" when the pipeline stored it (or decided to skip it): processed,
 * resumed, skipped (duplicate / no matching rule / ...), attachments pending
 * (stored; the recovery sweep completes it) or gone from the mailbox (404).
 * Any other failure is collected and rethrown after the batch, so the cursor
 * is not advanced and the run is retried; already-stored messages are
 * deduplicated by the database on the retry.
 */
async function processMessages(account: WorkerAccount, messageIds: string[], deps: HandleEventDeps): Promise<{ processed: number; skipped: number }> {
  const processMessage = deps.processMessage;
  if (!processMessage) throw new Error("processMessage is not configured");
  let processed = 0;
  let skipped = 0;
  const failures: unknown[] = [];
  let fatal: unknown = null;
  let next = 0;

  const workerLoop = async () => {
    while (fatal === null && next < messageIds.length) {
      const providerMessageId = messageIds[next++] as string;
      try {
        const outcome = await processMessage({
          organizationId: account.organizationId,
          emailAccountId: account.id,
          provider: account.provider,
          providerMessageId
        });
        if (outcome.status === "skipped") skipped += 1;
        else processed += 1;
      } catch (error) {
        if (error instanceof AttachmentsPendingError) processed += 1;
        else if (error instanceof ProviderHttpError && error.status === 404) skipped += 1;
        else if (isAccountFatal(error)) fatal = error;
        else failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MESSAGE_CONCURRENCY, messageIds.length) }, workerLoop));

  if (fatal !== null) throw fatal;
  if (failures.length > 0) {
    deps.logger.warn(
      { event: "gmail.sync.failed", emailAccountId: account.id, failed: failures.length, err: serializeError(failures[0]) },
      "some messages could not be processed; the cursor is not advanced"
    );
    throw failures[0];
  }
  return { processed, skipped };
}

/**
 * One synchronization of one account: lock -> list changes from the stored
 * cursor -> process every message -> advance the cursor (compare-and-set).
 */
export async function syncAccount(account: WorkerAccount, deps: HandleEventDeps, reason: SyncReason = "MANUAL"): Promise<SyncResult> {
  const empty: SyncResult = { found: 0, processed: 0, skipped: 0, historyGap: false, hasMore: false, cursorAdvanced: false };
  // Inactive account / organization: nothing is listed and the cursor does not move, so no mail is lost or processed.
  if (account.status !== "ACTIVE" || account.organizationStatus !== "ACTIVE") return empty;

  const now = deps.now ?? Date.now;
  const lockToken = deps.lock ? await deps.lock.acquire(account.id, SYNC_LOCK_TTL_MS) : "unlocked";
  if (lockToken === null) throw new SyncBusyError(account.id);

  const started = now();
  const log = { emailAccountId: account.id, provider: account.provider, reason };
  deps.logger.info({ event: "gmail.sync.started", ...log }, "account sync started");
  try {
    const adapter = deps.providers[account.provider];
    const context = deps.createContext(account);
    const changes = await adapter.listNewMessageIds(context, { maxMessages: MAX_MESSAGES_PER_SYNC });

    let messageIds = changes.messageIds;
    let nextCursor = changes.nextCursor;
    let historyGap = false;

    if (changes.historyGap) {
      historyGap = true;
      deps.logger.warn({ event: "gmail.sync.history_gap", ...log }, "history cursor expired; controlled recovery");
      await deps.audit
        ?.recordAccountEvent({
          organizationId: account.organizationId,
          emailAccountId: account.id,
          action: "PROCESS",
          event: "gmail.sync.history_gap",
          description: "Mailbox history cursor expired; recovering recent messages",
          metadata: { provider: account.provider }
        })
        .catch((error: unknown) => deps.logger.warn({ err: serializeError(error) }, "could not record the history gap"));
      if (!adapter.recoverMessageIds) throw new Error(`${account.provider} cannot recover from a history gap`);
      const since = recoverySince(account.lastSyncedAt, now());
      const recovery = await adapter.recoverMessageIds(context, { since, maxMessages: MAX_RECOVERY_MESSAGES });
      messageIds = recovery.messageIds;
      nextCursor = recovery.nextCursor;
      deps.logger.info(
        { event: "gmail.sync.recovery", ...log, found: recovery.messageIds.length, truncated: recovery.truncated, since: since.toISOString() },
        "history gap recovery listed recent messages"
      );
    }

    const { processed, skipped } = await processMessages(account, messageIds, deps);

    // Only now, with every message durably handled, the cursor moves.
    const cursorAdvanced = await deps.accounts.advanceSyncCursor(account.id, {
      from: account.syncCursor,
      to: nextCursor ?? account.syncCursor,
      lastSyncedAt: new Date(now()).toISOString()
    });
    if (!cursorAdvanced) deps.logger.warn({ ...log }, "cursor moved by another sync meanwhile; not overwritten");

    const hasMore = changes.hasMore === true;
    if (hasMore && cursorAdvanced) await deps.enqueueSync(account, "CONTINUATION");

    deps.logger.info(
      { event: "gmail.sync.completed", ...log, found: messageIds.length, processed, skipped, historyGap, hasMore, durationMs: now() - started },
      "account synchronized"
    );
    return { found: messageIds.length, processed, skipped, historyGap, hasMore, cursorAdvanced };
  } catch (error) {
    deps.logger.warn(
      { event: "gmail.sync.failed", ...log, transient: error instanceof ProviderTransientError, err: serializeError(error), durationMs: now() - started },
      "account sync failed; cursor unchanged"
    );
    throw error;
  } finally {
    if (deps.lock && lockToken !== "unlocked") {
      await deps.lock.release(account.id, lockToken).catch((error: unknown) => deps.logger.warn({ err: serializeError(error) }, "could not release sync lock"));
    }
  }
}

/**
 * Creates or renews the Gmail push subscription of one account. A still
 * valid watch is left alone. Failures other than credentials / transient
 * ones are recorded on the account (polling keeps the mailbox in sync).
 */
export async function ensureWatch(emailAccountId: string, organizationId: string, deps: HandleEventDeps): Promise<boolean> {
  if (!deps.watchTopic) return false;
  const account = await deps.accounts.getAccount(emailAccountId);
  if (!account || account.organizationId !== organizationId) return false;
  if (account.provider !== "GMAIL" || account.status !== "ACTIVE" || account.organizationStatus !== "ACTIVE") return false;

  const now = (deps.now ?? Date.now)();
  if (account.watchExpiresAt && Date.parse(account.watchExpiresAt) > now + WATCH_RENEW_MARGIN_MS) return false;

  const adapter = deps.providers.GMAIL;
  if (!adapter.watch) return false;
  const renewal = Boolean(account.watchExpiresAt);
  const event = renewal ? "gmail.watch.renewed" : "gmail.watch.created";
  try {
    const { expiresAt } = await adapter.watch(deps.createContext(account), deps.watchTopic);
    await deps.accounts.saveWatchState(account.id, { expiresAt, renewedAt: new Date(now).toISOString(), errorCode: null, errorAt: null });
    deps.logger.info({ event, emailAccountId: account.id, expiresAt }, "Gmail watch registered");
    await deps.audit
      ?.recordAccountEvent({
        organizationId: account.organizationId,
        emailAccountId: account.id,
        action: "UPDATE",
        event,
        description: renewal ? "Gmail push notifications renewed" : "Gmail push notifications enabled",
        metadata: { expiresAt }
      })
      .catch((error: unknown) => deps.logger.warn({ err: serializeError(error) }, "could not record the watch event"));
    return true;
  } catch (error) {
    // Credentials (account -> ERROR) and transient failures (retry) are handled by the job runner.
    if (isAccountFatal(error) || error instanceof ProviderTransientError) throw error;
    const errorCode = error instanceof ProviderHttpError ? `HTTP_${error.status}` : "WATCH_FAILED";
    await deps.accounts.saveWatchState(account.id, { errorCode, errorAt: new Date(now).toISOString() });
    deps.logger.warn({ event: "gmail.watch.failed", emailAccountId: account.id, errorCode, err: serializeError(error) }, "Gmail watch failed; polling continues");
    await deps.audit
      ?.recordAccountEvent({
        organizationId: account.organizationId,
        emailAccountId: account.id,
        action: "FAIL",
        event: "gmail.watch.failed",
        description: "Gmail push notifications could not be enabled; the mailbox is still polled",
        metadata: { errorCode }
      })
      .catch(() => undefined);
    return false;
  }
}

export async function handleEmailEvent(job: EmailEventJob, deps: HandleEventDeps): Promise<HandleEventOutcome> {
  switch (job.type) {
    case "GMAIL_NOTIFICATION": {
      // The push only triggers a sync; the historyId is not trusted (the stored cursor decides).
      // The same mailbox may be connected to several organizations; each has its own rules.
      const accounts = await deps.accounts.findActiveAccountsByAddress("GMAIL", job.emailAddress);
      for (const account of accounts) await deps.enqueueSync(account, "PUBSUB");
      return { accounts: accounts.length, enqueued: accounts.length };
    }

    case "MICROSOFT_NOTIFICATION": {
      const account = await deps.accounts.findAccountBySubscription(job.subscriptionId);
      if (!account || account.status !== "ACTIVE") return { accounts: 0, enqueued: 0 };

      if (job.messageId) {
        await deps.producer.enqueueProcessing({
          organizationId: account.organizationId,
          emailAccountId: account.id,
          provider: "MICROSOFT",
          providerMessageId: job.messageId
        });
        return { accounts: 1, enqueued: 1 };
      }
      await deps.enqueueSync(account, "PUBSUB");
      return { accounts: 1, enqueued: 1 };
    }

    case "SYNC_ACCOUNT": {
      const account = await deps.accounts.getAccount(job.emailAccountId);
      if (!account || account.organizationId !== job.organizationId) return { accounts: 0, enqueued: 0 };
      const result = await syncAccount(account, deps, job.reason ?? "MANUAL");
      return { accounts: 1, enqueued: 0, processed: result.processed };
    }

    case "WATCH_ACCOUNT": {
      const created = await ensureWatch(job.emailAccountId, job.organizationId, deps);
      return { accounts: 1, enqueued: created ? 1 : 0 };
    }

    case "RENEW_WATCHES": {
      if (!deps.watchTopic || !deps.enqueueWatch) return { accounts: 0, enqueued: 0 };
      const renewBefore = new Date((deps.now ?? Date.now)() + WATCH_RENEW_MARGIN_MS).toISOString();
      const accounts = await deps.accounts.listAccountsNeedingWatch({ renewBefore, limit: WATCH_RENEW_BATCH });
      for (const account of accounts) await deps.enqueueWatch(account);
      if (accounts.length > 0) deps.logger.info({ accounts: accounts.length }, "Gmail watch renewals queued");
      return { accounts: accounts.length, enqueued: accounts.length };
    }

    case "RECOVER_INCOMPLETE": {
      const startedBefore = new Date(Date.now() - RECOVERY_STALE_MS).toISOString();
      const incomplete = await deps.emails.listIncompleteEmails({ startedBefore, limit: RECOVERY_BATCH });
      let enqueued = 0;
      for (const email of incomplete) {
        if (email.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
          await deps.emails.updateProcessingState(email.id, {
            status: "FAILED",
            errorCode: "RECOVERY_EXHAUSTED",
            errorMessage: `Processing could not be completed after ${email.processingAttempts} attempts`
          });
          deps.logger.error({ emailId: email.id, attempts: email.processingAttempts }, "email processing abandoned");
          continue;
        }
        await deps.producer.enqueueProcessing(
          {
            organizationId: email.organizationId,
            emailAccountId: email.emailAccountId,
            provider: email.provider,
            providerMessageId: email.providerMessageId
          },
          // One recovery job per generation; the run itself increments processing_attempts.
          { jobId: resumeProcessingJobId(email.id, email.processingAttempts) }
        );
        enqueued += 1;
      }
      if (incomplete.length > 0) deps.logger.info({ found: incomplete.length, enqueued }, "incomplete emails recovered");
      return { accounts: incomplete.length, enqueued };
    }

    case "POLL_ACCOUNTS": {
      // Recovery polling: catches missed / lost pushes, expired watches and accounts without push.
      const accounts = await deps.accounts.listActiveOAuthAccounts(POLL_BATCH);
      for (const account of accounts) await deps.enqueueSync(account, "POLL");
      return { accounts: accounts.length, enqueued: accounts.length };
    }
  }
}
