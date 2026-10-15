import { classifyImapFailure, SecretBoxError } from "@emailbot/shared";
import { ProviderHttpError } from "../http.js";
import { ProviderAuthError, ProviderSecurityError, ProviderTransientError } from "../types.js";

/*
 * Maps whatever an IMAP connection or command throws to the worker's error
 * classes (failures.ts / syncAccount decide what to do with each):
 *
 *   ProviderAuthError      login refused                -> account ERROR, no retry
 *   ProviderSecurityError  forbidden destination, TLS,  -> account ERROR, no retry
 *                          certificate, no STARTTLS,
 *                          invalid stored settings
 *   ProviderTransientError DNS failure, timeout, reset, -> BullMQ retries (bounded)
 *                          refused, server busy
 *   SecretBoxError         unreadable credentials       -> passed through (CREDENTIALS_UNREADABLE)
 *
 * The classification itself (TLS / STARTTLS / network codes, in that order) is
 * the shared transport's classifyImapFailure (@emailbot/shared, imap-client.ts),
 * also used by the API. The messages are its fixed strings: never the server's
 * text, an address, a host name or a credential (the original error is not attached).
 */

export function classifyImapError(error: unknown): Error {
  if (
    error instanceof ProviderAuthError ||
    error instanceof ProviderSecurityError ||
    error instanceof ProviderTransientError ||
    error instanceof SecretBoxError ||
    // 404 = the message is gone (or its UIDVALIDITY changed): processMessages skips it.
    error instanceof ProviderHttpError
  ) {
    return error;
  }

  const failure = classifyImapFailure(error);
  switch (failure.kind) {
    case "AUTH":
      return new ProviderAuthError(failure.message, failure.code);
    case "SECURITY":
      return new ProviderSecurityError(failure.message, failure.code);
    default:
      // TRANSIENT (and MAILBOX, which only the API's connection test produces): retried with the bounded backoff.
      return new ProviderTransientError(failure.message, null);
  }
}
