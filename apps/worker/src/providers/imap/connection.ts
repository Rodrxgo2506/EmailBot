import { createHash } from "node:crypto";
import {
  assertSafeImapConnectionOptions,
  imapConnectionOptions,
  resolveImapDestination,
  type ImapConnectionOptions,
  type ImapResolver
} from "@emailbot/shared";
import { imapEndpointProblem, type ImapEndpoint } from "@emailbot/types";
import { ImapFlow } from "imapflow";
import type { ImapCredentials, WorkerAccount } from "../types.js";
import { ProviderSecurityError, ProviderTransientError } from "../types.js";
import { classifyImapError } from "./errors.js";

/*
 * Opening an IMAP connection. The production path is connectImap():
 *
 *   stored settings (re-validated) -> resolveImapDestination (E1: every A/AAAA
 *   public, no internal name, 993/TLS or 143/STARTTLS) -> imapConnectionOptions
 *   (host = a validated IP literal, servername = the DNS name, certificate
 *   always verified, TLS >= 1.2, STARTTLS mandatory on 143, no proxy) ->
 *   assertSafeImapConnectionOptions -> ImapFlow.
 *
 * DNS is resolved and checked again for EVERY new connection (the database is
 * not trusted for this), and the socket goes to the IP that passed the check:
 * nothing is resolved again at connect time (no DNS rebinding).
 *
 * openImapClient() is the ImapFlow part only. It never validates anything by
 * itself and is called by connectImap() after the checks; it is exported for
 * the local integration tests, which point `host` at the test server.
 */

/** Connection deadlines (ms): DNS + TCP + TLS, server greeting, inactivity. */
export const IMAP_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 60_000 } as const;

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

/** ImapFlow for already-checked options. Connected and logged in, or throws a classified error. */
export async function openImapClient(options: ImapConnectionOptions, credentials: ImapCredentials): Promise<ImapClient> {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.doSTARTTLS === true ? { doSTARTTLS: true } : {}),
    servername: options.servername,
    // Frozen by E1; ImapFlow copies it (Object.assign) for tls.connect / the STARTTLS upgrade.
    tls: options.tls,
    auth: { user: credentials.username, pass: credentials.password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    qresync: false,
    connectionTimeout: IMAP_TIMEOUTS.connectionTimeout,
    greetingTimeout: IMAP_TIMEOUTS.greetingTimeout,
    socketTimeout: IMAP_TIMEOUTS.socketTimeout
  });
  // An unhandled 'error' event would crash the worker; the pool and the callers see failures as rejections.
  client.on("error", () => undefined);
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.close();
    throw classifyImapError(error);
  }
}

/** Validated addresses tried per connection when the previous one is unreachable (never after a TLS / login failure). */
export const IMAP_MAX_ADDRESS_ATTEMPTS = 2;

/**
 * The production connector: SSRF / TLS checks of E1, then ImapFlow. `open`
 * is replaceable only so unit tests can observe the checked options without a
 * network; it always receives options that passed assertSafeImapConnectionOptions.
 */
export function createImapConnector(
  options: { resolver?: ImapResolver; open?: (options: ImapConnectionOptions, credentials: ImapCredentials) => Promise<ImapClient> } = {}
): ImapConnector {
  const open = options.open ?? openImapClient;
  return async (endpoint, credentials) => {
    let destination;
    try {
      destination = await resolveImapDestination(endpoint, options.resolver ? { resolver: options.resolver } : {});
    } catch (error) {
      throw classifyImapError(error);
    }
    let lastError: Error | null = null;
    for (const { address } of destination.addresses.slice(0, IMAP_MAX_ADDRESS_ATTEMPTS)) {
      let connectionOptions: ImapConnectionOptions;
      try {
        connectionOptions = imapConnectionOptions(destination, address);
        assertSafeImapConnectionOptions(connectionOptions);
      } catch (error) {
        throw classifyImapError(error);
      }
      try {
        return await open(connectionOptions, credentials);
      } catch (error) {
        lastError = classifyImapError(error);
        // Only an unreachable address moves on to the next validated one.
        if (!(lastError instanceof ProviderTransientError)) throw lastError;
      }
    }
    throw lastError ?? new ProviderTransientError("The IMAP server is temporarily unreachable", null);
  };
}
