import type { EmailAccountStatus, EmailProvider, NormalizedEmail, OrganizationStatus } from "@emailbot/types";

/** Account as seen by the worker (service role; includes encrypted credentials). */
export interface WorkerAccount {
  id: string;
  organizationId: string;
  /** organizations.status: only ACTIVE organizations get mail processed (EmailBot V2). */
  organizationStatus: OrganizationStatus;
  provider: EmailProvider;
  status: EmailAccountStatus;
  emailAddress: string;
  syncCursor: string | null;
  /** Last successful sync (email_accounts.last_synced_at). */
  lastSyncedAt?: string | null;
  /** Gmail users.watch expiration (phase 5.6). */
  watchExpiresAt?: string | null;
  providerMetadata: Record<string, unknown>;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
}

export interface ProviderContext {
  account: WorkerAccount;
  /** Returns a valid access token, refreshing it when needed (OAuth providers only). */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /**
   * IMAP only: the mailbox login, decrypted in memory for this job (SecretBox v2
   * bound to the mailbox). Never logged, stored or returned anywhere else.
   */
  getImapCredentials?(): Promise<ImapCredentials>;
}

export interface ImapCredentials {
  username: string;
  password: string;
}

export interface ChangeSet {
  /** New provider message ids to process (deduplicated). */
  messageIds: string[];
  /** Cursor to persist once every id was processed (never before). */
  nextCursor: string | null;
  /** The run stopped early (bounded); the cursor points to the last change fully included. */
  hasMore?: boolean;
  /** The cursor is too old for the provider's change history: recover with recoverMessageIds. */
  historyGap?: boolean;
  /**
   * IMAP only (M1): new messages skipped because their INTERNALDATE is older than the `since`
   * option (never imported, never fetched); the cursor moved past them. Reported by syncAccount.
   */
  outOfWindow?: number;
  /** IMAP only (A2): the UIDs counted in `outOfWindow`, so a run that stops early reports only those behind its cursor. */
  outOfWindowUids?: number[];
}

export interface RecoverySet {
  /** Recent message ids (oldest first), bounded. */
  messageIds: string[];
  /** Mailbox position taken BEFORE listing (nothing arriving meanwhile is skipped). */
  nextCursor: string;
  /** More messages existed than the bound. */
  truncated: boolean;
}

/**
 * Contract every provider integration implements. Adapters fetch provider
 * data and normalize it; they never evaluate rules or touch the database.
 */
export interface ProviderAdapter {
  readonly provider: EmailProvider;
  /** `since` (IMAP only): messages received before it are not imported (bounded catch-up after a pause). */
  listNewMessageIds(context: ProviderContext, options?: { maxMessages?: number; since?: Date }): Promise<ChangeSet>;
  /** Bounded recovery after a history gap (Gmail). */
  recoverMessageIds?(context: ProviderContext, options: { since: Date; maxMessages: number }): Promise<RecoverySet>;
  /** Push subscription (Gmail users.watch on a Pub/Sub topic). */
  watch?(context: ProviderContext, topicName: string): Promise<{ expiresAt: string }>;
  fetchMessage(context: ProviderContext, providerMessageId: string): Promise<NormalizedEmail>;
  downloadAttachment(
    context: ProviderContext,
    providerMessageId: string,
    providerAttachmentId: string
  ): Promise<Uint8Array>;
}

/** Credentials revoked/invalid: the account needs to be reconnected. Not retryable. */
export class ProviderAuthError extends Error {
  constructor(
    message: string,
    readonly code = "PROVIDER_AUTH_FAILED"
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

/**
 * The connection cannot be made safely: forbidden destination (SSRF guard),
 * invalid certificate, TLS failure, STARTTLS not offered, or settings that no
 * longer pass validation. The account goes to ERROR; not retryable (retrying
 * cannot fix it and must never fall back to a weaker connection).
 * The message is generic: no address, host or credential.
 */
export class ProviderSecurityError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "ProviderSecurityError";
  }
}

/** Provider integration that exists only as a scaffold. Not retryable. */
export class ProviderNotImplementedError extends Error {
  constructor(provider: EmailProvider, operation: string) {
    super(`${provider} ${operation} is not implemented yet`);
    this.name = "ProviderNotImplementedError";
  }
}

/** Temporary provider failure (429/5xx/network). Retried with backoff. */
export class ProviderTransientError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = "ProviderTransientError";
  }
}
