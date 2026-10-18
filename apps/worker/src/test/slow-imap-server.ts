import net from "node:net";
import type { LookupFunction } from "node:net";
import type { ImapConnectionOptions } from "@emailbot/shared";

/*
 * IMAP A2 test helper: a local, scripted IMAP server (plain TCP on 127.0.0.1, real ImapFlow on the other
 * side) that can answer any phase SLOWLY: it keeps sending bytes every `dripMs` (far below ImapFlow's 60 s
 * socket inactivity limit) without ever finishing the answer. It records every socket, so a test can prove
 * that the client really closed the connection (not only that a promise was rejected), and every running
 * drip timer, so nothing keeps running after a test. Synthetic messages only; never a real mailbox.
 */

export type Phase = "normal" | "drip";

export interface SlowServerOptions {
  greeting?: Phase;
  login?: Phase | "refuse";
  search?: Phase;
  /** UIDs whose metadata FETCH drips (the very first FETCH of fetchMessage). */
  dripMetaUids?: number[];
  /** UIDs whose source FETCH (BODY.PEEK[]) drips. */
  dripSourceUids?: number[];
  /**
   * A2.1: the Nth source FETCH of this server (1-based, any UID) and every later one drip. Mutable at runtime
   * (server.options.dripSourceFrom = 0 heals the server), so a retry can succeed. 0 = off.
   */
  dripSourceFrom?: number;
  /** A2.1: every message is multipart/mixed with this many small PDF attachments (0 = text/plain only). */
  attachments?: number;
  /** A2.1: a source FETCH that does not drip is answered completely, but only after this delay (slow, finite). Mutable. */
  sourceDelayMs?: number;
  /** A2.1: written into every attachment, so two servers (two accounts) serve different bytes for the same UID. */
  label?: string;
  logout?: "normal" | "hang";
  uids?: number[];
  uidValidity?: number;
  dripMs?: number;
}

export interface SlowServer {
  port: number;
  options: Required<Omit<SlowServerOptions, "dripMetaUids" | "dripSourceUids">> & { dripMetaUids: Set<number>; dripSourceUids: Set<number> };
  /** Commands received, in order (tags removed; passwords never logged by the test). */
  commands: string[];
  /** Bytes written by drips since the start. */
  dripBytes(): number;
  /** Drip timers still running. */
  activeDrips(): number;
  /** Delayed (sourceDelayMs) answers not sent yet. */
  pendingDelays(): number;
  /** Sockets still open on the server side. */
  openSockets(): number;
  /** Connections accepted so far. */
  connections(): number;
  /** Source FETCHes (BODY.PEEK[]) received so far, answered or dripped. */
  sourceFetches(): number;
  /** Resolves once every socket accepted so far is closed (or rejects after `ms`). */
  allClosed(ms?: number): Promise<void>;
  stop(): Promise<void>;
}

export const SLOW_LOGIN = { username: "tester@empresa-correo.com", password: "clave-de-prueba-a2" };
const HOST = "imap.example-mail.com";
const noLookup = (() => undefined) as unknown as LookupFunction;

/** Connection options for the local test server (the E1 checks are covered elsewhere; this is the transport). */
export const localImapOptions = (port: number): ImapConnectionOptions => ({
  host: "127.0.0.1",
  port,
  secure: false,
  doSTARTTLS: undefined,
  servername: HOST,
  tls: { servername: HOST, rejectUnauthorized: true, minVersion: "TLSv1.2", lookup: noLookup },
  lookup: noLookup
});

function messageOf(uid: number, attachments = 0, label = ""): { header: Buffer; body: Buffer; size: number } {
  const boundary = `a2-boundary-${uid}`;
  const contentType = attachments > 0 ? `multipart/mixed; boundary="${boundary}"` : "text/plain; charset=utf-8";
  const header = Buffer.from(
    `From: Streaming <info@account.streaming.example>\r\nTo: me@empresa-correo.com\r\nSubject: Codigo ${uid}\r\nMessage-ID: <a2-${uid}@streaming.example>\r\nDate: Wed, 14 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const text = `Tu codigo es 4821 (${uid})\r\n`;
  if (attachments === 0) {
    const body = Buffer.from(text);
    return { header, body, size: header.length + body.length };
  }
  // Synthetic attachments only (a few bytes each).
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`];
  for (let n = 0; n < attachments; n++) {
    const content = Buffer.from(`%PDF-1.4 factura ${n} del mensaje ${uid}${label ? ` ${label}` : ""}`).toString("base64");
    parts.push(
      `--${boundary}\r\nContent-Type: application/pdf; name="factura-${n}.pdf"\r\nContent-Disposition: attachment; filename="factura-${n}.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`
    );
  }
  const body = Buffer.from(`${parts.join("")}--${boundary}--\r\n`);
  return { header, body, size: header.length + body.length };
}

/** "1:3,7" -> [1, 2, 3, 7] restricted to the known UIDs ("*" = the highest one). */
function uidSet(text: string, known: number[]): number[] {
  const max = known.length > 0 ? Math.max(...known) : 0;
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [a, b] = part.split(":");
    const from = a === "*" ? max : Number(a);
    const to = b === undefined ? from : b === "*" ? Math.max(max, from) : Number(b);
    for (const uid of known) if (uid >= Math.min(from, to) && uid <= Math.max(from, to)) out.add(uid);
  }
  return [...out].sort((x, y) => x - y);
}

export async function startSlowImapServer(options: SlowServerOptions = {}): Promise<SlowServer> {
  const settings = {
    greeting: options.greeting ?? "normal",
    login: options.login ?? "normal",
    search: options.search ?? "normal",
    dripMetaUids: new Set(options.dripMetaUids ?? []),
    dripSourceUids: new Set(options.dripSourceUids ?? []),
    dripSourceFrom: options.dripSourceFrom ?? 0,
    attachments: options.attachments ?? 0,
    sourceDelayMs: options.sourceDelayMs ?? 0,
    label: options.label ?? "",
    logout: options.logout ?? "normal",
    uids: options.uids ?? [1, 2, 3],
    uidValidity: options.uidValidity ?? 7,
    dripMs: options.dripMs ?? 100
  };
  const sockets = new Set<net.Socket>();
  const closed: Array<Promise<void>> = [];
  const drips = new Set<NodeJS.Timeout>();
  const delays = new Set<NodeJS.Timeout>();
  const commands: string[] = [];
  let dripBytes = 0;
  let connections = 0;
  let sourceFetches = 0;

  /** Writes `prefix`, then one more byte every dripMs, forever (until the socket closes). */
  const drip = (socket: net.Socket, prefix: string) => {
    socket.write(prefix);
    const timer = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(timer);
        drips.delete(timer);
        return;
      }
      dripBytes += 1;
      socket.write("x");
    }, settings.dripMs);
    drips.add(timer);
    socket.once("close", () => {
      clearInterval(timer);
      drips.delete(timer);
    });
  };

  const fetchReply = (socket: net.Socket, tag: string, line: string) => {
    const match = /^\S+ UID FETCH (\S+) \((.*)\)\s*$/i.exec(line);
    if (!match) return socket.write(`${tag} BAD fetch\r\n`);
    const items = match[2] ?? "";
    const wantsSource = /BODY\.PEEK\[\]/i.test(items);
    const parts: Buffer[] = [];
    for (const uid of uidSet(match[1] ?? "", settings.uids)) {
      const seq = settings.uids.indexOf(uid) + 1;
      if (wantsSource) sourceFetches += 1;
      const dripFrom = settings.dripSourceFrom > 0 && sourceFetches >= settings.dripSourceFrom;
      if (wantsSource && (settings.dripSourceUids.has(uid) || dripFrom)) return drip(socket, `* ${seq} FETCH (UID ${uid} BODY[] {100000}\r\n`);
      if (!wantsSource && /BODYSTRUCTURE/i.test(items) && settings.dripMetaUids.has(uid)) return drip(socket, `* ${seq} FETCH (UID ${uid} RFC822.SIZE `);
      const message = messageOf(uid, settings.attachments, settings.label);
      const out: Buffer[] = [Buffer.from(`* ${seq} FETCH (UID ${uid}`)];
      if (/RFC822\.SIZE/i.test(items)) out.push(Buffer.from(` RFC822.SIZE ${message.size}`));
      if (/INTERNALDATE/i.test(items)) out.push(Buffer.from(` INTERNALDATE "${internalDate()}"`));
      if (/ENVELOPE/i.test(items))
        out.push(
          Buffer.from(
            ` ENVELOPE ("Wed, 14 Oct 2026 10:00:00 +0000" "Codigo ${uid}" (("Streaming" NIL "info" "account.streaming.example")) (("Streaming" NIL "info" "account.streaming.example")) (("Streaming" NIL "info" "account.streaming.example")) ((NIL NIL "me" "empresa-correo.com")) NIL NIL NIL "<a2-${uid}@streaming.example>")`
          )
        );
      if (/BODYSTRUCTURE/i.test(items)) out.push(Buffer.from(` BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ${message.body.length} 1 NIL NIL NIL NIL)`));
      if (/BODY\.PEEK\[HEADER\]/i.test(items)) out.push(Buffer.from(` BODY[HEADER] {${message.header.length}}\r\n`), message.header);
      if (wantsSource) out.push(Buffer.from(` BODY[] {${message.size}}\r\n`), message.header, message.body);
      out.push(Buffer.from(")\r\n"));
      parts.push(...out);
    }
    parts.push(Buffer.from(`${tag} OK done\r\n`));
    if (!wantsSource || settings.sourceDelayMs <= 0) return socket.write(Buffer.concat(parts));
    // Slow but finite: the whole answer after sourceDelayMs (unless the client closed the socket first).
    const timer = setTimeout(() => {
      delays.delete(timer);
      if (!socket.destroyed) socket.write(Buffer.concat(parts));
    }, settings.sourceDelayMs);
    delays.add(timer);
    socket.once("close", () => {
      clearTimeout(timer);
      delays.delete(timer);
    });
    return true;
  };

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("latin1");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag = "*", command = ""] = line.split(" ");
        const verb = command.toUpperCase();
        commands.push(verb === "LOGIN" ? "LOGIN" : line.slice(tag.length + 1));
        if (socket.destroyed) return;
        switch (verb) {
          case "LOGIN":
          case "AUTHENTICATE":
            if (settings.login === "drip") drip(socket, "* OK still checking ");
            else if (settings.login === "refuse") socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
            else socket.write(`${tag} OK logged in\r\n`);
            break;
          case "EXAMINE":
          case "SELECT": {
            const max = settings.uids.length > 0 ? Math.max(...settings.uids) : 0;
            socket.write(
              `* FLAGS (\\Seen)\r\n* ${settings.uids.length} EXISTS\r\n* OK [UIDVALIDITY ${settings.uidValidity}] ok\r\n* OK [UIDNEXT ${max + 1}] ok\r\n${tag} OK [READ-ONLY] done\r\n`
            );
            break;
          }
          case "UID":
            if (/^\S+ UID FETCH /i.test(line)) fetchReply(socket, tag, line);
            else if (/^\S+ UID SEARCH /i.test(line)) {
              if (settings.search === "drip") drip(socket, "* SEARCH");
              else {
                const range = /UID (\S+)/i.exec(line.replace(/^\S+ UID SEARCH /i, ""))?.[1];
                const found = range ? uidSet(range, settings.uids) : settings.uids;
                socket.write(`* SEARCH ${found.join(" ")}\r\n${tag} OK done\r\n`);
              }
            } else socket.write(`${tag} OK done\r\n`);
            break;
          case "LOGOUT":
            if (settings.logout === "hang") break; // never answers
            socket.write(`* BYE bye\r\n${tag} OK bye\r\n`);
            socket.end();
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    if (settings.greeting === "drip") drip(socket, "* OK [CAPABILITY IMAP4rev1] wait");
    else socket.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    options: settings,
    commands,
    dripBytes: () => dripBytes,
    activeDrips: () => drips.size,
    pendingDelays: () => delays.size,
    openSockets: () => sockets.size,
    connections: () => connections,
    sourceFetches: () => sourceFetches,
    allClosed: async (ms = 2_000) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(closed).then(() => undefined),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`sockets still open after ${ms} ms`)), ms);
        })
      ]).finally(() => clearTimeout(timer));
    },
    stop: async () => {
      for (const timer of drips) clearInterval(timer);
      drips.clear();
      for (const timer of delays) clearTimeout(timer);
      delays.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** INTERNALDATE of "now" (inside the 7-day window). */
function internalDate(): string {
  const d = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}
