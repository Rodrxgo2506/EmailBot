import type { EmailProcessingJob, NotificationJob } from "@emailbot/shared";
import type { EmailRuleRow } from "@emailbot/rules-engine";
import type {
  BotStatus,
  CustomerIdentifierType,
  CustomerStatus,
  EmailProcessingStatus,
  EmailProvider,
  RealtimeEvent
} from "@emailbot/types";
import type { WorkerAccount } from "../providers/types.js";

/* Infrastructure contracts used by the pipeline (Supabase/Redis in prod, fakes in tests). */

export interface AccountStore {
  getAccount(id: string): Promise<WorkerAccount | null>;
  findActiveAccountsByAddress(provider: EmailProvider, emailAddress: string): Promise<WorkerAccount[]>;
  findAccountBySubscription(subscriptionId: string): Promise<WorkerAccount | null>;
  listActiveOAuthAccounts(limit: number): Promise<Array<Pick<WorkerAccount, "id" | "organizationId">>>;
  updateSyncState(id: string, state: { syncCursor: string | null; lastSyncedAt: string }): Promise<void>;
  /**
   * Compare-and-set of the history cursor: written only if it still equals
   * `from` (the cursor the sync started with). Returns false when another
   * sync moved it meanwhile (nothing is overwritten, the cursor never goes back).
   */
  advanceSyncCursor(id: string, state: { from: string | null; to: string | null; lastSyncedAt: string }): Promise<boolean>;
  /** Push subscription state (Gmail users.watch, phase 5.6; Microsoft Graph subscription expiry, F9). */
  saveWatchState(
    id: string,
    state: { expiresAt?: string | null; renewedAt?: string | null; errorCode: string | null; errorAt?: string | null }
  ): Promise<void>;
  /**
   * Microsoft Graph subscription: provider_metadata (subscription id + clientState
   * hash, other keys kept by the caller) and the watch_* columns, in one update.
   */
  saveSubscriptionState(
    id: string,
    state: { providerMetadata: Record<string, unknown>; expiresAt: string | null; renewedAt?: string | null; errorCode: string | null; errorAt?: string | null }
  ): Promise<void>;
  /**
   * Active accounts of active organizations, of the given providers (default
   * Gmail), whose push subscription is missing or expires before `renewBefore`.
   */
  listAccountsNeedingWatch(options: {
    renewBefore: string;
    limit: number;
    providers?: EmailProvider[];
  }): Promise<Array<Pick<WorkerAccount, "id" | "organizationId">>>;
  saveTokens(
    id: string,
    tokens: { accessTokenEncrypted: string; refreshTokenEncrypted: string | null; tokenExpiresAt: string | null }
  ): Promise<void>;
  markError(id: string, error: { code: string; message: string; status?: "ERROR" }): Promise<void>;
}

export interface OrganizationProcessingSettings {
  autoProcessingEnabled: boolean;
  processAttachments: boolean;
  notificationsEnabled: boolean;
}

/** Columns written to public.emails (snake_case, as in the migration). */
export type EmailInsertRow = Record<string, unknown> & {
  organization_id: string;
  email_account_id: string;
  provider_message_id: string;
};

export interface AttachmentInsertRow {
  organization_id: string;
  email_id: string;
  provider_attachment_id: string | null;
  filename: string;
  content_type: string | null;
  file_size: number | null;
  content_id: string | null;
  is_inline: boolean;
}

/** Attachment row already stored for an email (resume / repair). */
export interface StoredAttachment {
  id: string;
  providerAttachmentId: string | null;
  filename: string;
  contentType: string | null;
  fileSize: number | null;
  isInline: boolean;
  storageUploaded: boolean;
}

/** Email already stored for (account, provider message). */
export interface ExistingEmail {
  id: string;
  processingStatus: EmailProcessingStatus;
  processingAttempts: number;
  processingStartedAt: string | null;
  /** EmailBot V2 routing input stored with the email (customer resolution on resume). */
  botId: string | null;
  /** provider_metadata.botSelection: "AMBIGUOUS" when bots tied, otherwise null. */
  botSelection: "AMBIGUOUS" | null;
  extractedData: Record<string, string>;
}

/** Writes only the columns migration 9 lets the service role update. */
export interface ProcessingStateUpdate {
  status: "PROCESSING" | "PROCESSED" | "FAILED";
  attempts?: number;
  processedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Email left RECEIVED / PROCESSING (recovery sweep). */
export interface IncompleteEmail {
  id: string;
  organizationId: string;
  emailAccountId: string;
  provider: EmailProvider;
  providerMessageId: string;
  processingAttempts: number;
}

export interface EmailStore {
  findEmail(emailAccountId: string, providerMessageId: string): Promise<ExistingEmail | null>;
  updateProcessingState(emailId: string, state: ProcessingStateUpdate): Promise<void>;
  /** Incomplete emails of ACTIVE accounts whose processing started before `startedBefore`. */
  listIncompleteEmails(options: { startedBefore: string; limit: number }): Promise<IncompleteEmail[]>;
  loadEnabledRules(organizationId: string): Promise<EmailRuleRow[]>;
  loadSettings(organizationId: string): Promise<OrganizationProcessingSettings>;
  /** INSERT ... ON CONFLICT (email_account_id, provider_message_id) DO NOTHING. Null = duplicate. */
  insertEmail(row: EmailInsertRow): Promise<{ id: string } | null>;
  /** INSERT ... ON CONFLICT (email_id, provider_attachment_id) DO NOTHING (migration 9). */
  insertAttachments(rows: AttachmentInsertRow[]): Promise<Array<{ id: string; providerAttachmentId: string | null }>>;
  listAttachments(emailId: string): Promise<StoredAttachment[]>;
  markAttachmentStored(attachmentId: string, bucket: string, path: string): Promise<void>;
}

/** Bot columns the CustomerResolver reads (column grants of migration worker_customer_resolution_access). */
export interface RoutingBot {
  id: string;
  organizationId: string;
  status: BotStatus;
  /** Raw JSONB: re-validated with customerResolutionSchema before use. */
  customerResolution: unknown;
}

/** A customer_identifiers row returned for a lookup, with its customer's status and assignment to the bot. */
export interface IdentifierCandidate {
  identifierId: string;
  organizationId: string;
  customerId: string;
  type: CustomerIdentifierType;
  normalizedValue: string;
  /** Scope: null = every bot of the organization, otherwise only that bot. */
  botId: string | null;
  active: boolean;
  customerStatus: CustomerStatus;
  /** The customer has an ACTIVE assignment to the bot being resolved. */
  assigned: boolean;
}

export interface DeliveryInsertRow {
  organization_id: string;
  email_id: string;
  customer_id: string;
  bot_id: string;
  resolution: "AUTOMATIC";
  identifier_id: string;
}

export interface RoutingStore {
  loadBot(organizationId: string, botId: string): Promise<RoutingBot | null>;
  /** Active identifiers of (type, normalized values) in the organization, scoped to the organization or to this bot. */
  findCandidates(query: { organizationId: string; botId: string; type: CustomerIdentifierType; values: string[] }): Promise<IdentifierCandidate[]>;
  /** INSERT ... ON CONFLICT (email_id, customer_id) DO NOTHING. Returns the customers delivered by THIS call. */
  insertDeliveries(rows: DeliveryInsertRow[]): Promise<string[]>;
}

/** SYSTEM audit entries about an email. Metadata never carries identifier values, tokens or other personal data. */
export interface AuditRecorder {
  recordEmailEvent(entry: { organizationId: string; emailId: string; event: string; description: string; metadata: Record<string, unknown> }): Promise<void>;
  /** SYSTEM audit entry about a mailbox (watch / sync events). Never tokens or message content. */
  recordAccountEvent(entry: {
    organizationId: string;
    emailAccountId: string;
    action: "PROCESS" | "UPDATE" | "FAIL";
    event: string;
    description: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * One effective sync per account at a time (Redis lease, shared by every
 * worker instance). The cursor compare-and-set keeps correctness even if a
 * lease expired; the lease avoids wasted duplicate work.
 */
export interface SyncLock {
  /** Returns a release token, or null when another sync holds the account. */
  acquire(emailAccountId: string, ttlMs: number): Promise<string | null>;
  release(emailAccountId: string, token: string): Promise<void>;
}

export interface AttachmentStorage {
  /** Idempotent: the same path is overwritten (deterministic keys). */
  upload(bucket: string, path: string, content: Uint8Array, contentType: string | null): Promise<void>;
  exists(bucket: string, path: string): Promise<boolean>;
}

export interface RealtimePublisher {
  publish(event: RealtimeEvent): Promise<void>;
}

export interface JobProducer {
  /** Default job id: one per (account, provider message); recovery runs pass their own. */
  enqueueProcessing(job: EmailProcessingJob, options?: { jobId?: string }): Promise<void>;
  enqueueNotification(job: NotificationJob): Promise<void>;
}

export interface Logger {
  debug(object: Record<string, unknown>, message?: string): void;
  info(object: Record<string, unknown>, message?: string): void;
  warn(object: Record<string, unknown>, message?: string): void;
  error(object: Record<string, unknown>, message?: string): void;
}
