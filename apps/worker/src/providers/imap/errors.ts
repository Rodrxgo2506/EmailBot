import { ImapDestinationError, SecretBoxError } from "@emailbot/shared";
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
 * The messages are fixed strings: never the server's text, an address, a host
 * name or a credential (the original error is not attached).
 */

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

const DESTINATION_TRANSIENT = new Set(["IMAP_DNS_FAILED", "IMAP_DNS_NO_ADDRESSES"]);

interface ImapLikeError {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  serverResponseCode?: unknown;
  responseStatus?: unknown;
  message?: unknown;
}

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

  if (error instanceof ImapDestinationError) {
    if (DESTINATION_TRANSIENT.has(error.code)) return new ProviderTransientError("The IMAP server name could not be resolved", null);
    return new ProviderSecurityError("The IMAP server is not an allowed destination", "IMAP_HOST_FORBIDDEN");
  }

  const value = (typeof error === "object" && error !== null ? error : {}) as ImapLikeError;
  const code = typeof value.code === "string" ? value.code : "";
  const responseCode = typeof value.serverResponseCode === "string" ? value.serverResponseCode.toUpperCase() : "";

  if (value.authenticationFailed === true || responseCode === "AUTHENTICATIONFAILED" || responseCode === "AUTHORIZATIONFAILED") {
    return new ProviderAuthError("The IMAP server refused the login", "IMAP_AUTH_FAILED");
  }
  // 1. Certificate / TLS protocol codes: always a security failure (also inside a STARTTLS upgrade).
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) {
    return new ProviderSecurityError("The IMAP server's certificate or TLS connection could not be verified", "IMAP_TLS_FAILED");
  }
  // 2. ImapFlow sets `tlsFailed` on ANY error of a STARTTLS upgrade (imap-flow.js: "marked as a TLS
  //    failure"), including a network cut or the upgrade timeout. Only those known network codes are
  //    transient; everything else stays a security failure (fail closed, never a plaintext fallback):
  //      no code              -> the server did not offer / accept STARTTLS
  //      STARTTLS_INJECTION   -> plaintext data after the STARTTLS response (possible attack)
  //      any other code       -> unknown TLS failure
  if (value.tlsFailed === true) {
    if (STARTTLS_TRANSIENT_CODES.has(code)) return new ProviderTransientError("The IMAP server is temporarily unreachable", null);
    if (code === "") return new ProviderSecurityError("The IMAP server does not offer a secure (STARTTLS) connection", "IMAP_STARTTLS_UNAVAILABLE");
    return new ProviderSecurityError("The IMAP server's certificate or TLS connection could not be verified", "IMAP_TLS_FAILED");
  }
  if (TRANSIENT_CODES.has(code) || responseCode === "UNAVAILABLE" || responseCode === "INUSE" || responseCode === "SERVERBUG") {
    return new ProviderTransientError("The IMAP server is temporarily unreachable", null);
  }
  // Anything unexpected is retried with the existing bounded backoff (never silently ignored).
  return new ProviderTransientError("The IMAP operation failed", null);
}
