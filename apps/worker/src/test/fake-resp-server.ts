import net from "node:net";

/*
 * F5.2 test helper (not a test file): a minimal RESP server on 127.0.0.1 that records every command it receives
 * and answers it, ignores it or rejects it depending on `mode`. Enough for ioredis (ready check = INFO) and the
 * commands of the application clients (SET, EVAL, PUBLISH, PING). Never a real Redis.
 *
 *   answer       every command is answered
 *   paused       the handshake (INFO / CLIENT / HELLO / SELECT) is answered; every other command is executed but
 *                its answer is held, in order, until resume() (like a paused or very slow Redis: it never skips
 *                an answer, it answers late)
 *   silent-all   nothing is answered (accepts the connection and never replies, not even the ready check)
 *   error        the handshake is answered, everything else gets "-ERR"
 */

export type FakeRespMode = "answer" | "paused" | "silent-all" | "error";

const HANDSHAKE = new Set(["info", "client", "hello", "select"]);

function encode(value: string | number | null): string {
  if (value === null) return "$-1\r\n";
  if (typeof value === "number") return `:${value}\r\n`;
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

/** Parses complete RESP arrays of bulk strings from `buffer`; returns them and the unparsed rest. */
function parse(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  for (;;) {
    const start = offset;
    const line = (at: number) => {
      const end = buffer.indexOf("\r\n", at);
      return end < 0 ? null : { text: buffer.toString("utf8", at, end), next: end + 2 };
    };
    const head = line(offset);
    if (!head || !head.text.startsWith("*")) return { commands, rest: buffer.subarray(start) };
    const count = Number(head.text.slice(1));
    offset = head.next;
    const args: string[] = [];
    for (let n = 0; n < count; n++) {
      const size = line(offset);
      if (!size) return { commands, rest: buffer.subarray(start) };
      const length = Number(size.text.slice(1));
      if (buffer.length < size.next + length + 2) return { commands, rest: buffer.subarray(start) };
      args.push(buffer.toString("utf8", size.next, size.next + length));
      offset = size.next + length + 2;
    }
    commands.push(args);
  }
}

export interface FakeRespServer {
  port: number;
  url: string;
  mode: FakeRespMode;
  /** Every command received, in order (name lower-case + args). */
  received: string[][];
  /** Sends the held answers (in order) and goes back to `answer`. */
  resume(): void;
  /** Closes every client connection (the clients reconnect); held answers are lost with them. */
  dropConnections(): void;
  stop(): Promise<void>;
}

export async function startFakeRespServer(mode: FakeRespMode = "answer"): Promise<FakeRespServer> {
  const sockets = new Set<net.Socket>();
  const held = new Map<net.Socket, string[]>();
  const strings = new Map<string, string>();
  const state: FakeRespServer = {
    port: 0,
    url: "",
    mode,
    received: [],
    resume: () => {
      state.mode = "answer";
      for (const [socket, answers] of held) socket.write(answers.splice(0).join(""));
    },
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  const reply = (args: string[]): string => {
    const [name = "", ...rest] = args;
    switch (name.toLowerCase()) {
      case "info":
        return encode("# Server\r\nredis_version:7.2.4\r\nloading:0\r\n");
      case "ping":
        return "+PONG\r\n";
      case "set": {
        const [key = "", value = ""] = rest;
        if (rest.some((arg) => arg.toUpperCase() === "NX") && strings.has(key)) return encode(null);
        strings.set(key, value);
        return "+OK\r\n";
      }
      case "eval": {
        const [, , key = "", token = ""] = rest;
        if (strings.get(key) !== token) return encode(0);
        strings.delete(key);
        return encode(1);
      }
      case "publish":
        return encode(1);
      default:
        return "+OK\r\n";
    }
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      held.delete(socket);
    });
    held.set(socket, []);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { commands, rest } = parse(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const args of commands) {
        const name = (args[0] ?? "").toLowerCase();
        state.received.push([name, ...args.slice(1)]);
        if (state.mode === "silent-all") continue;
        const queue = held.get(socket) ?? [];
        const answer = HANDSHAKE.has(name) || state.mode !== "error" ? reply(args) : "-ERR fake failure\r\n";
        // Answers keep their order: while some are held (paused), the next ones wait behind them.
        if (state.mode === "paused" && !HANDSHAKE.has(name)) queue.push(answer);
        else if (queue.length > 0) queue.push(answer);
        else socket.write(answer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.url = `redis://127.0.0.1:${state.port}`;
  return state;
}

/** A loopback port with nothing listening (connections are refused). */
export async function refusedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
