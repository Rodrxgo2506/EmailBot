import type { EmailRuleRow } from "@emailbot/rules-engine";
import type { EmailProcessingJob, NotificationJob } from "@emailbot/shared";
import type { CustomerIdentifierType, CustomerStatus, NormalizedEmail, RealtimeEvent } from "@emailbot/types";
import { vi } from "vitest";
import type {
  AccountStore,
  AttachmentInsertRow,
  DeliveryInsertRow,
  EmailInsertRow,
  EmailStore,
  Logger,
  ExistingEmail,
  IdentifierCandidate,
  IncompleteEmail,
  OrganizationProcessingSettings,
  ProcessingStateUpdate,
  RoutingBot,
  RoutingStore,
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
    organizationStatus: "ACTIVE",
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
      processingStartedAt: (row.processing_started_at as string | null) ?? null,
      botId: (row.bot_id as string | null | undefined) ?? null,
      botSelection: (row.provider_metadata as { botSelection?: string } | undefined)?.botSelection === "AMBIGUOUS" ? "AMBIGUOUS" : null,
      extractedData: (row.extracted_data as Record<string, string> | undefined) ?? {}
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

export interface FakeIdentifier {
  id: string;
  organizationId: string;
  customerId: string;
  type: CustomerIdentifierType;
  normalizedValue: string;
  botId: string | null;
  active: boolean;
}

/**
 * In-memory RoutingStore mirroring the SQL of createRoutingStore and the
 * database guarantees of email_deliveries: unique (email_id, customer_id),
 * delivery bot = email bot and same organization (composite FKs), and the
 * eligibility trigger (bot ACTIVE, customer ACTIVE, active assignment).
 */
export class MemoryRoutingStore implements RoutingStore {
  bots = new Map<string, RoutingBot>();
  customers = new Map<string, { organizationId: string; status: CustomerStatus }>();
  identifiers: FakeIdentifier[] = [];
  assignments: Array<{ organizationId: string; botId: string; customerId: string; active: boolean }> = [];
  deliveries: DeliveryInsertRow[] = [];

  constructor(private readonly emails: MemoryEmailStore) {}

  addBot(id: string, customerResolution: unknown, overrides: Partial<RoutingBot> = {}): this {
    this.bots.set(id, { id, organizationId: ORG, status: "ACTIVE", customerResolution, ...overrides });
    return this;
  }

  /** Customer (ACTIVE) with one identifier and an active assignment to each bot given. */
  addCustomer(
    id: string,
    identifier: Partial<FakeIdentifier> & { normalizedValue: string },
    options: { organizationId?: string; status?: CustomerStatus; bots?: string[] } = {}
  ): this {
    const organizationId = options.organizationId ?? ORG;
    this.customers.set(id, { organizationId, status: options.status ?? "ACTIVE" });
    this.identifiers.push({
      id: `identifier-${id}-${this.identifiers.length + 1}`,
      organizationId,
      customerId: id,
      type: "EMAIL",
      botId: null,
      active: true,
      ...identifier
    });
    for (const botId of options.bots ?? []) this.assignments.push({ organizationId, botId, customerId: id, active: true });
    return this;
  }

  loadBot = vi.fn(async (organizationId: string, botId: string): Promise<RoutingBot | null> => {
    const bot = this.bots.get(botId);
    return bot && bot.organizationId === organizationId ? bot : null;
  });

  findCandidates = vi.fn(
    async (query: { organizationId: string; botId: string; type: CustomerIdentifierType; values: string[] }): Promise<IdentifierCandidate[]> =>
      this.identifiers
        .filter(
          (identifier) =>
            identifier.organizationId === query.organizationId &&
            identifier.type === query.type &&
            identifier.active &&
            (identifier.botId === null || identifier.botId === query.botId) &&
            query.values.includes(identifier.normalizedValue) &&
            this.customers.has(identifier.customerId)
        )
        .map((identifier) => ({
          identifierId: identifier.id,
          organizationId: identifier.organizationId,
          customerId: identifier.customerId,
          type: identifier.type,
          normalizedValue: identifier.normalizedValue,
          botId: identifier.botId,
          active: identifier.active,
          customerStatus: this.customers.get(identifier.customerId)?.status ?? "SUSPENDED",
          assigned: this.isAssigned(query.organizationId, query.botId, identifier.customerId)
        }))
  );

  insertDeliveries = vi.fn(async (rows: DeliveryInsertRow[]): Promise<string[]> => {
    // One statement: every row is checked before anything is written.
    for (const row of rows) {
      const email = this.emails.row(row.email_id);
      if (email.organization_id !== row.organization_id || email.bot_id !== row.bot_id) throw new Error("email_deliveries_email_fkey");
      const customer = this.customers.get(row.customer_id);
      if (!customer || customer.organizationId !== row.organization_id) throw new Error("email_deliveries_customer_fkey");
      if (this.bots.get(row.bot_id)?.status !== "ACTIVE") throw new Error("Bot is not active");
      if (customer.status !== "ACTIVE") throw new Error("Customer is not active");
      if (!this.isAssigned(row.organization_id, row.bot_id, row.customer_id)) throw new Error("Customer is not assigned to the bot");
    }
    const inserted: string[] = [];
    for (const row of rows) {
      // ON CONFLICT (email_id, customer_id) DO NOTHING
      if (this.deliveries.some((existing) => existing.email_id === row.email_id && existing.customer_id === row.customer_id)) continue;
      this.deliveries.push(row);
      inserted.push(row.customer_id);
    }
    return inserted;
  });

  private isAssigned(organizationId: string, botId: string, customerId: string): boolean {
    return this.assignments.some(
      (assignment) =>
        assignment.organizationId === organizationId && assignment.botId === botId && assignment.customerId === customerId && assignment.active
    );
  }
}

export function makeAudit() {
  const entries: Array<{ organizationId: string; emailId: string; event: string; description: string; metadata: Record<string, unknown> }> = [];
  const accountEntries: Array<{
    organizationId: string;
    emailAccountId: string;
    action: "PROCESS" | "UPDATE" | "FAIL";
    event: string;
    description: string;
    metadata: Record<string, unknown>;
  }> = [];
  return {
    entries,
    accountEntries,
    recordEmailEvent: vi.fn(async (entry: (typeof entries)[number]) => void entries.push(entry)),
    recordAccountEvent: vi.fn(async (entry: (typeof accountEntries)[number]) => void accountEntries.push(entry))
  };
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
      accounts
        .filter((a) => a.status === "ACTIVE" && a.organizationStatus === "ACTIVE" && a.provider !== "IMAP")
        .map((a) => ({ id: a.id, organizationId: a.organizationId }))
    ),
    updateSyncState: vi.fn(async () => undefined),
    // Compare-and-set on the in-memory account (the database does the same with .eq(sync_cursor)).
    advanceSyncCursor: vi.fn(async (id: string, state: { from: string | null; to: string | null; lastSyncedAt: string }) => {
      const account = accounts.find((candidate) => candidate.id === id);
      if (!account || account.syncCursor !== state.from) return false;
      account.syncCursor = state.to;
      account.lastSyncedAt = state.lastSyncedAt;
      return true;
    }),
    saveWatchState: vi.fn(async (id: string, state: { expiresAt?: string | null; errorCode: string | null }) => {
      const account = accounts.find((candidate) => candidate.id === id);
      if (account && state.expiresAt !== undefined) account.watchExpiresAt = state.expiresAt;
    }),
    listAccountsNeedingWatch: vi.fn(async ({ renewBefore }: { renewBefore: string; limit: number }) =>
      accounts
        .filter(
          (a) =>
            a.provider === "GMAIL" &&
            a.status === "ACTIVE" &&
            a.organizationStatus === "ACTIVE" &&
            (!a.watchExpiresAt || a.watchExpiresAt < renewBefore)
        )
        .map((a) => ({ id: a.id, organizationId: a.organizationId }))
    ),
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
