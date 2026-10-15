import type { ImapEndpoint } from "@emailbot/types";
import { ImapFlow } from "imapflow";
import { formatImapCursor } from "./imap-cursor.js";
import {
  assertSafeImapConnectionOptions,
  ImapDestinationError,
  imapConnectionOptions,
  resolveImapDestination,
  type ImapConnectionOptions,
  type ImapResolver
} from "./imap-destination.js";

/*
 * IMAP transport shared by the worker (synchronization, E2) and the API
 * (connection test before an account is stored, E3). Server-only (ImapFlow).
 *
 *   createImapConnector(): stored / submitted settings -> resolveImapDestination
 *   (E1: every A/AAAA public, no internal name, 993/TLS or 143/STARTTLS) ->
 *   imapConnectionOptions (host = a validated IP literal, servername = the DNS
 *   name, certificate always verified, TLS >= 1.2, STARTTLS mandatory on 143, no
 *   proxy) -> assertSafeImapConnectionOptions -> openImapClient (ImapFlow).
 *
 * DNS is resolved and checked again for EVERY new connection and the socket
 * goes to the IP that passed the check: nothing is resolved at connect time (no
 * DNS rebinding). The login is sent only after TLS (993) or a completed STARTTLS
 * upgrade (143); there is never a plaintext fallback.
 *
 * classifyImapFailure() maps whatever a connection throws to a neutral
 * ImapTransportError (kind + stable code + fixed message: never the server's
 * text, an address, a host name or a credential). Each application maps the kind
 * to its own errors (worker: providers/imap/errors.ts, API: email-accounts).
 */

/** The ImapFlow client type, for callers that keep a narrower view of it (the worker pool). */
export type { ImapFlow };

/** Connection deadlines (ms): DNS + TCP + TLS, server greeting, inactivity. */
export const IMAP_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 60_000 } as const;

/** Validated addresses tried per connection when the previous one is unreachable (never after a TLS / login failure). */
export const IMAP_MAX_ADDRESS_ATTEMPTS = 2;

export interface ImapLogin {
  username: string;
  password: string;
}

/**
 *   AUTH       login refused
 *   SECURITY   forbidden destination, certificate / TLS failure, no STARTTLS
 *   TRANSIENT  DNS failure, timeout, reset, refused, server busy, anything unexpected
 *   MAILBOX    INBOX cannot be opened read-only (connection test only)
 */
export type ImapFailureKind = "AUTH" | "SECURITY" | "TRANSIENT" | "MAILBOX";

export type ImapFailureCode =
  | "IMAP_AUTH_FAILED"
  | "IMAP_HOST_FORBIDDEN"
  | "IMAP_TLS_FAILED"
  | "IMAP_STARTTLS_UNAVAILABLE"
  | "IMAP_DNS_FAILED"
  | "IMAP_TIMEOUT"
  | "IMAP_UNREACHABLE"
  | "IMAP_FAILED"
  | "IMAP_INBOX_UNAVAILABLE";

export class ImapTransportError extends Error {
  constructor(
    readonly kind: ImapFailureKind,
    readonly code: ImapFailureCode,
    message: string
  ) {
    super(message);
    this.name = "ImapTransportError";
  }
}

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_UNSUPPORTED_PROTOCOL",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_NO_PROTOCOLS_AVAILABLE",
  "ERR_TLS_INVALID_PROTOCOL_VERSION"
]);

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETIMEOUT",
  "NoConnection",
  "ClosedAfterConnectTLS",
  "ClosedAfterConnectText",
  "EConnectionClosed"
]);

/** Network failures that interrupt a STARTTLS handshake (ImapFlow flags them tlsFailed too). */
const STARTTLS_TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ETIMEOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UPGRADE_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS"
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

const DESTINATION_TRANSIENT = new Set(["IMAP_DNS_FAILED", "IMAP_DNS_NO_ADDRESSES"]);

const MESSAGES = {
  unresolved: "The IMAP server name could not be resolved",
  forbidden: "The IMAP server is not an allowed destination",
  auth: "The IMAP server refused the login",
  tls: "The IMAP server's certificate or TLS connection could not be verified",
  starttls: "The IMAP server does not offer a secure (STARTTLS) connection",
  unreachable: "The IMAP server is temporarily unreachable",
  failed: "The IMAP operation failed"
} as const;

const transient = (code: ImapFailureCode, message: string = MESSAGES.unreachable) => new ImapTransportError("TRANSIENT", code, message);
const networkCode = (code: string): ImapFailureCode => (TIMEOUT_CODES.has(code) ? "IMAP_TIMEOUT" : "IMAP_UNREACHABLE");

interface ImapLikeError {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  serverResponseCode?: unknown;
}

export function classifyImapFailure(error: unknown): ImapTransportError {
  if (error instanceof ImapTransportError) return error;

  if (error instanceof ImapDestinationError) {
    if (DESTINATION_TRANSIENT.has(error.code)) return transient("IMAP_DNS_FAILED", MESSAGES.unresolved);
    return new ImapTransportError("SECURITY", "IMAP_HOST_FORBIDDEN", MESSAGES.forbidden);
  }

  const value = (typeof error === "object" && error !== null ? error : {}) as ImapLikeError;
  const code = typeof value.code === "string" ? value.code : "";
  const responseCode = typeof value.serverResponseCode === "string" ? value.serverResponseCode.toUpperCase() : "";

  if (value.authenticationFailed === true || responseCode === "AUTHENTICATIONFAILED" || responseCode === "AUTHORIZATIONFAILED") {
    return new ImapTransportError("AUTH", "IMAP_AUTH_FAILED", MESSAGES.auth);
  }
  // 1. Certificate / TLS protocol codes: always a security failure (also inside a STARTTLS upgrade).
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) {
    return new ImapTransportError("SECURITY", "IMAP_TLS_FAILED", MESSAGES.tls);
  }
  // 2. ImapFlow sets `tlsFailed` on ANY error of a STARTTLS upgrade (imap-flow.js: "marked as a TLS
  //    failure"), including a network cut or the upgrade timeout. Only those known network codes are
  //    transient; everything else stays a security failure (fail closed, never a plaintext fallback):
  //      no code              -> the server did not offer / accept STARTTLS
  //      STARTTLS_INJECTION   -> plaintext data after the STARTTLS response (possible attack)
  //      any other code       -> unknown TLS failure
  if (value.tlsFailed === true) {
    if (STARTTLS_TRANSIENT_CODES.has(code)) return transient(networkCode(code));
    if (code === "") return new ImapTransportError("SECURITY", "IMAP_STARTTLS_UNAVAILABLE", MESSAGES.starttls);
    return new ImapTransportError("SECURITY", "IMAP_TLS_FAILED", MESSAGES.tls);
  }
  if (TRANSIENT_CODES.has(code)) return transient(networkCode(code));
  if (responseCode === "UNAVAILABLE" || responseCode === "INUSE" || responseCode === "SERVERBUG") return transient("IMAP_UNREACHABLE");
  // Anything unexpected is retried by the worker with its bounded backoff (never silently ignored).
  return transient("IMAP_FAILED", MESSAGES.failed);
}

/**
 * ImapFlow for already-checked options. Connected and logged in, or throws a
 * classified ImapTransportError. It never validates anything by itself: it is
 * called by createImapConnector after the checks (and by the local integration
 * tests, which point `host` at the test server). `onClient` receives the client
 * as soon as it exists, so a caller enforcing a deadline can close it mid-connect.
 */
export async function openImapClient(options: ImapConnectionOptions, login: ImapLogin, hooks: { onClient?: (client: ImapFlow) => void } = {}): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.doSTARTTLS === true ? { doSTARTTLS: true } : {}),
    servername: options.servername,
    // Frozen by E1; ImapFlow copies it (Object.assign) for tls.connect / the STARTTLS upgrade.
    tls: options.tls,
    auth: { user: login.username, pass: login.password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    qresync: false,
    connectionTimeout: IMAP_TIMEOUTS.connectionTimeout,
    greetingTimeout: IMAP_TIMEOUTS.greetingTimeout,
    socketTimeout: IMAP_TIMEOUTS.socketTimeout
  });
  // An unhandled 'error' event would crash the process; callers see failures as rejections.
  client.on("error", () => undefined);
  hooks.onClient?.(client);
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.close();
    throw classifyImapFailure(error);
  }
}

export interface ImapConnectorOptions<C> {
  resolver?: ImapResolver;
  /** Replaceable so tests observe the checked options without a network; always receives options that passed assertSafeImapConnectionOptions. */
  open?: (options: ImapConnectionOptions, login: ImapLogin) => Promise<C>;
  /** Maps a failure to the caller's error (default: classifyImapFailure). */
  classify?: (error: unknown) => Error;
  /** Whether a (classified) failure may move on to the next validated address (default: TRANSIENT). */
  isRetryable?: (error: Error) => boolean;
}

export type ImapConnector<C> = (endpoint: ImapEndpoint, login: ImapLogin) => Promise<C>;

/** The production connector: SSRF / TLS checks of E1, then ImapFlow (up to IMAP_MAX_ADDRESS_ATTEMPTS validated addresses). */
export function createImapConnector<C = ImapFlow>(options: ImapConnectorOptions<C> = {}): ImapConnector<C> {
  const open = options.open ?? (openImapClient as unknown as (options: ImapConnectionOptions, login: ImapLogin) => Promise<C>);
  const classify = options.classify ?? classifyImapFailure;
  const isRetryable = options.isRetryable ?? ((error: Error) => error instanceof ImapTransportError && error.kind === "TRANSIENT");
  return async (endpoint, login) => {
    let destination;
    try {
      destination = await resolveImapDestination(endpoint, options.resolver ? { resolver: options.resolver } : {});
    } catch (error) {
      throw classify(error);
    }
    let lastError: Error | null = null;
    for (const { address } of destination.addresses.slice(0, IMAP_MAX_ADDRESS_ATTEMPTS)) {
      let connectionOptions: ImapConnectionOptions;
      try {
        connectionOptions = imapConnectionOptions(destination, address);
        assertSafeImapConnectionOptions(connectionOptions);
      } catch (error) {
        throw classify(error);
      }
      try {
        return await open(connectionOptions, login);
      } catch (error) {
        lastError = classify(error);
        // Only an unreachable address moves on to the next validated one.
        if (!isRetryable(lastError)) throw lastError;
      }
    }
    throw lastError ?? classify(transient("IMAP_UNREACHABLE"));
  };
}

/* ---------------------------------------------------------------- *
 * Connection test (E3): log in, EXAMINE INBOX, read its position, log out.
 * ---------------------------------------------------------------- */

/** The ImapFlow surface the connection test uses (fakes in unit tests). */
export type ImapProbeClient = Pick<ImapFlow, "getMailboxLock" | "mailbox" | "logout" | "close">;

export type ImapProbeOpen = (options: ImapConnectionOptions, login: ImapLogin, onClient: (client: ImapProbeClient) => void) => Promise<ImapProbeClient>;

/** Whole connection test (DNS, every address attempt, TLS, login, EXAMINE, LOGOUT): past it every client is closed. */
export const IMAP_PROBE_DEADLINE_MS = 30_000;

export interface ImapInboxPosition {
  uidValidity: number;
  uidNext: number;
  /**
   * Initial sync cursor "imap:v1:<UIDVALIDITY>:<UIDNEXT - 1>": the worker imports only UIDs above it.
   * Every message added after this EXAMINE gets a UID >= UIDNEXT (RFC 3501 2.3.1.1: UIDs strictly
   * ascending, UIDNEXT unchanged unless messages are added), so nothing older is imported and
   * nothing that arrives between the connection and the first synchronization is lost.
   */
  cursor: string;
}

const MAX_UINT32 = 0xffffffff;
const inboxUnavailable = () => new ImapTransportError("MAILBOX", "IMAP_INBOX_UNAVAILABLE", "The IMAP INBOX could not be opened read-only");

/**
 * Connects through createImapConnector (all E1 checks), opens INBOX with EXAMINE
 * (read-only: nothing is marked \Seen, expunged or changed), reads UIDVALIDITY /
 * UIDNEXT and logs out. Every client created is closed on success, on failure and
 * when the deadline expires (forced close, even mid-handshake). Never reads a message.
 */
export async function probeImapInbox(
  endpoint: ImapEndpoint,
  login: ImapLogin,
  options: { resolver?: ImapResolver; open?: ImapProbeOpen; deadlineMs?: number } = {}
): Promise<ImapInboxPosition> {
  const clients = new Set<ImapProbeClient>();
  const loggedOut = new Set<ImapProbeClient>();
  const open: ImapProbeOpen = options.open ?? ((connectionOptions, credentials, onClient) => openImapClient(connectionOptions, credentials, { onClient }));
  const connect = createImapConnector<ImapProbeClient>({
    ...(options.resolver ? { resolver: options.resolver } : {}),
    open: (connectionOptions, credentials) => open(connectionOptions, credentials, (client) => clients.add(client))
  });

  const work = (async (): Promise<ImapInboxPosition> => {
    const client = await connect(endpoint, login);
    clients.add(client);
    let uidValidity: number;
    let uidNext: number;
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const mailbox = client.mailbox;
        // EXAMINE was sent; a server answering [READ-WRITE] to it is not trusted.
        if (!mailbox || mailbox.readOnly === false) throw inboxUnavailable();
        uidValidity = Number(mailbox.uidValidity);
        uidNext = Number(mailbox.uidNext);
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof ImapTransportError) throw error;
      // A tagged NO / BAD to EXAMINE: no INBOX for this login. Anything else (network) is classified.
      const status = (error as { responseStatus?: unknown } | null)?.responseStatus;
      if (status === "NO" || status === "BAD") throw inboxUnavailable();
      throw classifyImapFailure(error);
    }
    // UIDVALIDITY and UIDNEXT are mandatory in the EXAMINE answer (RFC 3501 6.3.1); without them
    // the worker could not keep a cursor either, so the mailbox is refused rather than guessed.
    if (!Number.isSafeInteger(uidValidity) || uidValidity < 1 || uidValidity > MAX_UINT32) throw inboxUnavailable();
    if (!Number.isSafeInteger(uidNext) || uidNext < 1 || uidNext > MAX_UINT32 + 1) throw inboxUnavailable();
    try {
      await client.logout();
      loggedOut.add(client);
    } catch {
      // The position is already known; the client is closed below.
    }
    return { uidValidity, uidNext, cursor: formatImapCursor({ uidValidity, uid: uidNext - 1 }) };
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(transient("IMAP_TIMEOUT")), options.deadlineMs ?? IMAP_PROBE_DEADLINE_MS);
  });
  // After the deadline the abandoned attempt still settles (its socket is closed below): never unhandled.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    throw classifyImapFailure(error);
  } finally {
    clearTimeout(timer);
    for (const client of clients) {
      if (loggedOut.has(client)) continue;
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}
