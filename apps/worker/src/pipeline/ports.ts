import type { EmailProcessingJob, NotificationJob } from "@emailbot/shared";
import type { EmailRuleRow } from "@emailbot/rules-engine";
import type { EmailProcessingStatus, EmailProvider, RealtimeEvent } from "@emailbot/types";
import type { WorkerAccount } from "../providers/types.js";

/* Infrastructure contracts used by the pipeline (Supabase/Redis in prod, fakes in tests). */

export interface AccountStore {
  getAccount(id: string): Promise<WorkerAccount | null>;
  findActiveAccountsByAddress(provider: EmailProvider, emailAddress: string): Promise<WorkerAccount[]>;
  findAccountBySubscription(subscriptionId: string): Promise<WorkerAccount | null>;
  listActiveOAuthAccounts(limit: number): Promise<Array<Pick<WorkerAccount, "id" | "organizationId">>>;
  updateSyncState(id: string, state: { syncCursor: string | null; lastSyncedAt: string }): Promise<void>;
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
  emailNotificationsEnabled: boolean;
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
