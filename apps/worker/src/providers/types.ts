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
  providerMetadata: Record<string, unknown>;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
}

export interface ProviderContext {
  account: WorkerAccount;
  /** Returns a valid access token, refreshing it when needed. */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

export interface ChangeSet {
  /** New provider message ids to process (deduplicated). */
  messageIds: string[];
  /** Cursor to persist after the ids were enqueued. */
  nextCursor: string | null;
}

/**
 * Contract every provider integration implements. Adapters fetch provider
 * data and normalize it; they never evaluate rules or touch the database.
 */
export interface ProviderAdapter {
  readonly provider: EmailProvider;
  listNewMessageIds(context: ProviderContext): Promise<ChangeSet>;
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
