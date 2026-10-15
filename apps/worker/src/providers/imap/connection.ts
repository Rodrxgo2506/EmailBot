import { createHash } from "node:crypto";
import {
  createImapConnector as createSharedImapConnector,
  IMAP_MAX_ADDRESS_ATTEMPTS,
  IMAP_TIMEOUTS,
  openImapClient as openSharedImapClient,
  type ImapConnectionOptions,
  type ImapFlow,
  type ImapResolver
} from "@emailbot/shared";
import { imapEndpointProblem, type ImapEndpoint } from "@emailbot/types";
import type { ImapCredentials, WorkerAccount } from "../types.js";
import { ProviderSecurityError, ProviderTransientError } from "../types.js";
import { classifyImapError } from "./errors.js";

/*
 * Opening an IMAP connection. The transport (E1 checks + ImapFlow) lives in
 * @emailbot/shared (imap-client.ts), shared with the API's connection test (E3):
 *
 *   stored settings (re-validated here) -> resolveImapDestination (E1: every
 *   A/AAAA public, no internal name, 993/TLS or 143/STARTTLS) ->
 *   imapConnectionOptions (host = a validated IP literal, servername = the DNS
 *   name, certificate always verified, TLS >= 1.2, STARTTLS mandatory on 143, no
 *   proxy) -> assertSafeImapConnectionOptions -> ImapFlow.
 *
 * This module keeps the worker's side: stored settings, pool keys and the
 * worker's error classes (classifyImapError).
 */

export { IMAP_MAX_ADDRESS_ATTEMPTS, IMAP_TIMEOUTS };

/** The ImapFlow surface the adapter and the pool use (fakes in unit tests). */
export type ImapClient = Pick<ImapFlow, "usable" | "logout" | "close" | "on" | "getMailboxLock" | "mailboxClose" | "mailbox" | "search" | "fetch" | "fetchOne" | "download">;

export type ImapConnector = (endpoint: ImapEndpoint, credentials: ImapCredentials) => Promise<ImapClient>;

/** provider_metadata.imap as stored by connect_imap_email_account (E1), re-validated before use. */
export function readImapEndpoint(account: Pick<WorkerAccount, "providerMetadata">): ImapEndpoint {
  const stored = (account.providerMetadata?.imap ?? null) as Record<string, unknown> | null;
  const endpoint = { host: stored?.host, port: stored?.port, security: stored?.security };
  if (!stored || imapEndpointProblem(endpoint) !== null) {
    // Legacy rows (boolean `secure`, unchecked host) or tampered settings: reconnect, never guess.
    throw new ProviderSecurityError("The stored IMAP settings are not valid; connect the mailbox again", "IMAP_SETTINGS_INVALID");
  }
  return endpoint as ImapEndpoint;
}

/** Pool key: the mailbox plus everything that defines its session (a changed server or password never reuses one). */
export function imapPoolKey(account: Pick<WorkerAccount, "id" | "accessTokenEncrypted">, endpoint: ImapEndpoint, username: string): string {
  const fingerprint = createHash("sha256")
    .update([endpoint.host, endpoint.port, endpoint.security, username, account.accessTokenEncrypted ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${account.id}:${fingerprint}`;
}

/**
 * ImapFlow for already-checked options (shared transport). Connected and logged in, or throws a worker error.
 * Protocol size limits: the synchronization profile (one message up to IMAP_MAX_MESSAGE_BYTES, E6.1).
 */
export async function openImapClient(options: ImapConnectionOptions, credentials: ImapCredentials): Promise<ImapClient> {
  try {
    return await openSharedImapClient(options, credentials, { profile: "sync" });
  } catch (error) {
    throw classifyImapError(error);
  }
}

/**
 * The production connector (shared transport: SSRF / TLS checks of E1, then
 * ImapFlow). `open` is replaceable only so unit tests can observe the checked
 * options without a network; it always receives options that passed
 * assertSafeImapConnectionOptions.
 */
export function createImapConnector(
  options: { resolver?: ImapResolver; open?: (options: ImapConnectionOptions, credentials: ImapCredentials) => Promise<ImapClient> } = {}
): ImapConnector {
  return createSharedImapConnector<ImapClient>({
    ...(options.resolver ? { resolver: options.resolver } : {}),
    open: options.open ?? openImapClient,
    classify: classifyImapError,
    // Only an unreachable address moves on to the next validated one.
    isRetryable: (error) => error instanceof ProviderTransientError
  });
}
