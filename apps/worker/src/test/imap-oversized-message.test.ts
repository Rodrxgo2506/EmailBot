import net, { type LookupFunction } from "node:net";
import type { EmailProcessingJob, ImapConnectionOptions } from "@emailbot/shared";
import { IMAP_PROTOCOL_LIMITS } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAccountFailure, NonRetryableError } from "../pipeline/failures.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { IMAP_MAX_BODY_CHARS, IMAP_MAX_MESSAGE_BYTES } from "../providers/imap/normalize.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { ProviderSecurityError, type ProviderContext } from "../providers/types.js";
import { IMAP_TEST_ORGANIZATION_IDS, makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, ORG, silentLogger } from "./fakes.js";

/*
 * E6.3: text of IMAP messages above IMAP_MAX_MESSAGE_BYTES (the "oversized" path:
 * headers + bounded text parts read in 64 KiB partial chunks, never the whole message).
 * A single-part message has no part number on its BODYSTRUCTURE root (ImapFlow tools.js),
 * so its text must be requested as part "1" (ImapFlow download() reads it as
 * BODY.PEEK[TEXT] and decodes it with the message headers).
 *
 * Real ImapFlow and the worker's openImapClient (synchronization profile, A1 limits)
 * against a scripted IMAP server on 127.0.0.1 (simulated server: no TLS, test-only
 * options; Dovecot covers the real server). Bodies are generated on demand from a
 * repeating pattern, so a 30 MiB message never exists in memory.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const HOST = "imap.example-mail.com";
const LOGIN = { username: "me@empresa-correo.com", password: "app-password-123" };
const MARKER = "SYNTHETIC-BODY-MARKER-e63";
const SUBJECT_ENCODED = "=?UTF-8?Q?Tu_c=C3=B3digo_temporal_42?=";
const CHUNK = 64 * KiB; // ImapFlow download() partial window

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

/* ---------------------------------------------------------------- *
 * Synthetic messages
 * ---------------------------------------------------------------- */

const LINE = Buffer.from(`${MARKER} linea sintetica de prueba 0123456789\r\n`);
const HTML_LINE = Buffer.from(`<p>${MARKER} parrafo sintetico de prueba 0123456789</p>\r\n`);

/** `length` bytes of a repeating `pattern` starting at `start` of a body of `total` bytes. */
function patternSlice(total: number, start: number, length: number, pattern: Buffer = LINE): Buffer {
  const end = Math.min(total, start + length);
  const out = Buffer.allocUnsafe(Math.max(0, end - start));
  for (let index = 0; index < out.length; index += 1) out[index] = pattern[(start + index) % pattern.length] as number;
  return out;
}

const headerBlock = (contentType: string) =>
  Buffer.from(
    `From: Streaming <info@account.streaming.example>\r\nTo: ${LOGIN.username}\r\nSubject: ${SUBJECT_ENCODED}\r\nMessage-ID: <e63-${Math.random().toString(16).slice(2)}@streaming.example>\r\nDate: Wed, 14 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n\r\n`
  );

interface SyntheticMessage {
  header: Buffer;
  bodySize: number;
  /** Body bytes (generated). */
  body(start: number, length: number): Buffer;
  bodyStructure: string;
  /** Sections other than HEADER / TEXT (multipart parts). */
  sections: Record<string, (start: number, length: number) => Buffer>;
}

function singlePart(bodySize: number, subtype: "plain" | "html" = "plain"): SyntheticMessage {
  const pattern = subtype === "html" ? HTML_LINE : LINE;
  const lines = Math.ceil(bodySize / pattern.length);
  return {
    header: headerBlock(`text/${subtype}; charset=utf-8`),
    bodySize,
    body: (start, length) => patternSlice(bodySize, start, length, pattern),
    bodyStructure: `("text" "${subtype}" ("charset" "utf-8") NIL NIL "7bit" ${bodySize} ${lines} NIL NIL NIL NIL)`,
    sections: {}
  };
}

/** multipart/mixed: a small text/plain part and a (declared) large PDF attachment. */
function multipartWithAttachment(attachmentSize: number): SyntheticMessage {
  const text = Buffer.from(`${MARKER} texto de la factura\r\n`);
  const partHeader = Buffer.from("Content-Type: text/plain; charset=utf-8\r\n\r\n");
  const boundary = "e63-boundary";
  const prefix = Buffer.from(`--${boundary}\r\n`);
  const middle = Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/pdf; name="factura.pdf"\r\nContent-Disposition: attachment; filename="factura.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const bodySize = prefix.length + partHeader.length + text.length + middle.length + attachmentSize + suffix.length;
  const fixedHead = Buffer.concat([prefix, partHeader, text, middle]);
  return {
    header: headerBlock(`multipart/mixed; boundary="${boundary}"`),
    bodySize,
    body: (start, length) => Buffer.concat([fixedHead, Buffer.alloc(Math.min(attachmentSize, start + length), 0x41), suffix]).subarray(start, start + length),
    bodyStructure: `(("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ${text.length} 1 NIL NIL NIL NIL)("application" "pdf" ("name" "factura.pdf") NIL NIL "base64" ${attachmentSize} NIL ("attachment" ("filename" "factura.pdf")) NIL NIL) "mixed" ("boundary" "${boundary}") NIL NIL NIL)`,
    sections: {
      "1": (start, length) => text.subarray(start, start + length),
      "1.MIME": (start, length) => partHeader.subarray(start, start + length),
      "2": (start, length) => Buffer.alloc(Math.max(0, Math.min(attachmentSize, start + length) - start), 0x41)
    }
  };
}

/* ---------------------------------------------------------------- *
 * Scripted IMAP server (UID FETCH with BODYSTRUCTURE and partial BODY.PEEK sections)
 * ---------------------------------------------------------------- */

interface ScriptedServer {
  port: number;
  received(): string;
  /** Requests for the whole message (BODY.PEEK[] without a section). */
  fullFetches: number;
  /** Bytes of message body sent in section answers (partial or not). */
  sectionBytes: number;
  /** A FETCH without .PEEK would set \Seen. */
  seen: boolean;
  openSockets(): number;
  allClosed(): Promise<void>;
  stop(): Promise<void>;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

async function startServer(message: SyntheticMessage, options: { ignorePartial?: boolean } = {}): Promise<ScriptedServer> {
  let received = "";
  const sockets = new Set<net.Socket>();
  const closed: Array<Promise<void>> = [];
  const state = { fullFetches: 0, sectionBytes: 0, seen: false };
  const size = message.header.length + message.bodySize;
  const quoted = (value: string) => `"${value}"`;
  const envelope = `ENVELOPE (${quoted("Wed, 14 Oct 2026 10:00:00 +0000")} ${quoted(SUBJECT_ENCODED)} (("Streaming" NIL "info" "account.streaming.example")) (("Streaming" NIL "info" "account.streaming.example")) (("Streaming" NIL "info" "account.streaming.example")) ((NIL NIL "me" "empresa-correo.com")) NIL NIL NIL "<e63@streaming.example>")`;

  const section = (key: string): ((start: number, length: number) => Buffer) | null => {
    const upper = key.toUpperCase();
    if (upper === "HEADER") return (start, length) => message.header.subarray(start, start + length);
    if (upper === "TEXT") return (start, length) => message.body(start, length);
    if (upper === "") return (start, length) => Buffer.concat([message.header, message.body(0, message.bodySize)]).subarray(start, start + length);
    return message.sections[upper] ?? null;
  };

  const fetchReply = (socket: net.Socket, tag: string, line: string) => {
    if (/\bBODY\[/i.test(line)) state.seen = true; // a non-PEEK fetch marks \Seen
    const items: Buffer[] = [Buffer.from("* 1 FETCH (UID 1")];
    if (/RFC822\.SIZE/i.test(line)) items.push(Buffer.from(` RFC822.SIZE ${size}`));
    if (/INTERNALDATE/i.test(line)) items.push(Buffer.from(' INTERNALDATE "14-Oct-2026 10:00:00 +0000"'));
    if (/ENVELOPE/i.test(line)) items.push(Buffer.from(` ${envelope}`));
    if (/BODYSTRUCTURE/i.test(line)) items.push(Buffer.from(` BODYSTRUCTURE ${message.bodyStructure}`));
    if (/\bFLAGS\b/i.test(line)) items.push(Buffer.from(state.seen ? " FLAGS (\\Seen)" : " FLAGS ()"));
    for (const match of line.matchAll(/BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi)) {
      const key = match[1] ?? "";
      const read = section(key);
      if (!read) continue;
      if (key === "") state.fullFetches += 1;
      const start = match[2] ? Number(match[2]) : 0;
      if (options.ignorePartial && key.toUpperCase() === "TEXT") {
        // A server that ignores the partial request answers with the whole part: only the
        // literal marker is sent (ImapFlow must refuse it before any of its bytes).
        items.push(Buffer.from(` BODY[${key.toUpperCase()}] {${message.bodySize}}\r\n`));
        socket.write(Buffer.concat(items));
        return;
      }
      const total = key === "" ? size : key.toUpperCase() === "TEXT" ? message.bodySize : read(0, Number.MAX_SAFE_INTEGER).length;
      const length = match[3] ? Number(match[3]) : total;
      const data = read(start, Math.min(length, Math.max(0, total - start)));
      if (key.toUpperCase() !== "HEADER" && !key.toUpperCase().endsWith("MIME")) state.sectionBytes += data.length;
      items.push(Buffer.from(` BODY[${key.toUpperCase()}]${match[2] ? `<${start}>` : ""} {${data.length}}\r\n`), data);
    }
    items.push(Buffer.from(`)\r\n${tag} OK done\r\n`));
    socket.write(Buffer.concat(items));
  };

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
            if (/^\S+ UID FETCH /i.test(line)) fetchReply(socket, tag, line);
            else socket.write(`${tag} OK done\r\n`);
            break;
          case "LOGOUT":
            socket.write(`* BYE bye\r\n${tag} OK bye\r\n`);
            socket.end();
            break;
          default:
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
    get fullFetches() {
      return state.fullFetches;
    },
    get sectionBytes() {
      return state.sectionBytes;
    },
    get seen() {
      return state.seen;
    },
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
  const adapter = createImapSyncAdapter({ pool, connect: (_endpoint, credentials) => openImapClient(localOptions(server.port), credentials) });
  const account = makeAccount({
    provider: "IMAP",
    emailAddress: LOGIN.username,
    syncCursor: "imap:v1:7:0",
    accessTokenEncrypted: "v2.not-used-here",
    providerMetadata: { imap: { host: HOST, port: 993, security: "TLS", username: LOGIN.username } }
  });
  const context: ProviderContext = { account, getAccessToken: () => Promise.reject(new Error("not OAuth")), getImapCredentials: async () => LOGIN };
  return { pool, adapter, account, context };
}

/** Read-only access only: EXAMINE and BODY.PEEK, nothing that changes the mailbox or marks \Seen. */
function expectReadOnly(server: ScriptedServer) {
  expect(server.received()).toMatch(/EXAMINE INBOX/);
  expect(server.received()).not.toMatch(/\bSELECT\b|\bSTORE\b|EXPUNGE|\+FLAGS/i);
  expect(server.seen).toBe(false);
}

/** 9. Every connection closed (server side) and none left in the pool. */
async function expectReleased(server: ScriptedServer, pool: ImapConnectionPool<ImapClient>) {
  await pool.closeAll();
  await server.allClosed();
  expect(server.openSockets()).toBe(0);
  expect(pool.stats().open).toBe(0);
}

describe("IMAP oversized messages (E6.3)", () => {
  it("1. a single-part message below the size limit: read whole with BODY.PEEK[], text kept", async () => {
    const message = singlePart(2 * KiB);
    const server = await startServer(message);
    const { pool, adapter, context } = setup(server);
    const email = await adapter.fetchMessage(context, "7:1");
    expect(email.subject).toBe("Tu código temporal 42");
    expect(email.textBody).toContain(MARKER);
    expect(server.fullFetches).toBe(1);
    expectReadOnly(server);
    await expectReleased(server, pool);
  });

  it("2. a 10.5 MiB single-part message: its text is read in partial chunks (part 1 -> TEXT), never the whole message", async () => {
    const message = singlePart(IMAP_MAX_MESSAGE_BYTES + 512 * KiB);
    expect(message.header.length + message.bodySize).toBeGreaterThan(IMAP_MAX_MESSAGE_BYTES);
    const server = await startServer(message);
    const { pool, adapter, context } = setup(server);
    const email = await adapter.fetchMessage(context, "7:1");
    expect(email.subject).toBe("Tu código temporal 42");
    expect(email.textBody).toContain(MARKER);
    expect((email.textBody ?? "").length).toBeLessThanOrEqual(IMAP_MAX_BODY_CHARS);
    expect(email.snippet).toContain(MARKER);
    expect(server.fullFetches).toBe(0);
    expect(server.received()).toMatch(/BODY\.PEEK\[TEXT\]<0\.65536>/i);
    // Bounded: at most the oversized text budget (4 000 000 bytes) plus one partial window.
    expect(server.sectionBytes).toBeLessThanOrEqual(IMAP_MAX_BODY_CHARS * 4 + CHUNK);
    expectReadOnly(server);
    await expectReleased(server, pool);
  });

  it("3. an oversized multipart message keeps using its part numbers: text from part 1, attachment listed, never downloaded", async () => {
    const message = multipartWithAttachment(IMAP_MAX_MESSAGE_BYTES + 512 * KiB);
    const server = await startServer(message);
    const { pool, adapter, context } = setup(server);
    const email = await adapter.fetchMessage(context, "7:1");
    expect(email.textBody).toContain(MARKER);
    expect(email.attachments).toEqual([expect.objectContaining({ filename: "factura.pdf", contentType: "application/pdf", providerAttachmentId: null })]);
    expect(server.received()).toMatch(/BODY\.PEEK\[1\]<0\.65536>/i);
    expect(server.received()).not.toMatch(/BODY\.PEEK\[TEXT\]/i);
    expect(server.received()).not.toMatch(/BODY\.PEEK\[2\]/i);
    expect(server.fullFetches).toBe(0);
    await expect(adapter.downloadAttachment(context, "7:1", "part-0")).rejects.toMatchObject({ status: 404 });
    expectReadOnly(server);
    await expectReleased(server, pool);
  });

  it("4. a 30 MiB single-part body: only the bounded text budget is read, the text is truncated to IMAP_MAX_BODY_CHARS", async () => {
    const message = singlePart(30 * MiB);
    const server = await startServer(message);
    const { pool, adapter, context } = setup(server);
    const email = await adapter.fetchMessage(context, "7:1");
    expect((email.textBody ?? "").length).toBe(IMAP_MAX_BODY_CHARS);
    expect(server.sectionBytes).toBeLessThanOrEqual(IMAP_MAX_BODY_CHARS * 4 + CHUNK);
    expect(server.fullFetches).toBe(0);
    expectReadOnly(server);
    await expectReleased(server, pool);
  });

  it("5. the text of an allowed large message reaches normal processing (stored email row)", async () => {
    const message = singlePart(IMAP_MAX_MESSAGE_BYTES + 512 * KiB);
    const server = await startServer(message);
    const { pool, adapter, account } = setup(server);
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow()];
    const deps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]),
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers: { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: adapter },
      createContext: (acc) => ({ account: acc, getAccessToken: () => Promise.reject(new Error("not OAuth")), getImapCredentials: async () => LOGIN }),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      logger: silentLogger,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };
    const job: EmailProcessingJob = { organizationId: ORG, emailAccountId: account.id, provider: "IMAP", providerMessageId: "7:1" };
    expect(await processEmail(job, deps)).toMatchObject({ status: "processed" });
    expect(emails.rows).toHaveLength(1);
    expect(String(emails.rows[0]?.text_body)).toContain(MARKER);
    expectReadOnly(server);
    await expectReleased(server, pool);
  });

  it("6. a server that ignores the partial request and announces the whole 10.5 MiB+ text is refused by the A1 limits", async () => {
    const message = singlePart(IMAP_PROTOCOL_LIMITS.sync.maxLiteralSize + 1);
    const server = await startServer(message, { ignorePartial: true });
    const { pool, adapter, account, context } = setup(server);
    const error = await adapter.fetchMessage(context, "7:1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect(error).toMatchObject({ code: "IMAP_RESPONSE_TOO_LARGE" });
    expectReadOnly(server);
    await expectReleased(server, pool);

    // 8. Not retried, and nothing secret or from the message in the error, the account error or the logs.
    const accounts = makeAccountStore([account]);
    const logged: unknown[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn((...args: unknown[]) => logged.push(args)), error: vi.fn((...args: unknown[]) => logged.push(args)) };
    await expect(handleAccountFailure(error, account, { accounts, realtime: makeRealtime(), logger })).rejects.toBeInstanceOf(NonRetryableError);
    const texts = [String((error as Error).message), JSON.stringify(error), JSON.stringify(logged), JSON.stringify(vi.mocked(accounts.markError).mock.calls)];
    for (const text of texts) for (const secret of [LOGIN.password, LOGIN.username, HOST, MARKER]) expect(text).not.toContain(secret);
  });

  it("7. a 10.5 MiB single-part text/html message: the HTML body is read in partial chunks (part 1 -> TEXT), bounded, nothing logged", async () => {
    const message = singlePart(IMAP_MAX_MESSAGE_BYTES + 512 * KiB, "html");
    expect(message.header.length + message.bodySize).toBeGreaterThan(IMAP_MAX_MESSAGE_BYTES);
    const server = await startServer(message);
    const { pool, adapter, context } = setup(server);

    // Everything printed while the message is read (stdout, stderr, console): nothing may leak.
    const printed: string[] = [];
    const record = (...args: unknown[]) => {
      printed.push(args.map((value) => (typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("latin1") : JSON.stringify(value))).join(" "));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(record as never);
    vi.spyOn(process.stderr, "write").mockImplementation(record as never);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(record);
    const email = await adapter.fetchMessage(context, "7:1");
    vi.restoreAllMocks();

    // 1-2. The HTML body is kept, up to IMAP_MAX_BODY_CHARS; no text/plain part exists.
    expect(email.htmlBody).toContain(`<p>${MARKER}`);
    expect((email.htmlBody ?? "").length).toBe(IMAP_MAX_BODY_CHARS);
    expect(email.textBody).toBeNull();
    expect(email.snippet).toContain(MARKER);
    // 3-4. Partial reads of the TEXT section only, never the whole message, within the text budget (A1 limits untouched).
    expect(server.fullFetches).toBe(0);
    expect(server.received()).toMatch(/BODY\.PEEK\[TEXT\]<0\.65536>/i);
    expect(server.sectionBytes).toBeLessThanOrEqual(IMAP_MAX_BODY_CHARS * 4 + CHUNK);
    // 6. No attachment exists and nothing else is requested.
    expect(email.attachments).toEqual([]);
    expect(server.received()).not.toMatch(/BODY\.PEEK\[[1-9]/i);
    // 5. Read-only, nothing marked \Seen. 7. Nothing secret or from the message printed.
    expectReadOnly(server);
    for (const secret of [LOGIN.password, LOGIN.username, HOST, MARKER]) expect(printed.join("\n")).not.toContain(secret);
    // 8. Connections and pool released.
    await expectReleased(server, pool);
  });
});
