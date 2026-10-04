import type { EmailRuleRow } from "@emailbot/rules-engine";
import type { EmailProcessingJob, NotificationJob } from "@emailbot/shared";
import type { NormalizedEmail, RealtimeEvent } from "@emailbot/types";
import { vi } from "vitest";
import type {
  AccountStore,
  AttachmentInsertRow,
  EmailInsertRow,
  EmailStore,
  Logger,
  ExistingEmail,
  IncompleteEmail,
  OrganizationProcessingSettings,
  ProcessingStateUpdate,
  StoredAttachment
} from "../pipeline/ports.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChangeSet, ProviderAdapter, WorkerAccount } from "../providers/types.js";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

export function makeAccount(overrides: Partial<WorkerAccount> = {}): WorkerAccount {
  return {
    id: "account-1",
    organizationId: ORG,
    provider: "GMAIL",
    status: "ACTIVE",
    emailAddress: "me@gmail.com",
    syncCursor: "100",
    providerMetadata: {},
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    ...overrides
  };
}

export function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: "GMAIL",
    providerMessageId: "msg-1",
    threadId: "t-1",
    internetMessageId: "<m1@example.com>",
    accountId: "account-1",
    direction: "INBOUND",
    sender: { address: "info@account.streaming.example", name: "Streaming" },
    recipients: [{ address: "me@gmail.com", name: null }],
    cc: [],
    bcc: [],
    subject: "Tu código temporal",
    snippet: "Tu código es 4821",
    textBody: "Tu código es 4821",
    htmlBody: null,
    receivedAt: "2026-10-02T10:00:00.000Z",
    sentAt: null,
    attachments: [],
    headers: { "message-id": "<m1@example.com>", "x-noise": "dropped" },
    ...overrides
  };
}

export function makeRuleRow(overrides: Partial<EmailRuleRow> = {}): EmailRuleRow {
  return {
    id: "rule-1",
    name: "Codes",
    enabled: true,
    priority: 10,
    stop_processing: false,
    match_mode: "AND",
    category_id: "category-codes",
    conditions: {
      conditions: [
        { field: "sender", operator: "contains", value: "streaming.example" },
        { field: "subject", operator: "contains", value: "código temporal" }
      ]
    },
    actions: {
      actions: [
        { type: "MARK_IMPORTANT" },
        { type: "EXTRACT", name: "verification_code", preset: "verification_code" },
        { type: "NOTIFY" }
      ]
    },
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

export const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * In-memory EmailStore enforcing the unique indexes the worker relies on:
 * emails (account, provider message) and attachments (email, provider
 * attachment id; NULL ids never conflict).
 */
export class MemoryEmailStore implements EmailStore {
  rows: EmailInsertRow[] = [];
  /** Every processing_status written, in order (emailId -> status). */
  stateHistory: Array<{ emailId: string; status: string }> = [];
  attachments: Array<AttachmentInsertRow & { id: string; storage_path?: string; storage_uploaded?: boolean }> = [];
  rules: EmailRuleRow[] = [];
  settings: OrganizationProcessingSettings = {
    autoProcessingEnabled: true,
    processAttachments: true,
    notificationsEnabled: true,
    emailNotificationsEnabled: true
  };

  findEmail = vi.fn(async (accountId: string, messageId: string): Promise<ExistingEmail | null> => {
    const index = this.rows.findIndex((row) => row.email_account_id === accountId && row.provider_message_id === messageId);
    const row = this.rows[index];
    if (!row) return null;
    return {
      id: `email-${index + 1}`,
      processingStatus: row.processing_status as ExistingEmail["processingStatus"],
      processingAttempts: Number(row.processing_attempts ?? 0),
      processingStartedAt: (row.processing_started_at as string | null) ?? null
    };
  });

  /** Row of an email id (`email-<n>`). */
  row(emailId: string): EmailInsertRow {
    const row = this.rows[Number(emailId.replace("email-", "")) - 1];
    if (!row) throw new Error(`unknown email ${emailId}`);
    return row;
  }

  updateProcessingState = vi.fn(async (emailId: string, state: ProcessingStateUpdate) => {
    const row = this.row(emailId);
    row.processing_status = state.status;
    if (state.attempts !== undefined) row.processing_attempts = state.attempts;
    if (state.processedAt !== undefined) row.processed_at = state.processedAt;
    if (state.errorCode !== undefined) row.processing_error_code = state.errorCode;
    if (state.errorMessage !== undefined) row.processing_error_message = state.errorMessage;
    this.stateHistory.push({ emailId, status: state.status });
  });

  listIncompleteEmails = vi.fn(async ({ startedBefore, limit }: { startedBefore: string; limit: number }): Promise<IncompleteEmail[]> =>
    this.rows
      .map((row, index) => ({ row, id: `email-${index + 1}` }))
      .filter(
        ({ row }) =>
          (row.processing_status === "RECEIVED" || row.processing_status === "PROCESSING") &&
          String(row.processing_started_at) < startedBefore
      )
      .slice(0, limit)
      .map(({ row, id }) => ({
        id,
        organizationId: row.organization_id,
        emailAccountId: row.email_account_id,
        provider: "GMAIL" as const,
        providerMessageId: row.provider_message_id,
        processingAttempts: Number(row.processing_attempts ?? 0)
      }))
  );

  loadEnabledRules = vi.fn(async (organizationId: string) => {
    void organizationId;
    // Mirrors the SQL filter enabled = true.
    return this.rules.filter((rule) => rule.enabled);
  });

  loadSettings = vi.fn(async () => this.settings);

  insertEmail = vi.fn(async (row: EmailInsertRow) => {
    const duplicate = this.rows.some(
      (existing) =>
        existing.email_account_id === row.email_account_id && existing.provider_message_id === row.provider_message_id
    );
    if (duplicate) return null;
    this.rows.push(row);
    return { id: `email-${this.rows.length}` };
  });

  insertAttachments = vi.fn(async (rows: AttachmentInsertRow[]) => {
    const inserted: Array<{ id: string; providerAttachmentId: string | null }> = [];
    for (const row of rows) {
      // ON CONFLICT (email_id, provider_attachment_id) DO NOTHING
      const conflict =
        row.provider_attachment_id !== null &&
        this.attachments.some((existing) => existing.email_id === row.email_id && existing.provider_attachment_id === row.provider_attachment_id);
      if (conflict) continue;
      const id = `attachment-${this.attachments.length + 1}`;
      this.attachments.push({ ...row, id });
      inserted.push({ id, providerAttachmentId: row.provider_attachment_id });
    }
    return inserted;
  });

  listAttachments = vi.fn(async (emailId: string): Promise<StoredAttachment[]> =>
    this.attachments
      .filter((attachment) => attachment.email_id === emailId)
      .map((attachment) => ({
        id: attachment.id,
        providerAttachmentId: attachment.provider_attachment_id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        fileSize: attachment.file_size,
        isInline: attachment.is_inline,
        storageUploaded: attachment.storage_uploaded === true
      }))
  );

  markAttachmentStored = vi.fn(async (id: string, _bucket: string, path: string) => {
    const attachment = this.attachments.find((candidate) => candidate.id === id);
    if (attachment) {
      attachment.storage_path = path;
      attachment.storage_uploaded = true;
    }
  });
}

export function makeAccountStore(accounts: WorkerAccount[]): AccountStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getAccount: vi.fn(async (id: string) => accounts.find((account) => account.id === id) ?? null),
    findActiveAccountsByAddress: vi.fn(async (provider: string, address: string) =>
      accounts.filter((a) => a.provider === provider && a.emailAddress === address && a.status === "ACTIVE")
    ),
    findAccountBySubscription: vi.fn(async (subscriptionId: string) =>
      accounts.find((account) => account.providerMetadata.subscriptionId === subscriptionId) ?? null
    ),
    listActiveOAuthAccounts: vi.fn(async () =>
      accounts.filter((a) => a.status === "ACTIVE" && a.provider !== "IMAP").map((a) => ({ id: a.id, organizationId: a.organizationId }))
    ),
    updateSyncState: vi.fn(async () => undefined),
    saveTokens: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined)
  } as unknown as AccountStore & Record<string, ReturnType<typeof vi.fn>>;
}

export function makeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    provider: "GMAIL",
    listNewMessageIds: vi.fn(async (): Promise<ChangeSet> => ({ messageIds: [], nextCursor: "101" })),
    fetchMessage: vi.fn(async (_context, id: string) => makeEmail({ providerMessageId: id })),
    downloadAttachment: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...overrides
  } as ProviderAdapter & Record<string, ReturnType<typeof vi.fn>>;
}

export function makeRegistry(gmail: ProviderAdapter): ProviderRegistry {
  return { GMAIL: gmail, MICROSOFT: gmail, IMAP: gmail };
}

export function makeProducer() {
  const processing: EmailProcessingJob[] = [];
  const notifications: NotificationJob[] = [];
  return {
    processing,
    notifications,
    enqueueProcessing: vi.fn(async (job: EmailProcessingJob) => {
      processing.push(job);
    }),
    enqueueNotification: vi.fn(async (job: NotificationJob) => {
      notifications.push(job);
    })
  };
}

export function makeRealtime() {
  const events: RealtimeEvent[] = [];
  return { events, publish: vi.fn(async (event: RealtimeEvent) => void events.push(event)) };
}
