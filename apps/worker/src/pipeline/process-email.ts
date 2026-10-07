import { evaluateRules, parseRuleRow, type EngineRule, type RuleEvaluationResult } from "@emailbot/rules-engine";
import { buildAttachmentPath, serializeError, type EmailProcessingJob } from "@emailbot/shared";
import type { NormalizedAttachment, NormalizedEmail } from "@emailbot/types";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderAuthError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { hasCommercialAccess } from "./commercial-access.js";
import { buildEmailRow } from "./email-row.js";
import { routeEmail, type CustomerResolverInput } from "./resolve-customers.js";
import type {
  AccountStore,
  AttachmentStorage,
  AuditRecorder,
  EmailStore,
  JobProducer,
  Logger,
  OrganizationProcessingSettings,
  ExistingEmail,
  RealtimePublisher,
  RoutingStore,
  StoredAttachment
} from "./ports.js";

export interface ProcessEmailDeps {
  accounts: AccountStore;
  emails: EmailStore;
  /** EmailBot V2: customer resolution + email_deliveries. */
  routing: RoutingStore;
  audit: AuditRecorder;
  storage: AttachmentStorage;
  realtime: RealtimePublisher;
  producer: JobProducer;
  providers: ProviderRegistry;
  createContext(account: WorkerAccount): ProviderContext;
  attachmentsBucket: string;
  maxAttachmentBytes: number;
  logger: Logger;
  /** In-job retries of Storage / attachment-row writes (default 3 attempts, 250 ms apart). */
  storageAttempts?: number;
  storageRetryDelayMs?: number;
}

export type ProcessEmailOutcome =
  | { status: "processed"; emailId: string; matchedRuleIds: string[] }
  | { status: "resumed"; emailId: string; insertedAttachments: number }
  | {
      status: "skipped";
      reason:
        | "account_not_found"
        | "organization_inactive"
        | "subscription_inactive"
        | "account_inactive"
        | "auto_processing_disabled"
        | "duplicate"
        | "no_enabled_rules"
        | "no_matching_rule";
    };

/**
 * Some attachment contents could not be stored. Retryable: the job fails, the
 * email stays PROCESSING and the next run resumes it (see processEmail).
 */
export class AttachmentsPendingError extends Error {
  constructor(readonly pending: number) {
    super(`${pending} attachment(s) could not be stored yet`);
    this.name = "AttachmentsPendingError";
  }
}

/** Notifications are re-enqueued on resume only while BullMQ still de-duplicates them (24 h retention). */
export const NOTIFICATION_RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * Processes ONE provider message:
 *
 *   account checks -> already stored? -> load rules -> fetch + normalize ->
 *   rule engine (bot selection, extractors) -> (no match: discard) ->
 *   INSERT (RECEIVED) -> PROCESSING -> customer resolution + deliveries ->
 *   attachment rows -> attachment contents -> realtime event ->
 *   notifications -> PROCESSED
 *
 * The database records progress (migration 9): an email stays RECEIVED /
 * PROCESSING until every step succeeded. Whoever finds it in that state - a
 * BullMQ retry, a stalled job restarted, a new delivery of the message, a
 * concurrent worker or the recovery sweep (handle-email-event) - resumes it.
 * Every step is idempotent:
 *   - email: unique (email_account_id, provider_message_id), ON CONFLICT DO NOTHING;
 *   - deliveries: unique (email_id, customer_id), ON CONFLICT DO NOTHING; the
 *     resolver uses the bot and extracted data STORED with the email, so a
 *     resumed run resolves like the first one (emails.bot_id never changes);
 *   - attachment rows: unique (email_id, provider_attachment_id), ON CONFLICT DO NOTHING;
 *   - contents: deterministic Storage key, reused if it already exists, row
 *     marked stored only after the upload;
 *   - realtime: clients de-duplicate by email id;
 *   - notifications: deterministic BullMQ job id.
 * Storage is outside any SQL transaction, so this is resumable rather than
 * atomic: a failure leaves the email incomplete and the next run finishes it.
 *
 * Mail that matches no enabled rule is never stored.
 */
export async function processEmail(
  job: EmailProcessingJob,
  deps: ProcessEmailDeps,
  meta: { attempt: number } = { attempt: 1 }
): Promise<ProcessEmailOutcome> {
  const log = deps.logger;
  const startedAt = new Date().toISOString();
  const account = await deps.accounts.getAccount(job.emailAccountId);

  // The job's organization must match the account's (never trust job payloads blindly).
  if (!account || account.organizationId !== job.organizationId) {
    return { status: "skipped", reason: "account_not_found" };
  }
  // SUSPENDED / CANCELLED: data is kept, nothing new is processed or delivered (incomplete emails stay as they are).
  if (account.organizationStatus !== "ACTIVE") return { status: "skipped", reason: "organization_inactive" };
  if (account.status !== "ACTIVE") return { status: "skipped", reason: "account_inactive" };
  // Commercial V1.2: checked for every message, at processing time (a job queued while the organization had
  // access is skipped once it lost it: no rules, bots, deliveries or notifications; completed, never retried).
  const allowed = await hasCommercialAccess(deps.accounts, log, {
    organizationId: account.organizationId,
    emailAccountId: account.id,
    provider: account.provider,
    operation: "process_email"
  });
  if (!allowed) return { status: "skipped", reason: "subscription_inactive" };

  const settings = await deps.emails.loadSettings(account.organizationId);
  if (!settings.autoProcessingEnabled) return { status: "skipped", reason: "auto_processing_disabled" };

  const existing = await deps.emails.findEmail(account.id, job.providerMessageId);
  if (existing) return continueExisting(existing, job, account, settings, deps);

  const rules = await loadRules(account, deps);
  // Without enabled rules nothing can match: do not even download the message.
  if (!rules.some((rule) => rule.enabled)) return { status: "skipped", reason: "no_enabled_rules" };

  const context = deps.createContext(account);
  const email = await deps.providers[account.provider].fetchMessage(context, job.providerMessageId);
  const result = evaluateRules(email, rules);

  if (result.regexTimedOut) {
    // A user regex was stopped by the guard (treated as "no match"): surface it to operators.
    log.warn({ organizationId: account.organizationId, ruleIds: rules.map((rule) => rule.id) }, "rule regex exceeded time budget");
  }

  if (!result.matched) return { status: "skipped", reason: "no_matching_rule" };

  if (result.botSelection === "AMBIGUOUS") {
    // Stored without a bot (and therefore never routed to customers); visible in provider_metadata.
    log.warn(
      { event: "bot.selection.ambiguous", organizationId: account.organizationId, botCandidateIds: result.botCandidateIds },
      "email matched rules of different bots with the same priority; no bot selected"
    );
  }

  const inserted = await deps.emails.insertEmail(buildEmailRow(email, account, result, { startedAt, attempts: Math.max(1, meta.attempt) }));
  if (!inserted) {
    // A concurrent worker stored it first: continue from its state (idempotent).
    const concurrent = await deps.emails.findEmail(account.id, job.providerMessageId);
    if (!concurrent) throw new Error("Email row disappeared after a conflicting insert");
    return continueExisting(concurrent, job, account, settings, deps);
  }

  await deps.emails.updateProcessingState(inserted.id, { status: "PROCESSING" });
  const routing: RoutingState = {
    botId: result.botId,
    botSelection: result.botSelection === "AMBIGUOUS" ? "AMBIGUOUS" : null,
    extracted: result.extracted,
    botCandidateIds: result.botCandidateIds
  };
  await completeProcessing(inserted.id, job, email, result, routing, account, settings, deps, context, true);

  log.info(
    { emailId: inserted.id, matchedRules: result.matchedRules.length, categoryId: result.categoryId },
    "email processed"
  );
  return { status: "processed", emailId: inserted.id, matchedRuleIds: result.matchedRules.map((rule) => rule.id) };
}

async function loadRules(account: WorkerAccount, deps: ProcessEmailDeps): Promise<EngineRule[]> {
  const rules: EngineRule[] = [];
  for (const row of await deps.emails.loadEnabledRules(account.organizationId)) {
    const parsed = parseRuleRow(row);
    if (parsed.ok) rules.push(parsed.rule);
    else deps.logger.warn({ ruleId: parsed.ruleId, reason: parsed.reason }, "skipping invalid rule");
  }
  return rules;
}

/** The message is already stored: finish it if incomplete, otherwise it is a duplicate. */
async function continueExisting(
  existing: ExistingEmail,
  job: EmailProcessingJob,
  account: WorkerAccount,
  settings: OrganizationProcessingSettings,
  deps: ProcessEmailDeps
): Promise<ProcessEmailOutcome> {
  if (existing.processingStatus !== "RECEIVED" && existing.processingStatus !== "PROCESSING") {
    // Completed (or given up): only contents still pending are completed (normally a no-op).
    await completeAttachments(existing.id, job.providerMessageId, null, account, settings, deps);
    return { status: "skipped", reason: "duplicate" };
  }

  await deps.emails.updateProcessingState(existing.id, { status: "PROCESSING", attempts: existing.processingAttempts + 1 });

  const context = deps.createContext(account);
  const email = await deps.providers[account.provider].fetchMessage(context, job.providerMessageId);
  // Same rules as the first run unless they were edited meanwhile; used for actions/notifications only.
  const result = evaluateRules(email, await loadRules(account, deps));
  const startedAt = existing.processingStartedAt ? Date.parse(existing.processingStartedAt) : Date.now();
  const notify = Date.now() - startedAt < NOTIFICATION_RESEND_WINDOW_MS;
  if (!notify) deps.logger.warn({ emailId: existing.id }, "resumed too late to notify again safely; notifications skipped");

  // Routing uses what was stored with the email, not the re-evaluation (rules may have changed).
  const routing: RoutingState = { botId: existing.botId, botSelection: existing.botSelection, extracted: existing.extractedData };
  const before = (await deps.emails.listAttachments(existing.id)).length;
  await completeProcessing(existing.id, job, email, result, routing, account, settings, deps, context, notify);
  const insertedAttachments = (await deps.emails.listAttachments(existing.id)).length - before;

  deps.logger.info({ emailId: existing.id, insertedAttachments }, "email processing resumed");
  return { status: "resumed", emailId: existing.id, insertedAttachments };
}

/** Routing input as stored in the email row (bot_id, provider_metadata.botSelection, extracted_data). */
type RoutingState = Pick<CustomerResolverInput, "botId" | "botSelection" | "extracted"> & { botCandidateIds?: string[] };

/** Every step after the email row exists; marks the email PROCESSED only when all succeeded. */
async function completeProcessing(
  emailId: string,
  job: EmailProcessingJob,
  email: NormalizedEmail,
  result: RuleEvaluationResult,
  routing: RoutingState,
  account: WorkerAccount,
  settings: OrganizationProcessingSettings,
  deps: ProcessEmailDeps,
  context: ProviderContext,
  notify: boolean
): Promise<void> {
  // A failure throws: the job is retried and the email stays incomplete (resumed later).
  const routed = await routeEmail(emailId, { organizationId: account.organizationId, email, ...routing }, deps);
  const pending = await completeAttachments(emailId, job.providerMessageId, email, account, settings, deps, context);
  const customerIds = routed.status === "DELIVER" ? routed.deliveries.map((delivery) => delivery.customerId) : [];
  await announce(emailId, email, result, account, settings, deps, notify, customerIds);

  if (pending > 0) {
    const error = new AttachmentsPendingError(pending);
    await deps.emails.updateProcessingState(emailId, { status: "PROCESSING", errorCode: "ATTACHMENTS_PENDING", errorMessage: error.message });
    throw error;
  }
  await deps.emails.updateProcessingState(emailId, {
    status: "PROCESSED",
    processedAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null
  });
}

/**
 * Realtime events (clients de-duplicate by email id; a repeated portal
 * signal only triggers one more refetch) + notifications (de-duplicated by
 * job id). A failure fails the job (retryable) so the resumed run publishes
 * them; the email is not PROCESSED until then.
 */
async function announce(
  emailId: string,
  email: NormalizedEmail,
  result: RuleEvaluationResult,
  account: WorkerAccount,
  settings: OrganizationProcessingSettings,
  deps: ProcessEmailDeps,
  notify: boolean,
  customerIds: string[]
): Promise<void> {
  await deps.realtime.publish({
    type: "email.processed",
    organizationId: account.organizationId,
    emailId,
    emailAccountId: account.id,
    categoryId: result.categoryId,
    matchedRuleId: result.primaryRuleId,
    botId: result.botId,
    subject: email.subject.slice(0, 200),
    important: result.markImportant
  });
  // Portal: the customers who received it refresh their inbox (ids only; the API relays a bare signal).
  if (customerIds.length > 0) {
    await deps.realtime.publish({ type: "portal.deliveries", organizationId: account.organizationId, customerIds: [...new Set(customerIds)] });
  }

  if (!notify || !settings.notificationsEnabled || !result.matched) return;
  for (const notification of result.notifications) {
    await deps.producer.enqueueNotification({
      organizationId: account.organizationId,
      emailId,
      ruleId: notification.ruleId,
      channel: notification.channel,
      title: notification.title ?? (email.subject.slice(0, 200) || "New email"),
      body: notificationBody(email, result.extracted)
    });
  }
}

function notificationBody(email: NormalizedEmail, extracted: Record<string, string>): string {
  const values = Object.entries(extracted).map(([name, value]) => `${name}: ${value}`);
  const from = email.sender.name ?? email.sender.address;
  return [`From ${from}`, ...values].join(" · ").slice(0, 500);
}

const attachmentKey = (attachment: { providerAttachmentId: string | null; filename: string; isInline: boolean }) =>
  attachment.providerAttachmentId ?? `${attachment.filename}|${attachment.isInline}`;

/**
 * Makes the attachments of a stored email complete, idempotently:
 *  1. metadata rows: inserts the ones missing (needs `email`, i.e. the
 *     provider message; with `email = null` only existing rows are handled);
 *  2. contents: for every eligible row not yet stored, reuses the object if
 *     it already exists (uploaded by an earlier attempt whose bookkeeping
 *     failed), otherwise downloads and uploads it (deterministic key), and
 *     only then marks the row as stored.
 * Storage and row writes are retried in-job. Returns how many contents are
 * still pending; credential errors are rethrown (account -> ERROR).
 */
async function completeAttachments(
  emailId: string,
  providerMessageId: string,
  email: NormalizedEmail | null,
  account: WorkerAccount,
  settings: OrganizationProcessingSettings,
  deps: ProcessEmailDeps,
  context?: ProviderContext
): Promise<number> {
  // Re-read before every insert attempt: if a previous attempt committed but its
  // response was lost, nothing is inserted twice.
  const rows = await withRetries(deps, async () => {
    const current = await deps.emails.listAttachments(emailId);
    if (!email || email.attachments.length === 0) return current;
    const known = new Set(current.map(attachmentKey));
    const missing = email.attachments.filter((attachment) => !known.has(attachmentKey(attachment)));
    if (missing.length === 0) return current;
    await deps.emails.insertAttachments(missing.map((attachment) => attachmentRow(attachment, emailId, account)));
    return deps.emails.listAttachments(emailId);
  });

  if (!settings.processAttachments) return 0;
  const eligible = rows.filter(
    (row) => !row.storageUploaded && !row.isInline && row.providerAttachmentId && (row.fileSize === null || row.fileSize <= deps.maxAttachmentBytes)
  );
  if (eligible.length === 0) return 0;

  const providerContext = context ?? deps.createContext(account);
  let pending = 0;
  for (const row of eligible) {
    try {
      if (!(await storeContent(row, emailId, providerMessageId, account, providerContext, deps))) continue;
    } catch (error) {
      if (error instanceof ProviderAuthError) throw error;
      pending += 1;
      deps.logger.warn({ err: serializeError(error), attachmentId: row.id }, "attachment content not stored yet");
    }
  }
  return pending;
}

/** Returns false when the content is intentionally not stored (over the size limit). */
async function storeContent(
  row: StoredAttachment,
  emailId: string,
  providerMessageId: string,
  account: WorkerAccount,
  context: ProviderContext,
  deps: ProcessEmailDeps
): Promise<boolean> {
  const path = buildAttachmentPath({ organizationId: account.organizationId, emailId, attachmentId: row.id, filename: row.filename });
  const bucket = deps.attachmentsBucket;

  if (!(await withRetries(deps, () => deps.storage.exists(bucket, path)))) {
    const content = await deps.providers[account.provider].downloadAttachment(context, providerMessageId, row.providerAttachmentId as string);
    if (content.byteLength > deps.maxAttachmentBytes) return false;
    await withRetries(deps, () => deps.storage.upload(bucket, path, content, row.contentType));
  }
  await withRetries(deps, () => deps.emails.markAttachmentStored(row.id, bucket, path));
  return true;
}

function attachmentRow(attachment: NormalizedAttachment, emailId: string, account: WorkerAccount) {
  return {
    organization_id: account.organizationId,
    email_id: emailId,
    provider_attachment_id: attachment.providerAttachmentId,
    filename: attachment.filename.slice(0, 500),
    content_type: attachment.contentType?.slice(0, 255) ?? null,
    file_size: attachment.size,
    content_id: attachment.contentId?.slice(0, 1000) ?? null,
    is_inline: attachment.isInline
  };
}

async function withRetries<T>(deps: ProcessEmailDeps, operation: () => Promise<T>): Promise<T> {
  const attempts = deps.storageAttempts ?? 3;
  const delayMs = deps.storageRetryDelayMs ?? 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || error instanceof ProviderAuthError) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
