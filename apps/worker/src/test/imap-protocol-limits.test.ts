import net, { type LookupFunction } from "node:net";
import { IMAP_PROTOCOL_LIMITS, type ImapConnectionOptions } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAccountFailure, NonRetryableError } from "../pipeline/failures.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { IMAP_MAX_MESSAGE_BYTES } from "../providers/imap/normalize.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { ProviderSecurityError, type ProviderContext } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeRealtime } from "./fakes.js";

/*
 * E6.1 (A1) in the worker: the real adapter and the worker's openImapClient
 * (synchronization profile) against a scripted IMAP server on 127.0.0.1 (no
 * external network, no TLS: test-only options; production connections go through
 * the shared connector and its E1 checks). Oversized literals are only ANNOUNCED:
 * ImapFlow refuses them at their "{size}" marker, so nothing big is allocated.
 */

const KiB = 1024;
const HOST = "imap.example-mail.com";
const LOGIN = { username: "ventas@empresa-correo.com", password: "app-password-123" };
const CONTENT_MARKER = "CONFIDENTIAL-MAIL-BODY-7f3a";

const noLookup = (() => undefined) as unknown as LookupFunction;
const localOptions = (port: number): ImapConnectionOptions => ({
  host: "127.0.0.1",
  port,
  secure: false,
  doSTARTTLS: undefined,
  servername: HOST,
  tls: { servername: HOST, rejectUnauthorized: true, minVersion: "TLSv1.2", lookup: noLookup },
  lookup: noLookup
});

type FetchReply = (socket: net.Socket, tag: string) => void;

interface ScriptedServer {
  port: number;
  received(): string;
  openSockets(): number;
  allClosed(): Promise<void>;
  stop(): Promise<void>;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

/** Minimal IMAP server: greeting with capabilities, AUTHENTICATE / LOGIN, EXAMINE INBOX, scripted UID FETCH answers. */
async function startServer(fetch: { meta: FetchReply; source: FetchReply }): Promise<ScriptedServer> {
  let received = "";
  const sockets = new Set<net.Socket>();
  const closed: Array<Promise<void>> = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (data) => {
      received += data.toString("latin1");
      buffer += data.toString("latin1");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag = "*", command = ""] = line.split(" ");
        if (socket.destroyed) return;
        switch (command.toUpperCase()) {
          case "EXAMINE":
            socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 2] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
            break;
          case "UID":
            if (line.includes("BODY.PEEK[]")) fetch.source(socket, tag);
            else fetch.meta(socket, tag);
            break;
          case "LOGOUT":
            socket.write(`* BYE bye\r\n${tag} OK bye\r\n`);
            socket.end();
            break;
          default:
            // CAPABILITY, AUTHENTICATE, LIST, LSUB, NOOP...: accepted.
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handle: ScriptedServer = {
    port: (server.address() as net.AddressInfo).port,
    received: () => received,
    openSockets: () => sockets.size,
    allClosed: async () => {
      await Promise.all(closed);
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  cleanup.push(handle.stop);
  return handle;
}

function setup(server: ScriptedServer) {
  const pool = new ImapConnectionPool<ImapClient>();
  cleanup.push(() => pool.closeAll());
  // After the E1 checks the production connector would dial the validated IP; here the worker's own
  // openImapClient (synchronization profile) dials the scripted server.
  const adapter = createImapSyncAdapter({ pool, connect: (_endpoint, credentials) => openImapClient(localOptions(server.port), credentials) });
  const account = makeAccount({
    provider: "IMAP",
    emailAddress: LOGIN.username,
    syncCursor: "imap:v1:7:0",
    accessTokenEncrypted: "v2.not-used-here",
    providerMetadata: { imap: { host: HOST, port: 993, security: "TLS", username: LOGIN.username } }
  });
  const context: ProviderContext = {
    account,
    getAccessToken: () => Promise.reject(new Error("not OAuth")),
    getImapCredentials: async () => LOGIN
  };
  return { pool, adapter, account, context };
}

const rfc822 = (bodyBytes: number) => {
  const head = `From: Cliente <cliente@example.org>\r\nTo: ${LOGIN.username}\r\nSubject: Pedido 42\r\nMessage-ID: <pedido-42@example.org>\r\nDate: Wed, 14 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`;
  const line = `${CONTENT_MARKER} linea de texto del pedido\r\n`;
  return head + line.repeat(Math.ceil(bodyBytes / line.length));
};

describe("worker protocol limits (synchronization profile)", () => {
  it("the synchronization profile fits the worker's message cap with margin, and stays bounded", () => {
    const { sync } = IMAP_PROTOCOL_LIMITS;
    expect(sync.maxLiteralSize).toBeGreaterThan(IMAP_MAX_MESSAGE_BYTES);
    expect(sync.maxLiteralSize).toBeLessThanOrEqual(IMAP_MAX_MESSAGE_BYTES + 2 * 1024 * KiB);
    expect(sync.maxResponseSize).toBeGreaterThanOrEqual(sync.maxLiteralSize + sync.maxLineLength);
  });

  it("4. a message declared small whose literal exceeds the limit: refused at the marker, account ERROR, not retried", async () => {
    const announced = IMAP_PROTOCOL_LIMITS.sync.maxLiteralSize + 1;
    const server = await startServer({
      meta: (socket, tag) => void socket.write(`* 1 FETCH (UID 1 RFC822.SIZE 100)\r\n${tag} OK done\r\n`),
      // RFC822.SIZE said 100 bytes; the literal announces more than the limit, followed by real content.
      source: (socket) => void socket.write(`* 1 FETCH (UID 1 BODY[] {${announced}}\r\n${CONTENT_MARKER.repeat(1000)}`)
    });
    const { pool, adapter, account, context } = setup(server);

    const error = await adapter.fetchMessage(context, "7:1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect(error).toMatchObject({ code: "IMAP_RESPONSE_TOO_LARGE" });

    // Read-only access only: EXAMINE and BODY.PEEK[], never SELECT / STORE / \Seen.
    expect(server.received()).toMatch(/EXAMINE INBOX/);
    expect(server.received()).toContain("BODY.PEEK[]");
    expect(server.received()).not.toMatch(/SELECT|STORE|EXPUNGE|\+FLAGS/i);

    // 6. The connection is discarded (never reused) and closed on both sides.
    await server.allClosed();
    expect(server.openSockets()).toBe(0);
    expect(pool.stats().open).toBe(0);

    // 9. Security failure: account ERROR, NonRetryableError (BullMQ does not retry it).
    const accounts = makeAccountStore([account]);
    const logged: unknown[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn((...args: unknown[]) => logged.push(args)), error: vi.fn((...args: unknown[]) => logged.push(args)) };
    await expect(handleAccountFailure(error, account, { accounts, realtime: makeRealtime(), logger })).rejects.toBeInstanceOf(NonRetryableError);
    expect(accounts.markError).toHaveBeenCalledWith(account.id, expect.objectContaining({ code: "IMAP_RESPONSE_TOO_LARGE", status: "ERROR" }));

    // 8. Nothing secret or from the mailbox in the error, the stored account error or the logs.
    const texts = [String((error as Error).message), JSON.stringify(error), JSON.stringify(logged), JSON.stringify(vi.mocked(accounts.markError).mock.calls)];
    for (const text of texts) {
      for (const secret of [LOGIN.password, LOGIN.username, HOST, "127.0.0.1", CONTENT_MARKER]) expect(text).not.toContain(secret);
    }
  });

  it("5. a normal message within the limits is fetched (and above the strict connection-test limits: the sync profile is used)", async () => {
    const message = rfc822(300 * KiB);
    expect(Buffer.byteLength(message)).toBeGreaterThan(IMAP_PROTOCOL_LIMITS.probe.maxLiteralSize);
    const size = Buffer.byteLength(message);
    const server = await startServer({
      meta: (socket, tag) => void socket.write(`* 1 FETCH (UID 1 RFC822.SIZE ${size})\r\n${tag} OK done\r\n`),
      source: (socket, tag) => void socket.write(`* 1 FETCH (UID 1 BODY[] {${size}}\r\n${message})\r\n${tag} OK done\r\n`)
    });
    const { adapter, context } = setup(server);

    const email = await adapter.fetchMessage(context, "7:1");
    expect(email.subject).toBe("Pedido 42");
    expect(email.textBody).toContain(CONTENT_MARKER);
    expect(server.received()).toContain("BODY.PEEK[]");
    expect(server.received()).not.toMatch(/SELECT|STORE|\+FLAGS/i);
  });
});
