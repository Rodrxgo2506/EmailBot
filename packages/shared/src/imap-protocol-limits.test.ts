import net, { type LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyImapFailure,
  createImapConnector,
  IMAP_PROTOCOL_LIMITS,
  imapFlowOptions,
  imapProtocolLimitFailure,
  ImapTransportError,
  openImapClient,
  probeImapInbox,
  type ImapFlow,
  type ImapProbeClient
} from "./imap-client.js";
import type { ImapConnectionOptions, ImapResolver } from "./imap-destination.js";

/*
 * E6.1 (A1): ImapFlow protocol size limits, against a scripted IMAP server on
 * 127.0.0.1 (no external network, no TLS: the options below are test-only; every
 * production connection goes through createImapConnector / assertSafeImapConnectionOptions).
 * Oversized answers use the REAL limits with sizes just above them (a few hundred KiB),
 * or only ANNOUNCE an oversized literal: ImapFlow refuses it at its "{size}" marker,
 * so no test allocates the oversized payload.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const HOST = "imap.example-mail.com";
const LOGIN = { username: "ventas@empresa-correo.com", password: "app-password-123" };
/** Text that only the scripted server sends as "mail content"; it must never reach an error or a log. */
const CONTENT_MARKER = "CONFIDENTIAL-MAIL-BODY-7f3a";

/** ImapFlow 2.1.2 defaults (handler/limits.js) that must never be used again. */
const IMAPFLOW_DEFAULTS = { maxLineLength: 1024 * MiB, maxLiteralSize: 1024 * MiB, maxResponseSize: 2048 * MiB };

const noLookup = (() => undefined) as unknown as LookupFunction;

/** Plain TCP to the scripted server (test only: production options are built by imapConnectionOptions). */
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
 * Scripted IMAP server
 * ---------------------------------------------------------------- */

type Reply = (socket: net.Socket, tag: string) => void | Promise<void>;

interface ScriptedServer {
  port: number;
  /** Everything the client sent (latin1). */
  received(): string;
  /** Bytes the server managed to write. */
  sentBytes(): number;
  /** Sockets still open on the server side. */
  openSockets(): number;
  /** Resolves when every accepted socket is closed. */
  allClosed(): Promise<void>;
  stop(): Promise<void>;
}

const servers: ScriptedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.restoreAllMocks();
});

/** Writes `total` bytes of `fill` in `chunk`-sized pieces, honouring backpressure; stops when the peer goes away. */
async function writeFill(socket: net.Socket, total: number, counter: { bytes: number }, chunk = 16 * KiB, fill = 0x41): Promise<void> {
  let left = total;
  while (left > 0 && !socket.destroyed && socket.writable) {
    const size = Math.min(chunk, left);
    left -= size;
    counter.bytes += size;
    if (!socket.write(Buffer.alloc(size, fill))) {
      await new Promise<void>((resolve) => {
        socket.once("drain", resolve);
        socket.once("close", resolve);
      });
    }
  }
}

async function startServer(script: {
  greeting?: (socket: net.Socket, counter: { bytes: number }) => void | Promise<void>;
  commands?: Record<string, Reply>;
}): Promise<ScriptedServer> {
  let received = "";
  const counter = { bytes: 0 };
  const sockets = new Set<net.Socket>();
  const closed: Array<Promise<void>> = [];
  const send = (socket: net.Socket, text: string) => {
    if (!socket.destroyed) {
      counter.bytes += Buffer.byteLength(text);
      socket.write(text);
    }
  };
  const defaults: Record<string, Reply> = {
    CAPABILITY: (socket, tag) => send(socket, `* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`),
    LOGIN: (socket, tag) => send(socket, `${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`),
    EXAMINE: (socket, tag) =>
      send(socket, `* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 42] ok\r\n${tag} OK [READ-ONLY] done\r\n`),
    LOGOUT: (socket, tag) => {
      send(socket, `* BYE bye\r\n${tag} OK bye\r\n`);
      socket.end();
    }
  };
  const replies = { ...defaults, ...(script.commands ?? {}) };

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
        const reply = replies[command.toUpperCase()];
        if (reply) void reply(socket, tag);
        else send(socket, `${tag} OK done\r\n`);
      }
    });
    if (script.greeting) void script.greeting(socket, counter);
    else send(socket, "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const handle: ScriptedServer = {
    port,
    received: () => received,
    sentBytes: () => counter.bytes,
    openSockets: () => sockets.size,
    allClosed: async () => {
      await Promise.all(closed);
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  servers.push(handle);
  return handle;
}

/** Collects everything written to stdout / stderr / console while `fn` runs. */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; output: string }> {
  const chunks: string[] = [];
  const record = (...args: unknown[]) => {
    chunks.push(args.map((value) => (typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : JSON.stringify(value))).join(" "));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(record as never);
  vi.spyOn(process.stderr, "write").mockImplementation(record as never);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(record);
  try {
    return { result: await fn(), error: undefined, output: chunks.join("\n") };
  } catch (error) {
    return { result: undefined, error, output: chunks.join("\n") };
  } finally {
    vi.restoreAllMocks();
  }
}

/** Opens a client against the scripted server; resolves with the failure and the client object. */
async function failingOpen(port: number, profile?: "probe" | "sync") {
  let client: ImapFlow | undefined;
  const started = Date.now();
  const outcome = await captureOutput(() =>
    openImapClient(localOptions(port), LOGIN, { onClient: (created) => (client = created), ...(profile ? { profile } : {}) })
  );
  return { ...outcome, client, elapsedMs: Date.now() - started };
}

function expectTooLarge(error: unknown): asserts error is ImapTransportError {
  expect(error).toBeInstanceOf(ImapTransportError);
  expect(error).toMatchObject({ kind: "SECURITY", code: "IMAP_RESPONSE_TOO_LARGE" });
}

/** Nothing secret or from the mailbox in an error (message, JSON) or in the captured output. */
function expectNothingLeaked(error: unknown, output: string) {
  const texts = [String((error as Error)?.message ?? ""), JSON.stringify(error ?? null), output];
  for (const text of texts) {
    for (const secret of [LOGIN.password, LOGIN.username, HOST, "127.0.0.1", CONTENT_MARKER]) expect(text).not.toContain(secret);
  }
}

/** No LOGIN / AUTHENTICATE command and no credential (plain or SASL PLAIN base64) ever reached the server. */
function expectNoLogin(server: ScriptedServer) {
  const received = server.received();
  expect(received).not.toMatch(/LOGIN|AUTHENTICATE/i);
  expect(received).not.toContain(LOGIN.password);
  expect(received).not.toContain(Buffer.from(["", LOGIN.username, LOGIN.password].join(String.fromCharCode(0))).toString("base64"));
}

/* ---------------------------------------------------------------- *
 * Policy (regression: never ImapFlow's defaults again)
 * ---------------------------------------------------------------- */

describe("protocol limit policy", () => {
  it("every ImapFlow client gets explicit limits, far below ImapFlow's 1 GiB / 1 GiB / 2 GiB defaults", () => {
    for (const profile of ["probe", "sync"] as const) {
      const options = imapFlowOptions(localOptions(993), LOGIN, profile);
      const limits = IMAP_PROTOCOL_LIMITS[profile];
      expect(options).toMatchObject(limits);
      for (const key of ["maxLineLength", "maxLiteralSize", "maxResponseSize"] as const) {
        expect(Number.isSafeInteger(options[key])).toBe(true);
        expect(options[key]).toBeGreaterThan(0);
        expect(options[key]).toBeLessThanOrEqual(16 * MiB);
        expect(options[key]).toBeLessThan(IMAPFLOW_DEFAULTS[key]);
      }
      // ImapStream counts a literal's marker line in the response: the response limit needs headroom above both.
      expect(limits.maxResponseSize).toBeGreaterThan(limits.maxLiteralSize);
      expect(limits.maxResponseSize).toBeGreaterThanOrEqual(limits.maxLineLength);
    }
  });

  it("the default profile is the strict connection-test one; the sync profile fits a 10 MiB message", () => {
    expect(imapFlowOptions(localOptions(993), LOGIN)).toMatchObject(IMAP_PROTOCOL_LIMITS.probe);
    expect(IMAP_PROTOCOL_LIMITS.probe.maxResponseSize).toBeLessThanOrEqual(1 * MiB);
    expect(IMAP_PROTOCOL_LIMITS.sync.maxLiteralSize).toBeGreaterThanOrEqual(10 * MiB);
    expect(Object.isFrozen(IMAP_PROTOCOL_LIMITS) && Object.isFrozen(IMAP_PROTOCOL_LIMITS.probe) && Object.isFrozen(IMAP_PROTOCOL_LIMITS.sync)).toBe(true);
  });

  it("TLS / SNI / certificate settings are unchanged by the limits", () => {
    const options = imapFlowOptions({ ...localOptions(993), host: "93.184.216.34", secure: true }, LOGIN, "sync");
    expect(options).toMatchObject({ host: "93.184.216.34", secure: true, servername: HOST, tls: { servername: HOST, rejectUnauthorized: true, minVersion: "TLSv1.2" } });
    expect(options).not.toHaveProperty("proxy");
    expect(imapFlowOptions({ ...localOptions(143), doSTARTTLS: true }, LOGIN)).toMatchObject({ secure: false, doSTARTTLS: true });
  });
});

/* ---------------------------------------------------------------- *
 * Classification
 * ---------------------------------------------------------------- */

describe("classification of a protocol limit violation", () => {
  it("LineTooLarge / LiteralTooLarge / ResponseTooLarge are SECURITY / IMAP_RESPONSE_TOO_LARGE (also inside STARTTLS)", () => {
    for (const code of ["LineTooLarge", "LiteralTooLarge", "ResponseTooLarge"]) {
      expectTooLarge(classifyImapFailure(Object.assign(new Error(`Literal size 99 exceeds ${CONTENT_MARKER}`), { code })));
      expectTooLarge(classifyImapFailure(Object.assign(new Error("x"), { code, tlsFailed: true })));
      expect(classifyImapFailure(Object.assign(new Error(CONTENT_MARKER), { code })).message).not.toContain(CONTENT_MARKER);
    }
  });

  it("is never retried on the next validated address", async () => {
    const open = vi.fn(async () => {
      throw Object.assign(new Error("Literal size 12582912 exceeds maximum allowed size"), { code: "LiteralTooLarge" });
    });
    const resolver: ImapResolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "93.184.216.35", family: 4 as const }
    ]);
    const connect = createImapConnector({ resolver, open });
    await expect(connect({ host: HOST, port: 993, security: "TLS" }, LOGIN)).rejects.toMatchObject({ code: "IMAP_RESPONSE_TOO_LARGE" });
    expect(open).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------------------- *
 * Hostile answers before the login (scripted server)
 * ---------------------------------------------------------------- */

describe("hostile answers before the login", () => {
  it("1. a greeting line that never ends is cut at maxLineLength, without login, nothing leaked", async () => {
    const server = await startServer({
      greeting: async (socket, counter) => {
        socket.write("* OK ");
        // 1 MiB offered, no line terminator: only about the limit (plus socket buffers) may be read.
        await writeFill(socket, 1 * MiB, counter);
      }
    });
    const { error, output, client, elapsedMs } = await failingOpen(server.port);
    expectTooLarge(error);
    expectNothingLeaked(error, output);
    // Refused as soon as the limit is crossed, not after the 10 s greeting timeout.
    expect(elapsedMs).toBeLessThan(5_000);
    expectNoLogin(server);
    expect(server.received()).not.toContain(LOGIN.password);
    // 6. the connection is closed on both sides.
    await server.allClosed();
    expect(server.openSockets()).toBe(0);
    expect(client?.usable).toBe(false);
  });

  it("2. an oversized literal before the login is refused at its marker: none of its bytes are needed", async () => {
    for (const profile of ["probe", "sync"] as const) {
      const announced = IMAP_PROTOCOL_LIMITS[profile].maxLiteralSize + 1;
      const server = await startServer({
        // Only the marker is sent: the client must fail without waiting for the literal's bytes.
        greeting: (socket) => void socket.write(`* OK ready\r\n* 1 FETCH (BODY[] {${announced}}\r\n`)
      });
      const { error, output, client, elapsedMs } = await failingOpen(server.port, profile);
      expectTooLarge(error);
      expectNothingLeaked(error, output);
      expect(elapsedMs).toBeLessThan(5_000);
      expectNoLogin(server);
      await server.allClosed();
      expect(client?.usable).toBe(false);
    }
  });

  it("3. many literals that are each allowed cannot add up past maxResponseSize (fragmented writes)", async () => {
    const { maxLiteralSize, maxResponseSize } = IMAP_PROTOCOL_LIMITS.probe;
    const piece = 200 * KiB;
    expect(piece).toBeLessThan(maxLiteralSize);
    const pieces = Math.ceil(maxResponseSize / piece) + 1;
    const server = await startServer({
      greeting: async (socket, counter) => {
        socket.write("* OK ready\r\n* 1 FETCH (UID 1");
        for (let index = 1; index <= pieces && !socket.destroyed; index += 1) {
          socket.write(` BODY[${index}] {${piece}}\r\n`);
          // Small, separate writes: the parser sees the response in many TCP chunks.
          await writeFill(socket, piece, counter, 8 * KiB, 0x42);
        }
      }
    });
    const { error, output, elapsedMs } = await failingOpen(server.port);
    expectTooLarge(error);
    expectNothingLeaked(error, output);
    expect(elapsedMs).toBeLessThan(5_000);
    expectNoLogin(server);
    // (ImapStream refuses at the marker whose declared size crosses the limit; the server-side byte
    // count is not asserted: it measures socket buffers, not what the client read.)
    expect(pieces * piece).toBeGreaterThan(maxResponseSize);
    await server.allClosed();
  });
});

/* ---------------------------------------------------------------- *
 * Normal answers and the connection test (probe)
 * ---------------------------------------------------------------- */

describe("normal answers and the connection test", () => {
  const publicResolver: ImapResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
  const probeVia = (port: number) =>
    probeImapInbox({ host: HOST, port: 993, security: "TLS" }, LOGIN, {
      resolver: publicResolver,
      // After every E1 check, dial the scripted server instead of the validated public IP (test only),
      // with the same profile as the production default.
      open: (_checked, login, onClient) => openImapClient(localOptions(port), login, { onClient: onClient as (client: ImapFlow) => void, profile: "probe" }) as Promise<ImapProbeClient>
    });

  it("5. answers within the limits work: login, EXAMINE (read-only), position, LOGOUT", async () => {
    const server = await startServer({});
    const position = await probeVia(server.port);
    expect(position).toEqual({ uidValidity: 7, uidNext: 42, cursor: "imap:v1:7:41" });
    expect(server.received()).toMatch(/EXAMINE INBOX/);
    expect(server.received()).not.toMatch(/SELECT|STORE|EXPUNGE/i);
    expect(server.received()).toMatch(/LOGOUT/);
    await server.allClosed();
  });

  it("a literal and a long line just within the probe limits are accepted", async () => {
    const { maxLineLength } = IMAP_PROTOCOL_LIMITS.probe;
    const keywords = Array.from({ length: Math.floor((maxLineLength - 1024) / 12) }, (_, index) => `kw${String(index).padStart(8, "0")}`).join(" ");
    const server = await startServer({
      commands: {
        EXAMINE: (socket, tag) =>
          void socket.write(`* FLAGS (\\Seen ${keywords})\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 42] ok\r\n${tag} OK [READ-ONLY] done\r\n`)
      }
    });
    await expect(probeVia(server.port)).resolves.toMatchObject({ cursor: "imap:v1:7:41" });
  });

  it("an oversized answer AFTER the login (EXAMINE) is reported as IMAP_RESPONSE_TOO_LARGE, not as a network error", async () => {
    const { maxLineLength } = IMAP_PROTOCOL_LIMITS.probe;
    const server = await startServer({
      commands: {
        EXAMINE: async (socket, tag) => {
          socket.write("* FLAGS (\\Seen ");
          await writeFill(socket, maxLineLength + 64 * KiB, { bytes: 0 });
          socket.write(`)\r\n${tag} OK [READ-ONLY] done\r\n`);
        }
      }
    });
    const { error, output } = await captureOutput(() => probeVia(server.port));
    expectTooLarge(error);
    expectNothingLeaked(error, output);
    expect(server.received()).toMatch(/AUTHENTICATE|LOGIN/);
    await server.allClosed();
    expect(server.openSockets()).toBe(0);
  });

  it("imapProtocolLimitFailure only reports clients closed for a protocol limit", async () => {
    const server = await startServer({});
    const client = await openImapClient(localOptions(server.port), LOGIN);
    expect(imapProtocolLimitFailure(client)).toBeUndefined();
    await client.logout();
    expect(imapProtocolLimitFailure({})).toBeUndefined();
  });
});
