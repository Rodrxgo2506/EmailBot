/*
 * IMAP connection settings shared by the API, the worker and the web form
 * (pure: no Node or browser APIs). The network checks (DNS resolution, IP
 * ranges, pinned lookup) live in @emailbot/shared (imap-destination.ts); the
 * database repeats the port / security pair in connect_imap_email_account.
 *
 * Only encrypted transports exist: TLS on 993 (implicit TLS) or STARTTLS on
 * 143 (the upgrade is mandatory: a server that does not offer it is refused).
 * There is no plaintext mode and no way to skip certificate validation.
 */

export const IMAP_SECURITY_MODES = ["TLS", "STARTTLS"] as const;
export type ImapSecurity = (typeof IMAP_SECURITY_MODES)[number];

/** The only port of each mode. Any other port or combination is refused. */
export const IMAP_PORT_BY_SECURITY: Readonly<Record<ImapSecurity, number>> = Object.freeze({ TLS: 993, STARTTLS: 143 });

/** Non-secret connection settings stored in email_accounts.provider_metadata.imap. */
export interface ImapEndpoint {
  host: string;
  port: number;
  security: ImapSecurity;
}

export type ImapEndpointProblem =
  | "HOST_REQUIRED"
  | "HOST_TOO_LONG"
  | "HOST_NOT_ASCII"
  | "HOST_IP_LITERAL"
  | "HOST_INVALID"
  | "HOST_NOT_PUBLIC"
  | "PORT_NOT_ALLOWED"
  | "SECURITY_INVALID";

const MAX_HOST_LENGTH = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Top-level label: letters only (or an IDNA A-label), so no numeric / hexadecimal IPv4 form can pass as a name. */
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Dotted, shortened, octal or hexadecimal IPv4 forms ("127.1", "0x7f.0.0.1", "2130706433"). */
const IPV4_LIKE = /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/;

/**
 * Names that never designate a public IMAP server: loopback, mDNS, private /
 * internal zones (RFC 6761, RFC 6762, RFC 8375, RFC 9476, common corporate
 * suffixes) and the reverse-DNS tree.
 */
const NON_PUBLIC_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "home.arpa",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "alt"
];

/**
 * Syntactic check of an IMAP host name: a fully qualified, public-looking DNS
 * name in canonical form (lower-case ASCII, no trailing dot). IP literals,
 * single-label and internal names are refused. Returns null when acceptable.
 * This is NOT the network check: the resolved addresses are verified by
 * resolveImapDestination (@emailbot/shared) before every connection.
 */
export function imapHostProblem(host: unknown): ImapEndpointProblem | null {
  if (typeof host !== "string" || host.length === 0) return "HOST_REQUIRED";
  if (host.length > MAX_HOST_LENGTH) return "HOST_TOO_LONG";
  // Unicode names must be given in their A-label form (xn--...): no look-alike or invisible characters.
  if (!/^[\x21-\x7e]+$/.test(host)) return "HOST_NOT_ASCII";
  if (host.includes(":") || host.startsWith("[") || IPV4_LIKE.test(host.toLowerCase())) return "HOST_IP_LITERAL";
  // Canonical form only: lower-case and no trailing dot (callers normalize user input first).
  if (host !== host.toLowerCase() || host.endsWith(".")) return "HOST_INVALID";

  const labels = host.split(".");
  if (labels.length < 2) return "HOST_NOT_PUBLIC";
  if (!labels.every((label) => LABEL.test(label))) return "HOST_INVALID";
  if (!TOP_LABEL.test(labels[labels.length - 1] as string)) return "HOST_INVALID";
  if (NON_PUBLIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return "HOST_NOT_PUBLIC";
  return null;
}

/** Port and security must be one of the two allowed pairs (993/TLS, 143/STARTTLS). */
export function imapTransportProblem(port: unknown, security: unknown): ImapEndpointProblem | null {
  if (security !== "TLS" && security !== "STARTTLS") return "SECURITY_INVALID";
  if (port !== IMAP_PORT_BY_SECURITY[security]) return "PORT_NOT_ALLOWED";
  return null;
}

export function imapEndpointProblem(endpoint: { host: unknown; port: unknown; security: unknown }): ImapEndpointProblem | null {
  return imapHostProblem(endpoint.host) ?? imapTransportProblem(endpoint.port, endpoint.security);
}

/** User input -> canonical host (trimmed, lower-case, no trailing dot). Validate the result with imapHostProblem. */
export function normalizeImapHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}
