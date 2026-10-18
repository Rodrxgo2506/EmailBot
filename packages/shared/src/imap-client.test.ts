import { describe, expect, it, vi } from "vitest";
import {
  classifyImapFailure,
  createImapConnector,
  IMAP_MAX_ADDRESS_ATTEMPTS,
  ImapTransportError,
  probeImapInbox,
  type ImapProbeClient,
  type ImapProbeOpen
} from "./imap-client.js";
import { parseImapCursor } from "./imap-cursor.js";
import { ImapDestinationError, type ImapConnectionOptions, type ImapResolver } from "./imap-destination.js";

/*
 * Shared IMAP transport (E3), unit level: fake resolver and fake ImapFlow
 * client, no network. Real TLS / STARTTLS against Dovecot: the opt-in
 * integration suites (worker and API).
 */

const endpoint = { host: "imap.example-mail.com", port: 993, security: "TLS" as const };
const login = { username: "ventas@empresa-correo.com", password: "app-password-123" };
const resolverOf = (...addresses: string[]): ImapResolver =>
  vi.fn(async () => addresses.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 })));

interface FakeClient extends ImapProbeClient {
  closed: number;
  loggedOut: boolean;
  examined: Array<{ path: string; options: unknown }>;
}

function fakeClient(mailbox: Record<string, unknown> | null = { path: "INBOX", readOnly: true, uidValidity: 1234n, uidNext: 57 }, examineError?: unknown): FakeClient {
  const client = {
    closed: 0,
    loggedOut: false,
    examined: [] as Array<{ path: string; options: unknown }>,
    mailbox: false as unknown,
    async getMailboxLock(path: string, options: unknown) {
      client.examined.push({ path, options });
      if (examineError) throw examineError;
      client.mailbox = mailbox ?? false;
      return { path, release: () => undefined };
    },
    logout: vi.fn(async () => {
      client.loggedOut = true;
    }),
    close: vi.fn(() => {
      client.closed += 1;
    })
  };
  return client as unknown as FakeClient;
}

/** open() that registers the client like openImapClient (onClient) and then connects or fails. */
const openWith = (client: FakeClient, failure?: unknown): ImapProbeOpen & ReturnType<typeof vi.fn> =>
  vi.fn(async (_options: ImapConnectionOptions, _login: unknown, onClient: (c: ImapProbeClient) => void) => {
    onClient(client);
    if (failure) throw failure;
    return client;
  }) as never;

describe("classifyImapFailure (neutral codes shared by the worker and the API)", () => {
  it.each([
    [{ authenticationFailed: true }, "AUTH", "IMAP_AUTH_FAILED"],
    [{ serverResponseCode: "AUTHENTICATIONFAILED" }, "AUTH", "IMAP_AUTH_FAILED"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "SECURITY", "IMAP_TLS_FAILED"],
    [{ tlsFailed: true, code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "SECURITY", "IMAP_TLS_FAILED"],
    [{ tlsFailed: true }, "SECURITY", "IMAP_STARTTLS_UNAVAILABLE"],
    [{ tlsFailed: true, code: "STARTTLS_INJECTION" }, "SECURITY", "IMAP_TLS_FAILED"],
    [{ tlsFailed: true, code: "ECONNRESET" }, "TRANSIENT", "IMAP_UNREACHABLE"],
    [{ tlsFailed: true, code: "UPGRADE_TIMEOUT" }, "TRANSIENT", "IMAP_TIMEOUT"],
    [{ code: "CONNECT_TIMEOUT" }, "TRANSIENT", "IMAP_TIMEOUT"],
    [{ code: "GREETING_TIMEOUT" }, "TRANSIENT", "IMAP_TIMEOUT"],
    [{ code: "ECONNREFUSED" }, "TRANSIENT", "IMAP_UNREACHABLE"],
    [{ serverResponseCode: "UNAVAILABLE" }, "TRANSIENT", "IMAP_UNREACHABLE"],
    [new Error("something new"), "TRANSIENT", "IMAP_FAILED"],
    [new ImapDestinationError("IMAP_DNS_FAILED", "x"), "TRANSIENT", "IMAP_DNS_FAILED"],
    [new ImapDestinationError("IMAP_ADDRESS_FORBIDDEN", "x"), "SECURITY", "IMAP_HOST_FORBIDDEN"]
  ])("%j -> %s %s", (error, kind, code) => {
    const failure = classifyImapFailure(error);
    expect([failure.kind, failure.code]).toEqual([kind, code]);
  });

  it("messages are fixed strings: never the server text, an address or a credential", () => {
    const failure = classifyImapFailure(Object.assign(new Error("NO [AUTHENTICATIONFAILED] user ventas@empresa-correo.com at 93.184.216.34"), { authenticationFailed: true }));
    expect(failure.message).toBe("The IMAP server refused the login");
    expect(failure.message).not.toMatch(/ventas|93\.184/);
  });
});

describe("createImapConnector (E1 checks before ImapFlow)", () => {
  it("dials the validated IP literal with the DNS name for SNI / certificate, verification on, no proxy", async () => {
    const open = vi.fn(async (_options: ImapConnectionOptions) => "client");
    await createImapConnector({ resolver: resolverOf("93.184.216.34"), open })(endpoint, login);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      host: "93.184.216.34",
      servername: "imap.example-mail.com",
      secure: true,
      tls: { servername: "imap.example-mail.com", rejectUnauthorized: true, minVersion: "TLSv1.2" }
    });
    expect((open.mock.calls[0]?.[0] as unknown as { proxy?: unknown }).proxy).toBeUndefined();
  });

  it("only an unreachable address moves on (at most IMAP_MAX_ADDRESS_ATTEMPTS); a TLS or login failure never does", async () => {
    const unreachable = vi.fn(async () => Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    const error = await createImapConnector({ resolver: resolverOf("93.184.216.34", "93.184.216.35", "93.184.216.36"), open: unreachable })(endpoint, login).catch((caught: unknown) => caught);
    expect((error as ImapTransportError).code).toBe("IMAP_UNREACHABLE");
    expect(unreachable).toHaveBeenCalledTimes(IMAP_MAX_ADDRESS_ATTEMPTS);

    for (const failure of [{ code: "CERT_HAS_EXPIRED" }, { authenticationFailed: true }]) {
      const open = vi.fn(async () => Promise.reject(failure));
      await expect(createImapConnector({ resolver: resolverOf("93.184.216.34", "93.184.216.35"), open })(endpoint, login)).rejects.toBeInstanceOf(ImapTransportError);
      expect(open).toHaveBeenCalledTimes(1);
    }
  });

  it("a forbidden answer is refused before any connection", async () => {
    const open = vi.fn(async () => "client");
    const error = await createImapConnector({ resolver: resolverOf("93.184.216.34", "10.0.0.8"), open })(endpoint, login).catch((caught: unknown) => caught);
    expect((error as ImapTransportError).code).toBe("IMAP_HOST_FORBIDDEN");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("probeImapInbox (connection test: EXAMINE INBOX, position, LOGOUT, everything closed)", () => {
  it("reads UIDVALIDITY / UIDNEXT with EXAMINE (read-only) and logs out: cursor = UIDNEXT - 1", async () => {
    const client = fakeClient();
    const position = await probeImapInbox(endpoint, login, { resolver: resolverOf("93.184.216.34"), open: openWith(client) });
    expect(position).toEqual({ uidValidity: 1234, uidNext: 57, cursor: "imap:v1:1234:56" });
    expect(parseImapCursor(position.cursor)).toEqual({ uidValidity: 1234, uid: 56 });
    expect(client.examined).toEqual([{ path: "INBOX", options: { readOnly: true } }]);
    expect(client.loggedOut).toBe(true);
    expect(client.closed).toBe(0);
  });

  it("an empty INBOX (UIDNEXT 1) gives cursor UID 0: the first message ever received is imported", async () => {
    const client = fakeClient({ path: "INBOX", readOnly: true, uidValidity: 7n, uidNext: 1 });
    expect((await probeImapInbox(endpoint, login, { resolver: resolverOf("93.184.216.34"), open: openWith(client) })).cursor).toBe("imap:v1:7:0");
  });

  it.each([
    ["a refused login", { authenticationFailed: true }, "IMAP_AUTH_FAILED"],
    ["an untrusted certificate", { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "IMAP_TLS_FAILED"],
    ["no STARTTLS", { tlsFailed: true }, "IMAP_STARTTLS_UNAVAILABLE"],
    ["a connection timeout", { code: "CONNECT_TIMEOUT" }, "IMAP_TIMEOUT"]
  ])("%s: classified, and the client is closed", async (_label, failure, code) => {
    const client = fakeClient();
    const error = await probeImapInbox(endpoint, login, { resolver: resolverOf("93.184.216.34"), open: openWith(client, failure) }).catch((caught: unknown) => caught);
    expect((error as ImapTransportError).code).toBe(code);
    expect(client.closed).toBeGreaterThan(0);
    expect(client.examined).toEqual([]);
  });

  it.each([
    ["EXAMINE answered NO", fakeClient(undefined, Object.assign(new Error("NO"), { responseStatus: "NO" }))],
    ["a [READ-WRITE] answer to EXAMINE", fakeClient({ path: "INBOX", readOnly: false, uidValidity: 1n, uidNext: 2 })],
    ["no UIDVALIDITY", fakeClient({ path: "INBOX", readOnly: true, uidNext: 2 })],
    ["no UIDNEXT", fakeClient({ path: "INBOX", readOnly: true, uidValidity: 9n })],
    ["UIDVALIDITY out of range", fakeClient({ path: "INBOX", readOnly: true, uidValidity: 2n ** 33n, uidNext: 2 })]
  ])("%s: IMAP_INBOX_UNAVAILABLE (fail closed, never a guessed cursor), client closed", async (_label, client) => {
    const error = await probeImapInbox(endpoint, login, { resolver: resolverOf("93.184.216.34"), open: openWith(client) }).catch((caught: unknown) => caught);
    expect((error as ImapTransportError).code).toBe("IMAP_INBOX_UNAVAILABLE");
    expect(client.closed).toBeGreaterThan(0);
  });

  it("the deadline closes a connection that never completes (forced close mid-handshake)", async () => {
    const client = fakeClient();
    const open: ImapProbeOpen = vi.fn((_options, _login, onClient) => {
      onClient(client);
      return new Promise<never>(() => undefined);
    });
    const started = Date.now();
    const error = await probeImapInbox(endpoint, login, { resolver: resolverOf("93.184.216.34"), open, deadlineMs: 50 }).catch((caught: unknown) => caught);
    expect((error as ImapTransportError).code).toBe("IMAP_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(client.closed).toBe(1);
  });

  it("a failed LOGOUT still returns the position and closes the client", async () => {
    const client = fakeClient();
    client.logout = vi.fn(async () => Promise.reject(new Error("socket closed")));
    const position = await probeImapInbox(endpoint, login, { resolver: resolverOf("93.184.216.34"), open: openWith(client) });
    expect(position.cursor).toBe("imap:v1:1234:56");
    expect(client.closed).toBe(1);
  });

  it("DNS rebinding: a forbidden answer at connection time is refused, nothing is dialled", async () => {
    const client = fakeClient();
    const open = openWith(client);
    const error = await probeImapInbox(endpoint, login, { resolver: resolverOf("169.254.169.254"), open }).catch((caught: unknown) => caught);
    expect((error as ImapTransportError).code).toBe("IMAP_HOST_FORBIDDEN");
    expect(open).not.toHaveBeenCalled();
  });
});
