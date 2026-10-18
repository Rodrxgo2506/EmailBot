import { connect as netConnect, createServer, isIP, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeImapConnectionOptions,
  createPinnedLookup,
  ImapDestinationError,
  imapConnectionOptions,
  isPublicIpAddress,
  resolveImapDestination,
  type ImapResolver,
  type ResolvedAddress
} from "./imap-destination.js";

/*
 * SSRF guard for IMAP servers. Every resolver here is a fake: no test opens a
 * socket or sends a DNS query.
 */

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
const TLS = { host: "imap.example-mail.com", port: 993, security: "TLS" as const };

const resolver = (...addresses: string[]): ImapResolver =>
  vi.fn(async () => addresses.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 })));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImapDestinationError);
    return (error as ImapDestinationError).code;
  }
  throw new Error("expected a refusal");
}

describe("isPublicIpAddress (net.BlockList, IANA special-purpose registries)", () => {
  it.each([PUBLIC_V4, "8.8.8.8", "1.1.1.1", PUBLIC_V6, "2001:4860:4860::8888", "2a00:1450:4001:80b::200e"])("public: %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback (other)", "127.255.255.254"],
    ["this network", "0.0.0.0"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.31.255.1"],
    ["private 192.168/16", "192.168.1.10"],
    ["link-local", "169.254.10.20"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["CGNAT (end)", "100.127.255.254"],
    ["IETF assignments", "192.0.0.8"],
    ["documentation", "192.0.2.1"],
    ["documentation 2", "198.51.100.7"],
    ["documentation 3", "203.0.113.9"],
    ["benchmarking", "198.18.0.1"],
    ["6to4 relay", "192.88.99.1"],
    ["multicast", "224.0.0.251"],
    ["multicast (end)", "239.255.255.250"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 link-local with zone", "fe80::1%eth0"],
    ["IPv6 ULA", "fd12:3456:789a::1"],
    ["IPv6 ULA fc00", "fc00::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata (hex)", "::ffff:a9fe:a9fe"],
    ["IPv4-mapped public (refused: never a real IMAP answer)", "::ffff:8.8.8.8"],
    ["IPv4-compatible", "::7f00:1"],
    ["NAT64 embedding a private IPv4", "64:ff9b::a00:1"],
    ["NAT64 local-use", "64:ff9b:1::1"],
    ["6to4 embedding a private IPv4", "2002:a00:1::1"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["IPv6 documentation", "2001:db8::1"],
    ["IPv6 documentation (RFC 9637)", "3fff::1"],
    ["discard-only", "100::1"],
    ["not an address", "imap.example.com"],
    ["empty", ""],
    ["shortened IPv4", "127.1"]
  ])("forbidden: %s (%s)", (_label, address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });
});

describe("resolveImapDestination", () => {
  it("public DNS name with public A and AAAA records: allowed and frozen", async () => {
    const destination = await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4, PUBLIC_V6) });
    expect(destination).toEqual({ ...TLS, addresses: [{ address: PUBLIC_V4, family: 4 }, { address: PUBLIC_V6, family: 6 }] });
    expect(Object.isFrozen(destination)).toBe(true);
    expect(Object.isFrozen(destination.addresses)).toBe(true);
  });

  it("STARTTLS on 143 is allowed", async () => {
    const destination = await resolveImapDestination({ host: "mail.example-host.net", port: 143, security: "STARTTLS" }, { resolver: resolver(PUBLIC_V4) });
    expect(destination.port).toBe(143);
  });

  it("a private IPv4 answer is refused", async () => {
    expect(await refusal(resolveImapDestination(TLS, { resolver: resolver("10.0.0.5") }))).toBe("IMAP_ADDRESS_FORBIDDEN");
  });

  it("a forbidden IPv6 answer is refused", async () => {
    expect(await refusal(resolveImapDestination(TLS, { resolver: resolver("fd00::25") }))).toBe("IMAP_ADDRESS_FORBIDDEN");
  });

  it("mixed answers: ONE forbidden address refuses the whole destination", async () => {
    expect(await refusal(resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4, "169.254.169.254") }))).toBe("IMAP_ADDRESS_FORBIDDEN");
    expect(await refusal(resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V6, "::ffff:127.0.0.1", PUBLIC_V4) }))).toBe("IMAP_ADDRESS_FORBIDDEN");
  });

  it.each(["127.0.0.1", "169.254.169.254", "100.64.12.1", "224.0.0.1", "::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::7f00:1"])(
    "loopback / link-local / metadata / CGNAT / multicast / embedded IPv4 answers are refused: %s",
    async (address) => {
      expect(await refusal(resolveImapDestination(TLS, { resolver: resolver(address) }))).toBe("IMAP_ADDRESS_FORBIDDEN");
    }
  );

  it("an answer whose family does not match its address is refused", async () => {
    const lying: ImapResolver = async () => [{ address: "127.0.0.1", family: 6 }];
    expect(await refusal(resolveImapDestination(TLS, { resolver: lying }))).toBe("IMAP_ADDRESS_FORBIDDEN");
    const garbage: ImapResolver = async () => [{ address: "not-an-ip", family: 4 }];
    expect(await refusal(resolveImapDestination(TLS, { resolver: garbage }))).toBe("IMAP_ADDRESS_FORBIDDEN");
  });

  it("no answer, an error or a timeout: refused (fail closed)", async () => {
    expect(await refusal(resolveImapDestination(TLS, { resolver: resolver() }))).toBe("IMAP_DNS_NO_ADDRESSES");
    const failing: ImapResolver = async () => {
      throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await refusal(resolveImapDestination(TLS, { resolver: failing }))).toBe("IMAP_DNS_FAILED");
    const hanging: ImapResolver = () => new Promise(() => undefined);
    expect(await refusal(resolveImapDestination(TLS, { resolver: hanging, timeoutMs: 10 }))).toBe("IMAP_DNS_FAILED");
    const notAList = (async () => null) as unknown as ImapResolver;
    expect(await refusal(resolveImapDestination(TLS, { resolver: notAList }))).toBe("IMAP_DNS_NO_ADDRESSES");
  });

  it.each([
    ["localhost", "IMAP_HOST_FORBIDDEN"],
    ["mail", "IMAP_HOST_FORBIDDEN"],
    ["imap.localhost", "IMAP_HOST_FORBIDDEN"],
    ["mail.internal", "IMAP_HOST_FORBIDDEN"],
    ["printer.local", "IMAP_HOST_FORBIDDEN"],
    ["router.home.arpa", "IMAP_HOST_FORBIDDEN"],
    ["1.0.0.127.in-addr.arpa", "IMAP_HOST_FORBIDDEN"],
    ["red-abc123", "IMAP_HOST_FORBIDDEN"],
    ["127.0.0.1", "IMAP_HOST_FORBIDDEN"],
    ["127.1", "IMAP_HOST_FORBIDDEN"],
    ["0x7f.0.0.1", "IMAP_HOST_FORBIDDEN"],
    ["2130706433", "IMAP_HOST_FORBIDDEN"],
    ["::1", "IMAP_HOST_FORBIDDEN"],
    ["[::1]", "IMAP_HOST_FORBIDDEN"],
    ["", "IMAP_HOST_INVALID"],
    ["IMAP.Example.com", "IMAP_HOST_INVALID"],
    ["imap.example.com.", "IMAP_HOST_INVALID"],
    ["imap..example.com", "IMAP_HOST_INVALID"],
    ["-imap.example.com", "IMAP_HOST_INVALID"],
    ["imap_server.example.com", "IMAP_HOST_INVALID"],
    ["imap.example.123", "IMAP_HOST_INVALID"],
    ["imap.example.com/x", "IMAP_HOST_INVALID"],
    ["user@imap.example.com", "IMAP_HOST_INVALID"],
    ["imap.exämple.com", "IMAP_HOST_INVALID"],
    ["imap.ex​ample.com", "IMAP_HOST_INVALID"],
    ["imap.xn--zz.com", "IMAP_HOST_INVALID"],
    [`${"a".repeat(250)}.com`, "IMAP_HOST_INVALID"]
  ])("host %j is refused before any DNS query (%s)", async (host, code) => {
    const spy = resolver(PUBLIC_V4);
    expect(await refusal(resolveImapDestination({ ...TLS, host }, { resolver: spy }))).toBe(code);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a valid IDNA A-label is accepted (Unicode names must be given in that form)", async () => {
    const destination = await resolveImapDestination({ ...TLS, host: "imap.xn--mnchen-3ya.de" }, { resolver: resolver(PUBLIC_V4) });
    expect(destination.host).toBe("imap.xn--mnchen-3ya.de");
  });

  it.each([
    [993, "STARTTLS"],
    [143, "TLS"],
    [995, "TLS"],
    [587, "STARTTLS"],
    [25, "STARTTLS"],
    [6379, "TLS"],
    [0, "TLS"],
    [993, "NONE"],
    [143, "PLAIN"],
    [993, undefined]
  ])("port %s with %s is refused", async (port, security) => {
    const spy = resolver(PUBLIC_V4);
    const endpoint = { host: TLS.host, port, security } as unknown as typeof TLS;
    expect(await refusal(resolveImapDestination(endpoint, { resolver: spy }))).toBe("IMAP_PORT_NOT_ALLOWED");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("pinned connection (DNS rebinding)", () => {
  type Callback = (error: Error | null, address?: unknown, family?: number) => void;
  const lookupOnce = (lookup: ReturnType<typeof createPinnedLookup>, hostname: string, options: object) =>
    new Promise<{ error: Error | null; address?: unknown; family?: number | undefined }>((resolve) => {
      (lookup as unknown as (h: string, o: object, c: Callback) => void)(hostname, options, (error, address, family) => resolve({ error, address, family }));
    });

  it("a DNS answer that changes after validation never reaches the socket", async () => {
    let calls = 0;
    // First answer public, every later answer the metadata service: the classic rebinding.
    const rebinding: ImapResolver = vi.fn(async () => {
      calls += 1;
      return [{ address: calls === 1 ? PUBLIC_V4 : "169.254.169.254", family: 4 as const }];
    });
    const destination = await resolveImapDestination(TLS, { resolver: rebinding });
    const { lookup, host } = imapConnectionOptions(destination);
    // The socket target is the address validated on the first answer, as a literal.
    expect(host).toBe(PUBLIC_V4);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await lookupOnce(lookup, TLS.host, {})).toEqual({ error: null, address: PUBLIC_V4, family: 4 });
      expect(await lookupOnce(lookup, TLS.host, { all: true })).toEqual({ error: null, address: [{ address: PUBLIC_V4, family: 4 }], family: undefined });
    }
    expect(rebinding).toHaveBeenCalledTimes(1);
    // Re-validating (what the worker does before each connection) sees the new answer and refuses it.
    expect(await refusal(resolveImapDestination(TLS, { resolver: rebinding }))).toBe("IMAP_ADDRESS_FORBIDDEN");
  });

  it("the pinned lookup answers only for its own name and the requested family", async () => {
    const destination = await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4, PUBLIC_V6) });
    const lookup = createPinnedLookup(destination);
    expect((await lookupOnce(lookup, "evil.example.org", {})).error).toMatchObject({ code: "ENOTFOUND" });
    expect((await lookupOnce(lookup, "169.254.169.254", {})).error).toMatchObject({ code: "ENOTFOUND" });
    expect(await lookupOnce(lookup, TLS.host, { family: 6 })).toEqual({ error: null, address: PUBLIC_V6, family: 6 });
    expect(await lookupOnce(lookup, TLS.host, { family: "IPv4" })).toEqual({ error: null, address: PUBLIC_V4, family: 4 });
    expect(await lookupOnce(lookup, TLS.host, 4 as unknown as object)).toEqual({ error: null, address: PUBLIC_V4, family: 4 });
    // A validated IP literal maps to itself only; any other literal fails.
    expect(await lookupOnce(lookup, PUBLIC_V6, {})).toEqual({ error: null, address: PUBLIC_V6, family: 6 });
    expect((await lookupOnce(lookup, "8.8.8.8", {})).error).toMatchObject({ code: "ENOTFOUND" });
  });

  it("an IPv4-only destination refuses an IPv6 lookup instead of resolving again", async () => {
    const destination = await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4) });
    const lookup = createPinnedLookup(destination);
    expect((await lookupOnce(lookup, TLS.host, { family: 6 })).error).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("connection options: TLS cannot be weakened", () => {
  it("993: implicit TLS to the validated IP, certificate validation on, SNI = the DNS name, TLS >= 1.2, pinned lookup, no proxy", async () => {
    const options = imapConnectionOptions(await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4) }));
    expect(options).toMatchObject({
      host: PUBLIC_V4,
      port: 993,
      secure: true,
      doSTARTTLS: undefined,
      servername: TLS.host,
      tls: { servername: TLS.host, rejectUnauthorized: true, minVersion: "TLSv1.2" }
    });
    expect(options.proxy).toBeUndefined();
    expect(options.tls.lookup).toBe(options.lookup);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.tls)).toBe(true);
  });

  it("143: STARTTLS is mandatory (no downgrade to plaintext)", async () => {
    const options = imapConnectionOptions(await resolveImapDestination({ host: TLS.host, port: 143, security: "STARTTLS" }, { resolver: resolver(PUBLIC_V4) }));
    expect(options).toMatchObject({
      host: PUBLIC_V4,
      port: 143,
      secure: false,
      doSTARTTLS: true,
      servername: TLS.host,
      // The upgrade validates the certificate against the DNS name too.
      tls: { servername: TLS.host, rejectUnauthorized: true, minVersion: "TLSv1.2" }
    });
  });

  it("the frozen options cannot be modified in place", async () => {
    const options = imapConnectionOptions(await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4) }));
    expect(() => {
      (options.tls as { rejectUnauthorized: boolean }).rejectUnauthorized = false;
    }).toThrow(TypeError);
    expect(options.tls.rejectUnauthorized).toBe(true);
  });

  it("any override that weakens the connection is refused", async () => {
    const safe = imapConnectionOptions(await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4) }));
    const unsafe: Array<Record<string, unknown>> = [
      { ...safe, tls: { ...safe.tls, rejectUnauthorized: false } },
      { ...safe, tls: { ...safe.tls, rejectUnauthorized: undefined } },
      { ...safe, tls: undefined },
      { ...safe, tls: { ...safe.tls, minVersion: "TLSv1" } },
      { ...safe, tls: { ...safe.tls, servername: "other.example.com" } },
      { ...safe, tls: { ...safe.tls, checkServerIdentity: () => undefined } },
      { ...safe, tls: { ...safe.tls, ca: "-----BEGIN CERTIFICATE-----" } },
      { ...safe, tls: { ...safe.tls, lookup: undefined } },
      { ...safe, lookup: undefined },
      { ...safe, proxy: "socks5://127.0.0.1:1080" },
      { ...safe, secure: false },
      { ...safe, secure: false, port: 143 },
      { ...safe, secure: undefined },
      { ...safe, port: 143 },
      { ...safe, doSTARTTLS: false },
      // M1: the socket must target a validated public IP literal, never a name that would be resolved again.
      { ...safe, host: TLS.host },
      { ...safe, host: "10.0.0.5" },
      { ...safe, host: "127.0.0.1" },
      { ...safe, host: "169.254.169.254" },
      { ...safe, host: "::ffff:127.0.0.1" },
      { ...safe, host: undefined },
      // ...and TLS must check the certificate against the public DNS name.
      { ...safe, servername: PUBLIC_V4, tls: { ...safe.tls, servername: PUBLIC_V4 } },
      { ...safe, servername: "mail.internal", tls: { ...safe.tls, servername: "mail.internal" } },
      { ...safe, servername: undefined },
      { ...safe, servername: "other.example.com" }
    ];
    for (const options of unsafe) {
      expect(() => assertSafeImapConnectionOptions(options), JSON.stringify(Object.keys(options))).toThrow(ImapDestinationError);
    }
    expect(() => assertSafeImapConnectionOptions({ ...safe })).not.toThrow();
  });

  it("errors never contain the resolved addresses", async () => {
    try {
      await resolveImapDestination(TLS, { resolver: resolver("10.9.8.7") });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("10.9.8.7");
    }
  });
});

describe("M1: the socket goes to a validated IP literal, TLS checks the DNS name", () => {
  it("host is exactly one of the validated addresses (default: the first); another one can be chosen explicitly", async () => {
    const destination = await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4, PUBLIC_V6) });
    const first = imapConnectionOptions(destination);
    expect(first.host).toBe(PUBLIC_V4);
    expect(isIP(first.host)).toBe(4);
    expect(destination.addresses.map((address) => address.address)).toContain(first.host);
    const v6 = imapConnectionOptions(destination, PUBLIC_V6);
    expect(v6).toMatchObject({ host: PUBLIC_V6, servername: TLS.host, tls: { servername: TLS.host } });
    expect(isIP(v6.host)).toBe(6);
  });

  it("an address that was not validated for this destination is refused", async () => {
    const destination = await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4) });
    for (const address of ["8.8.8.8", "10.0.0.1", "127.0.0.1", TLS.host, ""]) {
      expect(() => imapConnectionOptions(destination, address), address).toThrow(ImapDestinationError);
    }
  });

  it.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1"])(
    "a hand-built destination cannot smuggle %s into the final options",
    (address) => {
      const forged = { ...TLS, addresses: [{ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }] };
      expect(() => imapConnectionOptions(forged)).toThrow(ImapDestinationError);
    }
  );

  it("an empty or inconsistent hand-built destination is refused", () => {
    expect(() => imapConnectionOptions({ ...TLS, addresses: [] })).toThrow(ImapDestinationError);
    expect(() => imapConnectionOptions({ ...TLS, addresses: [{ address: PUBLIC_V4, family: 6 }] })).toThrow(ImapDestinationError);
  });

  it("mixed or failing DNS answers never produce connection options", async () => {
    await expect(resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4, "10.0.0.1") }).then(imapConnectionOptions)).rejects.toMatchObject({
      code: "IMAP_ADDRESS_FORBIDDEN"
    });
    const failing: ImapResolver = async () => Promise.reject(new Error("SERVFAIL"));
    await expect(resolveImapDestination(TLS, { resolver: failing }).then(imapConnectionOptions)).rejects.toMatchObject({ code: "IMAP_DNS_FAILED" });
  });

  it("building the options does not query DNS again", async () => {
    const spy = resolver(PUBLIC_V4);
    const destination = await resolveImapDestination(TLS, { resolver: spy });
    imapConnectionOptions(destination);
    imapConnectionOptions(destination, PUBLIC_V4);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("certificate checks are left to TLS with the DNS name: validation on, no custom CA or identity check", async () => {
    const { tls, servername } = imapConnectionOptions(await resolveImapDestination(TLS, { resolver: resolver(PUBLIC_V4) }));
    expect(servername).toBe(TLS.host);
    expect(tls.servername).toBe(TLS.host);
    expect(tls.rejectUnauthorized).toBe(true);
    expect(Object.keys(tls).sort()).toEqual(["lookup", "minVersion", "rejectUnauthorized", "servername"]);
  });

  /*
   * Node mechanism the design relies on (local loopback only, no external
   * network): a socket whose host is an IP literal is connected WITHOUT
   * calling the lookup function; a host name goes through it. So the
   * options' IP literal host means no DNS query at connect time.
   */
  it("Node does not resolve an IP literal host (the lookup is never called); a name is resolved", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const connectWith = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const lookup = vi.fn((_hostname: string, _options: unknown, callback: (error: Error | null, address: unknown, family?: number) => void) => {
          const settings = _options as { all?: boolean };
          if (settings.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        });
        const socket = netConnect({ host, port, lookup: lookup as never }, () => {
          socket.destroy();
          resolve(lookup.mock.calls.length);
        });
        socket.on("error", reject);
      });
    try {
      expect(await connectWith("127.0.0.1")).toBe(0);
      expect(await connectWith("localhost")).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
