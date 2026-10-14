import { BlockList, isIP, type LookupFunction } from "node:net";
import { promises as dns } from "node:dns";
import { domainToASCII } from "node:url";
import {
  IMAP_PORT_BY_SECURITY,
  imapEndpointProblem,
  imapHostProblem,
  type ImapEndpoint,
  type ImapEndpointProblem,
  type ImapSecurity
} from "@emailbot/types";

/*
 * SSRF guard for user-supplied IMAP servers (API: "test connection" / save;
 * worker: every connection). Fails closed: a destination that cannot be fully
 * verified is refused.
 *
 *   1. syntax (@emailbot/types imapEndpointProblem): a public-looking FQDN, no
 *      IP literal, no internal suffix, and only 993/TLS or 143/STARTTLS;
 *   2. every A / AAAA record is resolved; ALL must be globally routable
 *      (net.BlockList, IANA special-purpose registries). One forbidden address
 *      refuses the whole destination (no "pick the good one");
 *   3. imapConnectionOptions connects to a VALIDATED IP LITERAL (host) and
 *      keeps the original name only as the TLS servername (SNI + certificate
 *      validation; ImapFlow documents `servername` for "host is an IP
 *      address"). Node never resolves an IP literal, so no second DNS query
 *      happens at connect time and a DNS rebinding between validation and
 *      connection has no effect, whatever the IMAP library does with DNS
 *      options. createPinnedLookup stays as defense in depth (it answers only
 *      with the validated addresses);
 *   4. the options are the only connection settings allowed: certificate
 *      validation always on, TLS >= 1.2, STARTTLS mandatory on 143, no proxy.
 *      assertSafeImapConnectionOptions refuses any override.
 */

export type ImapDestinationErrorCode =
  | "IMAP_HOST_INVALID"
  | "IMAP_HOST_FORBIDDEN"
  | "IMAP_PORT_NOT_ALLOWED"
  | "IMAP_DNS_NO_ADDRESSES"
  | "IMAP_DNS_FAILED"
  | "IMAP_ADDRESS_FORBIDDEN"
  | "IMAP_UNSAFE_OPTIONS";

/** The destination is refused. The message never contains resolved addresses or credentials. */
export class ImapDestinationError extends Error {
  constructor(
    readonly code: ImapDestinationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ImapDestinationError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves every A / AAAA record of a name. Injected in tests (no network). */
export type ImapResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Validated destination. Frozen: the addresses cannot be changed after the check. */
export interface ImapDestination {
  readonly host: string;
  readonly port: number;
  readonly security: ImapSecurity;
  readonly addresses: readonly ResolvedAddress[];
}

/* ---------------------------------------------------------------- *
 * Address classification
 * ---------------------------------------------------------------- */

/** IPv4 ranges that are not globally reachable (IANA IPv4 Special-Purpose Address Registry + multicast / reserved). */
const FORBIDDEN_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation (TEST-NET-1)
  ["192.31.196.0", 24], // AS112-v4
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // direct delegation AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation (TEST-NET-2)
  ["203.0.113.0", 24], // documentation (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4] // reserved + limited broadcast
];

/**
 * IPv6 is an allow-list: only global unicast (2000::/3). That alone excludes
 * loopback, unspecified, IPv4-mapped / -compatible (::/96, ::ffff:0:0/96),
 * NAT64 (64:ff9b::/96, 64:ff9b:1::/48), discard (100::/64), ULA (fc00::/7),
 * link-local (fe80::/10) and multicast (ff00::/8). Inside 2000::/3 the
 * non-global blocks are refused too, including the ones that embed an IPv4
 * address (6to4 2002::/16, Teredo 2001::/32 inside 2001::/23).
 */
const GLOBAL_IPV6: Array<[string, number]> = [["2000::", 3]];
const FORBIDDEN_IPV6: Array<[string, number]> = [
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID...)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["3fff::", 20] // documentation (RFC 9637)
];

function blockList(entries: Array<[string, number]>, family: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of entries) list.addSubnet(network, prefix, family);
  return list;
}

const forbiddenIpv4 = blockList(FORBIDDEN_IPV4, "ipv4");
const globalIpv6 = blockList(GLOBAL_IPV6, "ipv6");
const forbiddenIpv6 = blockList(FORBIDDEN_IPV6, "ipv6");

/** True only for a globally routable unicast address. Anything unparsable is false. */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !forbiddenIpv4.check(address, "ipv4");
  if (family === 6) {
    // Zone ids ("fe80::1%eth0") are local by definition.
    if (address.includes("%")) return false;
    return globalIpv6.check(address, "ipv6") && !forbiddenIpv6.check(address, "ipv6");
  }
  return false;
}

/* ---------------------------------------------------------------- *
 * Resolution
 * ---------------------------------------------------------------- */

/** Default resolver: the system resolver (same as the socket would use), every address, as returned. */
export const systemImapResolver: ImapResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

export const IMAP_DNS_TIMEOUT_MS = 5000;

function problemToError(problem: ImapEndpointProblem): ImapDestinationError {
  switch (problem) {
    case "PORT_NOT_ALLOWED":
    case "SECURITY_INVALID":
      return new ImapDestinationError("IMAP_PORT_NOT_ALLOWED", "Only port 993 with TLS or port 143 with STARTTLS is allowed");
    case "HOST_NOT_PUBLIC":
    case "HOST_IP_LITERAL":
      return new ImapDestinationError("IMAP_HOST_FORBIDDEN", "The IMAP server must be a public DNS name");
    default:
      return new ImapDestinationError("IMAP_HOST_INVALID", "The IMAP server name is not valid");
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS resolution timed out")), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validates an IMAP endpoint and resolves it. Throws ImapDestinationError on
 * any problem (syntax, port, DNS failure, no address, one forbidden address).
 */
export async function resolveImapDestination(
  endpoint: ImapEndpoint,
  options: { resolver?: ImapResolver; timeoutMs?: number } = {}
): Promise<ImapDestination> {
  const problem = imapEndpointProblem(endpoint);
  if (problem) throw problemToError(problem);
  // A-labels must be valid IDNA (an invalid "xn--" label maps to "").
  if (domainToASCII(endpoint.host) !== endpoint.host) throw new ImapDestinationError("IMAP_HOST_INVALID", "The IMAP server name is not valid");

  let records: ResolvedAddress[];
  try {
    records = await withTimeout((options.resolver ?? systemImapResolver)(endpoint.host), options.timeoutMs ?? IMAP_DNS_TIMEOUT_MS);
  } catch {
    throw new ImapDestinationError("IMAP_DNS_FAILED", "The IMAP server name could not be resolved");
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new ImapDestinationError("IMAP_DNS_NO_ADDRESSES", "The IMAP server name has no address");
  }

  const addresses: ResolvedAddress[] = [];
  for (const record of records) {
    const family = isIP(record?.address ?? "");
    if (family === 0 || family !== record.family || !isPublicIpAddress(record.address)) {
      throw new ImapDestinationError("IMAP_ADDRESS_FORBIDDEN", "The IMAP server resolves to an address that is not allowed");
    }
    if (!addresses.some((known) => known.address === record.address)) addresses.push({ address: record.address, family });
  }

  return Object.freeze({
    host: endpoint.host,
    port: endpoint.port,
    security: endpoint.security,
    addresses: Object.freeze(addresses.map((address) => Object.freeze(address)))
  });
}

/* ---------------------------------------------------------------- *
 * Connection
 * ---------------------------------------------------------------- */

/**
 * Defense in depth: a net/tls `lookup` that answers ONLY with the validated
 * addresses, for the destination's own name or one of those IP literals; any
 * other name fails. It never queries DNS. (With an IP literal as host Node
 * does not call it at all; it only matters if a library resolved by itself.)
 */
export function createPinnedLookup(destination: ImapDestination): LookupFunction {
  const pinned = destination.addresses.map((address) => ({ address: address.address, family: address.family }));
  return ((hostname: string, options: { all?: boolean; family?: number | string } | number, callback: (...args: unknown[]) => void) => {
    const settings = typeof options === "object" && options !== null ? options : { family: options };
    const family = settings.family === "IPv4" ? 4 : settings.family === "IPv6" ? 6 : Number(settings.family ?? 0);
    const literal = pinned.find((address) => address.address === hostname);
    const candidates = (literal ? [literal] : pinned).filter((address) => family === 0 || address.family === family);
    if ((hostname !== destination.host && !literal) || candidates.length === 0) {
      const error = Object.assign(new Error("IMAP destination is pinned to its validated addresses"), { code: "ENOTFOUND" });
      process.nextTick(() => callback(error));
      return;
    }
    if (settings.all) process.nextTick(() => callback(null, candidates));
    else process.nextTick(() => callback(null, candidates[0]?.address, candidates[0]?.family));
  }) as LookupFunction;
}

export const IMAP_MIN_TLS_VERSION = "TLSv1.2";

/** Connection settings for an IMAP client (ImapFlow option names). Built only by imapConnectionOptions. */
export interface ImapConnectionOptions {
  /** A validated, globally routable IP literal (never the DNS name: nothing is resolved at connect time). */
  readonly host: string;
  readonly port: number;
  /** true: implicit TLS (993). false: plain TCP upgraded with STARTTLS (143). */
  readonly secure: boolean;
  /** Always true on 143: the connection fails if the server does not offer STARTTLS (no downgrade). */
  readonly doSTARTTLS: boolean | undefined;
  /** The original DNS name: SNI and certificate validation (ImapFlow: "Servername for SNI (or when host is set to an IP address)"). */
  readonly servername: string;
  /** Node TLS options; servername repeated so it also applies to the STARTTLS upgrade. */
  readonly tls: {
    readonly servername: string;
    readonly rejectUnauthorized: true;
    readonly minVersion: typeof IMAP_MIN_TLS_VERSION;
    readonly lookup: LookupFunction;
  };
  /** Defense in depth only (Node does not call it for an IP literal host). */
  readonly lookup: LookupFunction;
  readonly proxy?: undefined;
}

/**
 * The only way to obtain connection settings: from a validated destination,
 * for one of ITS validated addresses (default: the first; a caller may try the
 * next ones after a connection failure), certificate checks always on.
 */
export function imapConnectionOptions(destination: ImapDestination, address: string | undefined = destination.addresses[0]?.address): ImapConnectionOptions {
  if (IMAP_PORT_BY_SECURITY[destination.security] !== destination.port) throw problemToError("PORT_NOT_ALLOWED");
  const chosen = destination.addresses.find((candidate) => candidate.address === address);
  // Only an address that passed resolveImapDestination, re-checked (a hand-built destination cannot smuggle one in).
  if (!chosen || isIP(chosen.address) !== chosen.family || !isPublicIpAddress(chosen.address)) {
    throw new ImapDestinationError("IMAP_ADDRESS_FORBIDDEN", "The IMAP connection address was not validated");
  }
  const lookup = createPinnedLookup(destination);
  const options: ImapConnectionOptions = {
    host: chosen.address,
    port: destination.port,
    secure: destination.security === "TLS",
    doSTARTTLS: destination.security === "STARTTLS" ? true : undefined,
    servername: destination.host,
    tls: Object.freeze({ servername: destination.host, rejectUnauthorized: true, minVersion: IMAP_MIN_TLS_VERSION, lookup }),
    lookup
  };
  assertSafeImapConnectionOptions(options);
  return Object.freeze(options);
}

/**
 * Last check before connecting (also for options assembled by hand): refuses
 * a host that is not a public IP literal, a servername that is not a public
 * DNS name, disabled certificate validation, a proxy, plaintext, an unpinned
 * lookup or a port / security mismatch.
 */
export function assertSafeImapConnectionOptions(candidate: ImapConnectionOptions | Record<string, unknown>): void {
  const unsafe = (reason: string) => new ImapDestinationError("IMAP_UNSAFE_OPTIONS", `Unsafe IMAP connection options: ${reason}`);
  const options = candidate as Record<string, unknown>;
  const tls = (typeof options.tls === "object" && options.tls !== null ? options.tls : undefined) as Record<string, unknown> | undefined;
  if (!tls || tls.rejectUnauthorized !== true) throw unsafe("certificate validation must stay enabled");
  // The socket goes to an IP literal (no DNS at connect time); TLS checks the certificate against the original name.
  if (typeof options.host !== "string" || isIP(options.host) === 0 || !isPublicIpAddress(options.host)) throw unsafe("host must be a validated public IP address");
  if (typeof options.servername !== "string" || isIP(options.servername) !== 0 || imapHostProblem(options.servername) !== null) {
    throw unsafe("servername must be the public DNS name of the server");
  }
  if (tls.servername !== options.servername) throw unsafe("the TLS servername must be the server's DNS name");
  if (tls.minVersion !== IMAP_MIN_TLS_VERSION) throw unsafe("TLS 1.2 or later is required");
  if (typeof tls.lookup !== "function" || typeof options.lookup !== "function") throw unsafe("the lookup must be pinned");
  if (options.proxy !== undefined) throw unsafe("proxies are not allowed");
  if ("checkServerIdentity" in tls || "ca" in tls || "insecureHTTPParser" in options) throw unsafe("custom certificate checks are not allowed");
  if (options.secure === true) {
    if (options.port !== IMAP_PORT_BY_SECURITY.TLS || options.doSTARTTLS !== undefined) throw unsafe("TLS is only allowed on port 993");
  } else if (options.secure === false) {
    if (options.port !== IMAP_PORT_BY_SECURITY.STARTTLS || options.doSTARTTLS !== true) throw unsafe("port 143 requires mandatory STARTTLS");
  } else {
    throw unsafe("the transport mode is missing");
  }
}
