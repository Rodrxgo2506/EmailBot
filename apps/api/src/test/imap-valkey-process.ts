/*
 * IMAP E4.1: one "API instance" for imap-valkey-integration.test.ts, run as its own
 * Node process (node --import tsx). It holds the REAL limiter of the IMAP routes
 * (createImapConnectionTester) with the PRODUCTION Redis client options
 * (createRedisConnection, forProducer) against the temporary Valkey given in
 * IMAP_VALKEY_URL. The IMAP server and DNS are simulated in-process: no socket is
 * ever opened towards a mail server, and the process only reports how many times
 * the simulated server / resolver were reached.
 *
 * Protocol (one JSON object per line):
 *   stdin  {"id":1,"op":"test","org":"…","user":"…","host":"…","username":"…","port":993,"outcome":"auth"}
 *          outcome: ok | auth | dns | tls | timeout | slow (ok after 400 ms)
 *          {"id":2,"op":"stats"}  {"id":3,"op":"logs"}  {"id":4,"op":"exit"}
 *   stdout {"ready":true} once, then {"id":1,"status":422,"code":"IMAP_AUTH_FAILED","ms":12}
 */
import { createInterface } from "node:readline";
import type { ImapProbeClient, ImapProbeOpen, ImapResolver } from "@emailbot/shared";
import type { FastifyBaseLogger } from "fastify";
import type { AppDeps } from "../deps.js";
import { createRedisConnection } from "../infrastructure/queue.js";
import { AppError } from "../lib/errors.js";
import { createImapConnectionTester } from "../modules/email-accounts/imap-connection.js";

const url = process.env.IMAP_VALKEY_URL;
if (!url) throw new Error("IMAP_VALKEY_URL is required");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("IMAP_VALKEY_URL must point at a throwaway local Valkey / Redis");
const secret = process.env.IMAP_TEST_LIMIT_SECRET ?? null;

const redis = createRedisConnection(url, { forProducer: true });
redis.on("error", () => undefined);

type Outcome = "ok" | "auth" | "dns" | "tls" | "timeout" | "slow";
const counters = { opens: 0, resolves: 0 };
const logs: string[] = [];
const record = (level: string) => (object: Record<string, unknown>, message?: string) => void logs.push(JSON.stringify({ level, ...object, msg: message }));
const logger = {
  level: "info",
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  debug: record("debug"),
  fatal: record("fatal"),
  trace: record("trace"),
  silent: () => undefined,
  child: () => logger
} as unknown as FastifyBaseLogger;

const outcomes = new Map<string, Outcome>();
const outcomeOf = (host: string): Outcome => outcomes.get(host) ?? "ok";

const resolver: ImapResolver = async (hostname) => {
  counters.resolves += 1;
  if (outcomeOf(hostname) === "dns") throw new Error("ENOTFOUND");
  return [{ address: "93.184.216.34", family: 4 }];
};

const open: ImapProbeOpen = async (options, _login, onClient) => {
  counters.opens += 1;
  const client = {
    mailbox: false as unknown,
    async getMailboxLock(path: string) {
      client.mailbox = { path, readOnly: true, uidValidity: 9n, uidNext: 42 };
      return { path, release: () => undefined };
    },
    logout: async () => undefined,
    close: () => undefined
  };
  onClient(client as unknown as ImapProbeClient);
  const outcome = outcomeOf(options.servername);
  if (outcome === "auth") throw { authenticationFailed: true };
  if (outcome === "tls") throw { code: "DEPTH_ZERO_SELF_SIGNED_CERT" };
  if (outcome === "timeout") throw { code: "CONNECT_TIMEOUT" };
  if (outcome === "slow") await new Promise((resolve) => setTimeout(resolve, 400));
  return client as unknown as ImapProbeClient;
};

const deps = { config: { imapRateLimitSecret: secret }, rateLimitRedis: redis, imapResolver: resolver, imapProbeOpen: open } as unknown as AppDeps;
const tester = createImapConnectionTester(deps, logger);

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

interface Command {
  id: number;
  op: "test" | "stats" | "logs" | "exit";
  org?: string;
  user?: string;
  host?: string;
  username?: string;
  port?: number;
  outcome?: Outcome;
}

async function handle(command: Command) {
  if (command.op === "stats") return send({ id: command.id, ...counters });
  if (command.op === "logs") return send({ id: command.id, logs });
  if (command.op === "exit") {
    send({ id: command.id, bye: true });
    redis.disconnect();
    process.exit(0);
  }
  const host = command.host ?? "imap.hostinger.com";
  outcomes.set(host, command.outcome ?? "ok");
  const started = Date.now();
  try {
    const position = await tester.test(
      { organizationId: command.org!, userId: command.user!, log: logger },
      { host, port: command.port ?? 993, security: command.port === 143 ? "STARTTLS" : "TLS", username: command.username ?? "ventas@empresa-correo.com", password: "contraseña-de-prueba-e41" }
    );
    send({ id: command.id, status: 200, code: "OK", cursor: position.cursor, ms: Date.now() - started });
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    send({ id: command.id, status: appError?.statusCode ?? 500, code: appError?.code ?? "UNEXPECTED", ms: Date.now() - started });
  }
}

let started = false;
const start = () => {
  if (started) return;
  started = true;
  send({ ready: true, redis: redis.status });
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim()) void handle(JSON.parse(line) as Command);
  });
};
// Production client: no offline queue, so wait for the connection (or give up after 3 s: "Redis down" runs).
const timer = setTimeout(start, 3_000);
redis.once("ready", () => {
  clearTimeout(timer);
  start();
});
