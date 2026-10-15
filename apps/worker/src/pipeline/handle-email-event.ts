import {
  generateClientState,
  hashClientState,
  isGraphSubscriptionId,
  MICROSOFT_SUBSCRIPTION_LIFETIME_MS,
  readMicrosoftSubscription,
  resumeProcessingJobId,
  SecretBoxError,
  serializeError,
  subscriptionLogId,
  withMicrosoftSubscription,
  type EmailEventJob,
  type EmailProcessingJob,
  type SyncReason
} from "@emailbot/shared";
import { ProviderHttpError } from "../providers/http.js";
import { formatImapCursor, parseImapCursor, parseImapMessageId } from "../providers/imap/cursor.js";
import { IMAP_RUN_BUDGET, imapRunBudgetExhausted, withImapRunBudget } from "../providers/imap/deadline.js";
import type { MicrosoftSubscriptionClient } from "../providers/microsoft/subscriptions.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderAuthError, ProviderSecurityError, ProviderTransientError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { hasCommercialAccess, withCommercialAccess } from "./commercial-access.js";
import type { AccountStore, AuditRecorder, EmailStore, JobProducer, Logger, SubscriptionMaintenance, SyncLock } from "./ports.js";
import { AttachmentsPendingError, type ProcessEmailOutcome } from "./process-email.js";

/*
 * Mailbox ingestion (EmailBot V2 phase 5.6).
 *
 *   Gmail push: users.watch -> Pub/Sub -> /webhooks/gmail -> GMAIL_NOTIFICATION
 *   Microsoft push (F9): Graph subscription -> /webhooks/microsoft -> MICROSOFT_NOTIFICATION
 *   recovery polling: POLL_ACCOUNTS (scheduler)            -> SYNC_ACCOUNT
 *   manual sync (panel, portal)                           -> SYNC_ACCOUNT
 *
 * Every path ends in syncAccount(): one locked run per account that lists the
 * provider's changes from the stored cursor, processes each message with the
 * SAME pipeline (processMessage = processEmail: normalize, extractors, rule
 * engine, bot selection, CustomerResolver, deliveries, attachments) and only
 * then advances the cursor (compare-and-set). Notifications carry no
 * authority: a Gmail historyId or a Graph resourceData.id is only a trigger,
 * the stored cursor (history id / delta link) decides.
 * Polling is the recovery mechanism, not the primary ingestion.
 *
 * Commercial V1.2: every path also requires commercial access (an ACTIVE
 * subscription inside its period, or legacy access), checked in the database
 * right before the operation (see commercial-access.ts). Without it nothing
 * is synced, processed or (re)subscribed; nothing is deleted.
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
  /** Microsoft push (Graph change notifications); null / absent = polling only. */
  microsoftPush?: { notificationUrl: string; lifecycleNotificationUrl: string } | null;
  /** Graph /subscriptions client (required with microsoftPush). */
  microsoftSubscriptions?: MicrosoftSubscriptionClient;
  /** Commercial V1.2: periodic expiration of subscriptions (EXPIRE_SUBSCRIPTIONS). */
  subscriptions?: SubscriptionMaintenance;
  /**
   * IMAP synchronization (worker config, fixed false until IMAP is launched).
   * Absent / false: IMAP accounts are never polled, synchronized or processed.
   */
  imapSyncEnabled?: boolean;
  /**
   * IMAP A2: IMAP synchronization runs allowed at once in this process (a share of the events concurrency, so
   * IMAP never takes every slot Gmail / Microsoft need). Busy: syncAccount throws ImapSlotsBusyError and the
   * job runner delays the job (no attempt used). Absent: no limit (tests, scripts).
   */
  imapSlots?: ImapSyncSlots;
  /** IMAP A2: run budget (default IMAP_RUN_BUDGET; shorter only in tests). */
  imapRunBudget?: { softMs: number; hardMs: number };
  now?: () => number;
  logger: Logger;
}

/** In-process counter of running IMAP synchronizations (infrastructure/imap-slots.ts). */
export interface ImapSyncSlots {
  /** Takes a slot if one is free. */
  tryAcquire(): boolean;
  release(): void;
}

export interface HandleEventOutcome {
  accounts: number;
  /** Jobs queued (processing, sync or watch jobs). */
  enqueued: number;
  /** Messages handled by the pipeline in this run. */
  processed?: number;
  /** Subscriptions expired by EXPIRE_SUBSCRIPTIONS. */
  expired?: number;
}

const POLL_BATCH = 500;

/** An email still RECEIVED / PROCESSING this long after it started was abandoned by its job. */
export const RECOVERY_STALE_MS = 15 * 60 * 1000;
/** Incomplete emails of every provider but IMAP recovered per run (unchanged; IMAP never takes a place of it, F2). */
export const RECOVERY_BATCH = 100;
/**
 * F2: incomplete emails of IMAP mailboxes recovered per run, in a batch of their own (only while IMAP
 * synchronization is enabled). Their jobs run in this process's IMAP processing slots (2 by default, up to
 * 9 minutes each) and the sweep runs every 10 minutes: 20 is ample for several workers while keeping the IMAP
 * backlog on email-processing small. Oldest first; an email that keeps failing reaches MAX_PROCESSING_ATTEMPTS
 * and leaves the batch (FAILED), so the batch always moves on.
 */
export const IMAP_RECOVERY_BATCH = 20;
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
/**
 * IMAP M1 (decision B): every IMAP run lists at most this many new messages (the rest continue in a
 * CONTINUATION run from the last one processed) and ignores messages received more than
 * RECOVERY_MAX_WINDOW_MS ago (counted and reported, never imported).
 */
export const IMAP_MAX_MESSAGES_PER_SYNC = MAX_RECOVERY_MESSAGES;
/**
 * IMAP M1 (D1): skip reasons meaning "this mailbox must not be processed now" (paused, disconnected, organization
 * suspended, no commercial access, IMAP no longer in the plan, IMAP disabled). The IMAP run stops at once and keeps
 * its cursor, so those messages are processed after a resume. Gmail / Microsoft keep counting them as skipped.
 */
const IMAP_HALT_REASONS: ReadonlySet<string> = new Set([
  "account_not_found",
  "account_inactive",
  "organization_inactive",
  "subscription_inactive",
  "imap_disabled",
  "imap_not_entitled"
]);
/** Lease of the per-account sync lock (renewed by nothing: a run is bounded well below it). */
export const SYNC_LOCK_TTL_MS = 15 * 60 * 1000;
/** Gmail watches last 7 days, Graph subscriptions ~70 h; both are renewed when less than this remains. */
export const WATCH_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
export const WATCH_RENEW_BATCH = 100;

/** IMAP A2: every IMAP slot of this process is busy: the job runner delays the job (no attempt used, nothing touched). */
export class ImapSlotsBusyError extends Error {
  constructor(readonly emailAccountId: string) {
    super("Every IMAP synchronization slot of this worker is busy");
    this.name = "ImapSlotsBusyError";
  }
}

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
  return error instanceof ProviderAuthError || error instanceof ProviderSecurityError || error instanceof SecretBoxError;
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
async function processMessages(
  account: WorkerAccount,
  messageIds: string[],
  deps: HandleEventDeps,
  options: { recovery?: boolean } = {}
): Promise<MessagesOutcome> {
  const processMessage = deps.processMessage;
  // IMAP only: messages listed by a history-gap recovery may be stored already under their old UIDVALIDITY.
  const recovery = options.recovery === true && account.provider === "IMAP" ? ({ recovery: true } as const) : {};
  if (!processMessage) throw new Error("processMessage is not configured");
  const haltOnState = account.provider === "IMAP";
  const imap = account.provider === "IMAP";
  // IMAP A2: which messages are durably handled, so the cursor can move past a contiguous prefix only.
  const done: boolean[] = messageIds.map(() => false);
  let budgetExhausted = false;
  let processed = 0;
  let skipped = 0;
  const failures: unknown[] = [];
  let fatal: unknown = null;
  let halted: string | null = null;
  let next = 0;

  const workerLoop = async () => {
    while (fatal === null && halted === null && next < messageIds.length) {
      // IMAP A2: past the run's soft budget (or at worker shutdown) no new message is started.
      if (imap && imapRunBudgetExhausted()) {
        budgetExhausted = true;
        break;
      }
      const index = next++;
      const providerMessageId = messageIds[index] as string;
      try {
        const outcome = await processMessage({
          organizationId: account.organizationId,
          emailAccountId: account.id,
          provider: account.provider,
          providerMessageId,
          ...recovery
        });
        // IMAP (M1 D1): the mailbox may not be processed any more: stop, never count it as handled.
        if (outcome.status === "skipped" && haltOnState && IMAP_HALT_REASONS.has(outcome.reason)) halted ??= outcome.reason;
        else if (outcome.status === "skipped") {
          skipped += 1;
          done[index] = true;
        } else {
          processed += 1;
          done[index] = true;
        }
      } catch (error) {
        if (error instanceof AttachmentsPendingError) {
          processed += 1;
          done[index] = true;
        } else if (error instanceof ProviderHttpError && error.status === 404) {
          skipped += 1;
          done[index] = true;
        } else if (isAccountFatal(error)) fatal = error;
        else failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MESSAGE_CONCURRENCY, messageIds.length) }, workerLoop));

  if (fatal !== null) throw fatal;
  // Gmail / Microsoft: unchanged (any failure: the cursor is not advanced, the run is retried).
  if (failures.length > 0 && !imap) {
    deps.logger.warn(
      { event: "gmail.sync.failed", emailAccountId: account.id, failed: failures.length, err: serializeError(failures[0]) },
      "some messages could not be processed; the cursor is not advanced"
    );
    throw failures[0];
  }
  const pending = done.indexOf(false);
  return { processed, skipped, halted, failures, budgetExhausted, firstPending: pending < 0 ? messageIds.length : pending };
}

interface MessagesOutcome {
  processed: number;
  skipped: number;
  halted: string | null;
  /** IMAP only: failed messages (Gmail / Microsoft throw instead, unchanged). */
  failures: unknown[];
  /** IMAP A2: the run budget stopped the batch before every message was started. */
  budgetExhausted: boolean;
  /** Index of the first message not durably handled (messageIds.length when all were). */
  firstPending: number;
}

/**
 * One synchronization of one account: lock -> list changes from the stored
 * cursor -> process every message -> advance the cursor (compare-and-set).
 */
export async function syncAccount(account: WorkerAccount, deps: HandleEventDeps, reason: SyncReason = "MANUAL"): Promise<SyncResult> {
  const empty: SyncResult = { found: 0, processed: 0, skipped: 0, historyGap: false, hasMore: false, cursorAdvanced: false };
  // Inactive account / organization: nothing is listed and the cursor does not move, so no mail is lost or processed.
  if (account.status !== "ACTIVE" || account.organizationStatus !== "ACTIVE") return empty;
  // IMAP synchronization disabled (worker config): no connection is opened, the cursor does not move.
  if (account.provider === "IMAP" && deps.imapSyncEnabled !== true) {
    deps.logger.info({ emailAccountId: account.id, provider: account.provider, reason }, "IMAP synchronization is disabled; account skipped");
    return empty;
  }
  // Commercial V1.2: same without commercial access (checked now, not when the job was queued);
  // the cursor stays where it is, so the mailbox resumes from it once the organization pays again.
  const allowed = await hasCommercialAccess(deps.accounts, deps.logger, {
    organizationId: account.organizationId,
    emailAccountId: account.id,
    provider: account.provider,
    operation: "sync",
    jobType: reason
  });
  if (!allowed) return empty;
  // IMAP M1 (decision A): the plan must still include IMAP. Not an account error: nothing is listed, the cursor stays
  // and synchronization resumes from it once the plan allows IMAP again.
  if (account.provider === "IMAP" && !(await deps.accounts.imapEntitled(account.organizationId))) {
    deps.logger.info({ event: "imap.not_entitled", emailAccountId: account.id, organizationId: account.organizationId, reason }, "IMAP not in the plan; account skipped");
    return empty;
  }

  // IMAP A2: a bounded share of this process's events concurrency, and a run budget below the sync lock.
  // Gmail / Microsoft: no slot, no budget (unchanged).
  if (account.provider !== "IMAP") return syncLocked(account, deps, reason);
  if (deps.imapSlots && !deps.imapSlots.tryAcquire()) throw new ImapSlotsBusyError(account.id);
  try {
    return await withImapRunBudget(deps.imapRunBudget ?? IMAP_RUN_BUDGET, () => syncLocked(account, deps, reason));
  } finally {
    deps.imapSlots?.release();
  }
}

/** syncAccount after its checks: lock, list, process, cursor. */
async function syncLocked(account: WorkerAccount, deps: HandleEventDeps, reason: SyncReason): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const lockToken = deps.lock ? await deps.lock.acquire(account.id, SYNC_LOCK_TTL_MS) : "unlocked";
  if (lockToken === null) throw new SyncBusyError(account.id);

  const started = now();
  const log = { emailAccountId: account.id, provider: account.provider, reason };
  deps.logger.info({ event: "gmail.sync.started", ...log }, "account sync started");
  try {
    const adapter = deps.providers[account.provider];
    const context = deps.createContext(account);
    const imap = account.provider === "IMAP";
    // IMAP M1 (decision B): bounded catch-up (300 per run, continued from the last message processed) and a 7-day
    // window. Gmail / Microsoft: unchanged.
    const changes = await adapter.listNewMessageIds(
      context,
      imap ? { maxMessages: IMAP_MAX_MESSAGES_PER_SYNC, since: new Date(now() - RECOVERY_MAX_WINDOW_MS) } : { maxMessages: MAX_MESSAGES_PER_SYNC }
    );

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

    const batch = await processMessages(account, messageIds, deps, { recovery: historyGap });
    const { processed, skipped, halted } = batch;

    // IMAP (M1 D1): the mailbox stopped being processable during the batch (paused, disconnected, no access, IMAP
    // left the plan): the cursor is NOT moved, so the remaining messages are processed after a resume (the ones
    // already stored are deduplicated by provider message id).
    if (halted !== null) {
      deps.logger.warn({ event: "imap.sync.halted", ...log, reason: halted, found: messageIds.length, processed, skipped }, "IMAP sync stopped; cursor unchanged");
      return { found: messageIds.length, processed, skipped, historyGap, hasMore: false, cursorAdvanced: false };
    }

    // IMAP A2: a message failed (e.g. its deadline) or the run budget stopped the batch: the cursor only moves past
    // the contiguous prefix of durably handled messages, never past a pending, failed or unstarted one.
    if (imap && batch.firstPending < messageIds.length) {
      return await advanceImapPrefix(account, deps, {
        messageIds,
        batch,
        outOfWindowUids: changes.outOfWindowUids ?? [],
        historyGap,
        log,
        now
      });
    }

    // Only now, with every message durably handled, the cursor moves (IMAP: only while the mailbox is still ACTIVE).
    const cursorAdvanced = await deps.accounts.advanceSyncCursor(account.id, {
      from: account.syncCursor,
      to: nextCursor ?? account.syncCursor,
      lastSyncedAt: new Date(now()).toISOString(),
      ...(imap ? { requireActive: true } : {})
    });
    if (!cursorAdvanced) deps.logger.warn({ ...log }, "cursor not advanced (moved by another sync meanwhile, or the mailbox is no longer active)");

    // IMAP (decision B): messages older than the window were skipped on purpose; say so, never claim them imported.
    const outOfWindow = changes.outOfWindow ?? 0;
    if (imap && outOfWindow > 0 && cursorAdvanced) await reportOutOfWindow(account, deps, log, outOfWindow);

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

/** IMAP (decision B): messages older than the window were skipped on purpose; say so, never claim them imported. */
async function reportOutOfWindow(account: WorkerAccount, deps: HandleEventDeps, log: Record<string, unknown>, count: number): Promise<void> {
  deps.logger.warn(
    { event: "imap.sync.outside_window", ...log, count, windowDays: RECOVERY_MAX_WINDOW_MS / 86_400_000 },
    "IMAP messages older than the window were not imported"
  );
  await deps.audit
    ?.recordAccountEvent({
      organizationId: account.organizationId,
      emailAccountId: account.id,
      action: "PROCESS",
      event: "imap.sync.outside_window",
      description: `${count} message(s) received more than ${RECOVERY_MAX_WINDOW_MS / 86_400_000} days ago were not imported`,
      metadata: { provider: account.provider, count, windowDays: RECOVERY_MAX_WINDOW_MS / 86_400_000 }
    })
    .catch((error: unknown) => deps.logger.warn({ err: serializeError(error) }, "could not record the skipped IMAP messages"));
}

/**
 * IMAP A2: an incomplete batch (a message failed, or the run budget stopped it). The cursor moves to the UID just
 * before the first message not durably handled (compare-and-set, only while the mailbox is ACTIVE): everything
 * behind it was processed, skipped on purpose or out of the window; nothing pending is ever jumped. Messages
 * processed after the first pending one are deduplicated by the next run. Then a failure is rethrown (BullMQ
 * retry with backoff, from the new cursor) and a budget stop continues in a CONTINUATION run.
 */
async function advanceImapPrefix(
  account: WorkerAccount,
  deps: HandleEventDeps,
  run: { messageIds: string[]; batch: MessagesOutcome; outOfWindowUids: number[]; historyGap: boolean; log: Record<string, unknown>; now: () => number }
): Promise<SyncResult> {
  const { batch, messageIds, log } = run;
  const pending = parseImapMessageId(messageIds[batch.firstPending] as string);
  const current = parseImapCursor(account.syncCursor);
  let cursorAdvanced = false;
  let behindCursor = 0;
  if (pending) {
    const uid = pending.uid - 1;
    if (!current || current.uidValidity !== pending.uidValidity || uid > current.uid) {
      cursorAdvanced = await deps.accounts.advanceSyncCursor(account.id, {
        from: account.syncCursor,
        to: formatImapCursor({ uidValidity: pending.uidValidity, uid }),
        lastSyncedAt: new Date(run.now()).toISOString(),
        requireActive: true
      });
      if (cursorAdvanced) behindCursor = run.outOfWindowUids.filter((outside) => outside <= uid).length;
    }
  }
  if (behindCursor > 0) await reportOutOfWindow(account, deps, log, behindCursor);
  const result = { found: messageIds.length, processed: batch.processed, skipped: batch.skipped, historyGap: run.historyGap };
  if (batch.failures.length > 0) {
    deps.logger.warn(
      { event: "gmail.sync.failed", ...log, failed: batch.failures.length, completedPrefix: batch.firstPending, cursorAdvanced, err: serializeError(batch.failures[0]) },
      "some messages could not be processed; the cursor only moved past the messages before the first pending one"
    );
    throw batch.failures[0];
  }
  deps.logger.warn(
    { event: "imap.sync.budget_exhausted", ...log, found: messageIds.length, completedPrefix: batch.firstPending, cursorAdvanced },
    "IMAP run budget reached; the rest continues in another run"
  );
  await deps.enqueueSync(account, "CONTINUATION");
  return { ...result, hasMore: true, cursorAdvanced };
}

/**
 * Creates or renews the Gmail push subscription of one account. A still
 * valid watch is left alone. Failures other than credentials / transient
 * ones are recorded on the account (polling keeps the mailbox in sync).
 */
export async function ensureWatch(emailAccountId: string, organizationId: string, deps: HandleEventDeps): Promise<boolean> {
  if (!deps.watchTopic && !deps.microsoftPush) return false;
  const account = await deps.accounts.getAccount(emailAccountId);
  if (!account || account.organizationId !== organizationId) return false;
  if (account.status !== "ACTIVE" || account.organizationStatus !== "ACTIVE") return false;
  // Commercial V1.2: no push subscription is created or renewed without commercial access. An existing
  // one is NOT removed: it simply lapses (Gmail 7 days, Graph ~70 h) and RENEW_WATCHES recreates it
  // once the organization has access again; meanwhile its notifications are ignored (see below).
  const allowed = await hasCommercialAccess(deps.accounts, deps.logger, {
    organizationId: account.organizationId,
    emailAccountId: account.id,
    provider: account.provider,
    operation: "watch"
  });
  if (!allowed) return false;
  if (account.provider === "MICROSOFT") return ensureMicrosoftSubscription(account, deps);
  if (account.provider !== "GMAIL" || !deps.watchTopic) return false;

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

/**
 * Creates or renews the Graph change-notification subscription of one
 * Microsoft account (F9), the equivalent of the Gmail watch above. A
 * subscription still valid for more than WATCH_RENEW_MARGIN_MS is left alone;
 * a due one is renewed (PATCH); one Graph no longer has (404) is cleared and
 * created again with a new clientState, so the account never stays without
 * push. Only the clientState's SHA-256 is stored. Failures other than
 * credentials / transient ones are recorded on the account: polling keeps
 * the mailbox in sync meanwhile.
 */
async function ensureMicrosoftSubscription(account: WorkerAccount, deps: HandleEventDeps): Promise<boolean> {
  const push = deps.microsoftPush;
  const client = deps.microsoftSubscriptions;
  if (!push || !client) return false;
  // Disconnected accounts have no credentials (and are not ACTIVE): never subscribe them.
  if (!account.refreshTokenEncrypted && !account.accessTokenEncrypted) return false;

  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const current = readMicrosoftSubscription(account.providerMetadata);
  if (current && account.watchExpiresAt && Date.parse(account.watchExpiresAt) > now + WATCH_RENEW_MARGIN_MS) return false;

  const context = deps.createContext(account);
  const expirationDateTime = new Date(now + MICROSOFT_SUBSCRIPTION_LIFETIME_MS).toISOString();
  let metadata = account.providerMetadata;
  const record = (event: string, action: "UPDATE" | "FAIL", description: string, extra: Record<string, unknown>) =>
    deps.audit
      ?.recordAccountEvent({ organizationId: account.organizationId, emailAccountId: account.id, action, event, description, metadata: extra })
      .catch((error: unknown) => deps.logger.warn({ err: serializeError(error) }, "could not record the subscription event"));

  try {
    if (current) {
      try {
        const renewed = await client.renew(context, current.id, expirationDateTime);
        await deps.accounts.saveSubscriptionState(account.id, {
          providerMetadata: metadata,
          expiresAt: renewed.expirationDateTime,
          renewedAt: nowIso,
          errorCode: null,
          errorAt: null
        });
        deps.logger.info(
          { event: "microsoft.subscription.renewed", emailAccountId: account.id, subscription: subscriptionLogId(current.id), expiresAt: renewed.expirationDateTime },
          "Microsoft subscription renewed"
        );
        await record("microsoft.subscription.renewed", "UPDATE", "Microsoft push notifications renewed", { expiresAt: renewed.expirationDateTime });
        return true;
      } catch (error) {
        if (!(error instanceof ProviderHttpError && error.status === 404)) throw error;
        // Gone at Graph (expired or removed): forget it and create a new one below.
        metadata = withMicrosoftSubscription(metadata, null);
        await deps.accounts.saveSubscriptionState(account.id, { providerMetadata: metadata, expiresAt: null, errorCode: "SUBSCRIPTION_NOT_FOUND", errorAt: nowIso });
        deps.logger.warn(
          { event: "microsoft.subscription.missing", emailAccountId: account.id, subscription: subscriptionLogId(current.id) },
          "Microsoft subscription no longer exists; creating a new one"
        );
      }
    }

    const clientState = generateClientState();
    const created = await client.create(context, {
      notificationUrl: push.notificationUrl,
      lifecycleNotificationUrl: push.lifecycleNotificationUrl,
      clientState,
      expirationDateTime
    });
    try {
      await deps.accounts.saveSubscriptionState(account.id, {
        providerMetadata: withMicrosoftSubscription(metadata, { id: created.id, clientStateHash: hashClientState(clientState) }),
        expiresAt: created.expirationDateTime,
        renewedAt: nowIso,
        errorCode: null,
        errorAt: null
      });
    } catch (error) {
      // Not recorded: remove it at Graph (best effort) so no orphan subscription keeps notifying.
      await client.remove(context, created.id).catch(() => undefined);
      throw error;
    }
    deps.logger.info(
      { event: "microsoft.subscription.created", emailAccountId: account.id, subscription: subscriptionLogId(created.id), expiresAt: created.expirationDateTime },
      "Microsoft subscription created"
    );
    await record("microsoft.subscription.created", "UPDATE", "Microsoft push notifications enabled", { expiresAt: created.expirationDateTime });
    return true;
  } catch (error) {
    // Credentials (account -> ERROR) and transient failures (retry) are handled by the job runner.
    if (isAccountFatal(error) || error instanceof ProviderTransientError) throw error;
    const errorCode = error instanceof ProviderHttpError ? `HTTP_${error.status}` : "SUBSCRIPTION_FAILED";
    await deps.accounts.saveWatchState(account.id, { errorCode, errorAt: nowIso });
    deps.logger.warn(
      { event: "microsoft.subscription.failed", emailAccountId: account.id, errorCode, err: serializeError(error) },
      "Microsoft subscription failed; polling continues"
    );
    await record("microsoft.subscription.failed", "FAIL", "Microsoft push notifications could not be enabled; the mailbox is still polled", { errorCode });
    return false;
  }
}

/** The ACTIVE Microsoft account (of an ACTIVE organization with commercial access) a Graph subscription belongs to. */
async function microsoftAccountBySubscription(subscriptionId: string, deps: HandleEventDeps, jobType: string): Promise<WorkerAccount | null> {
  if (!isGraphSubscriptionId(subscriptionId)) return null;
  const account = await deps.accounts.findAccountBySubscription(subscriptionId);
  if (!account || account.provider !== "MICROSOFT" || account.status !== "ACTIVE" || account.organizationStatus !== "ACTIVE") return null;
  const allowed = await hasCommercialAccess(deps.accounts, deps.logger, {
    organizationId: account.organizationId,
    emailAccountId: account.id,
    provider: account.provider,
    operation: "push_notification",
    jobType
  });
  return allowed ? account : null;
}

export async function handleEmailEvent(job: EmailEventJob, deps: HandleEventDeps): Promise<HandleEventOutcome> {
  switch (job.type) {
    case "GMAIL_NOTIFICATION": {
      // The push only triggers a sync; the historyId is not trusted (the stored cursor decides).
      // The same mailbox may be connected to several organizations; each has its own rules.
      const found = await deps.accounts.findActiveAccountsByAddress("GMAIL", job.emailAddress);
      const accounts = await withCommercialAccess(found, deps.accounts, deps.logger, "push_notification", job.type);
      for (const account of accounts) await deps.enqueueSync(account, "PUBSUB");
      return { accounts: accounts.length, enqueued: accounts.length };
    }

    case "MICROSOFT_NOTIFICATION": {
      // Like a Gmail push: the notification only triggers the account's (coalesced, locked) sync;
      // the delta cursor decides what is new. job.messageId is never processed directly.
      const account = await microsoftAccountBySubscription(job.subscriptionId, deps, job.type);
      if (!account) return { accounts: 0, enqueued: 0 };
      await deps.enqueueSync(account, "GRAPH");
      return { accounts: 1, enqueued: 1 };
    }

    case "MICROSOFT_LIFECYCLE": {
      const account = await microsoftAccountBySubscription(job.subscriptionId, deps, job.type);
      if (!account) return { accounts: 0, enqueued: 0 };
      const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
      const resubscribe = () => (deps.enqueueWatch ? deps.enqueueWatch(account) : ensureWatch(account.id, account.organizationId, deps).then(() => undefined));
      deps.logger.info(
        { event: `microsoft.lifecycle.${job.lifecycleEvent}`, emailAccountId: account.id, subscription: subscriptionLogId(job.subscriptionId) },
        "Microsoft lifecycle notification"
      );

      if (job.lifecycleEvent === "missed") {
        // Never rebuild messages from the notification: the delta sync recovers every change.
        await deps.enqueueSync(account, "GRAPH");
        return { accounts: 1, enqueued: 1 };
      }
      if (job.lifecycleEvent === "reauthorizationRequired") {
        // Renewing (PATCH) reauthorizes the subscription: mark it due; the (coalesced) WATCH job renews it.
        await deps.accounts.saveWatchState(account.id, { expiresAt: nowIso, errorCode: null });
        await resubscribe();
        return { accounts: 1, enqueued: 1 };
      }
      // subscriptionRemoved: forget it, create a new one and sync what may have arrived meanwhile.
      await deps.accounts.saveSubscriptionState(account.id, {
        providerMetadata: withMicrosoftSubscription(account.providerMetadata, null),
        expiresAt: null,
        errorCode: "SUBSCRIPTION_REMOVED",
        errorAt: nowIso
      });
      await resubscribe();
      await deps.enqueueSync(account, "GRAPH");
      return { accounts: 1, enqueued: 2 };
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
      // Only the providers whose push is configured (Gmail: topic; Microsoft: notification URL).
      const providers = [...(deps.watchTopic ? (["GMAIL"] as const) : []), ...(deps.microsoftPush ? (["MICROSOFT"] as const) : [])];
      if (providers.length === 0 || !deps.enqueueWatch) return { accounts: 0, enqueued: 0 };
      const renewBefore = new Date((deps.now ?? Date.now)() + WATCH_RENEW_MARGIN_MS).toISOString();
      const due = await deps.accounts.listAccountsNeedingWatch({ renewBefore, limit: WATCH_RENEW_BATCH, providers: [...providers] });
      const accounts = await withCommercialAccess(due, deps.accounts, deps.logger, "renew_watch", job.type);
      for (const account of accounts) await deps.enqueueWatch(account);
      if (accounts.length > 0) deps.logger.info({ accounts: accounts.length, providers }, "push subscription renewals queued");
      return { accounts: accounts.length, enqueued: accounts.length };
    }

    case "RECOVER_INCOMPLETE": {
      const startedBefore = new Date(Date.now() - RECOVERY_STALE_MS).toISOString();
      // F2: every provider but IMAP keeps the whole batch, selected as before; IMAP mailboxes get a batch of their own
      // (only while IMAP synchronization is enabled: disabled, their jobs would only be skipped), so incomplete IMAP
      // emails can never fill the batch and hold back the recovery of Gmail / Microsoft ones.
      const stale = [
        ...(await deps.emails.listIncompleteEmails({ startedBefore, limit: RECOVERY_BATCH, imap: "exclude" })),
        ...(deps.imapSyncEnabled === true ? await deps.emails.listIncompleteEmails({ startedBefore, limit: IMAP_RECOVERY_BATCH, imap: "only" }) : [])
      ];
      // Without commercial access an incomplete email is left as it is (no attempt consumed, nothing queued).
      const incomplete = await withCommercialAccess(stale, deps.accounts, deps.logger, "recover_incomplete", job.type);
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
      const oauth = await deps.accounts.listActiveOAuthAccounts(POLL_BATCH);
      // IMAP has no push: polling is its only ingestion, and only while IMAP synchronization is enabled.
      const imap = deps.imapSyncEnabled === true && deps.accounts.listActiveImapAccounts ? await deps.accounts.listActiveImapAccounts(POLL_BATCH) : [];
      const accounts = await withCommercialAccess([...oauth, ...imap], deps.accounts, deps.logger, "poll", job.type);
      for (const account of accounts) await deps.enqueueSync(account, "POLL");
      return { accounts: accounts.length, enqueued: accounts.length };
    }

    case "EXPIRE_SUBSCRIPTIONS": {
      // Commercial V1.2 (every 5 minutes): idempotent; access already stops at the period end without it.
      if (!deps.subscriptions) return { accounts: 0, enqueued: 0, expired: 0 };
      const expired = await deps.subscriptions.expireDue();
      if (expired > 0) deps.logger.info({ event: "subscription.expired", count: expired }, "subscriptions expired at the end of their period");
      return { accounts: 0, enqueued: 0, expired };
    }
  }
}
