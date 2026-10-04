import { SecretBoxError, serializeError } from "@emailbot/shared";
import { ProviderAuthError, ProviderNotImplementedError } from "../providers/types.js";
import type { AccountStore, Logger, RealtimePublisher } from "./ports.js";

/** Error that must not be retried by the queue. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Converts provider failures into account state:
 *  - revoked/invalid credentials -> account ERROR (user must reconnect), no retry
 *  - integration not implemented -> recorded on the account, no retry
 *  - anything else -> rethrown so BullMQ retries with backoff
 */
export async function handleAccountFailure(
  error: unknown,
  account: { id: string; organizationId: string } | null,
  deps: { accounts: AccountStore; realtime: RealtimePublisher; logger: Logger }
): Promise<never> {
  if (account && error instanceof ProviderAuthError) {
    await deps.accounts.markError(account.id, {
      code: error.code,
      message: "The mailbox authorization is no longer valid. Reconnect the account.",
      status: "ERROR"
    });
    await deps.realtime
      .publish({
        type: "email-account.status",
        organizationId: account.organizationId,
        emailAccountId: account.id,
        status: "ERROR"
      })
      .catch(() => undefined);
    deps.logger.warn({ emailAccountId: account.id, code: error.code }, "account credentials invalid");
    throw new NonRetryableError(error.message);
  }

  if (account && error instanceof SecretBoxError) {
    // Almost always a TOKEN_ENCRYPTION_KEY that differs from the API's (compare
    // the key fingerprints both services log at startup). Retrying cannot help.
    await deps.accounts.markError(account.id, {
      code: "CREDENTIALS_UNREADABLE",
      message: "Stored credentials cannot be decrypted with the worker's TOKEN_ENCRYPTION_KEY."
    });
    deps.logger.error({ emailAccountId: account.id }, "stored credentials cannot be decrypted: check TOKEN_ENCRYPTION_KEY");
    throw new NonRetryableError(error.message);
  }
  if (account && error instanceof ProviderNotImplementedError) {
    await deps.accounts.markError(account.id, { code: "PROVIDER_NOT_IMPLEMENTED", message: error.message });
    throw new NonRetryableError(error.message);
  }

  deps.logger.error({ err: serializeError(error), emailAccountId: account?.id }, "job failed");
  throw error;
}
