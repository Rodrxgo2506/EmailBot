import { spawn } from "node:child_process";
import dns from "node:dns";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalValkeyUrl, UnsafeValkeyTargetError } from "./valkey-target.js";

/*
 * Guard of the opt-in Valkey suites (valkey-target.ts). Runs in the normal suite:
 * no Valkey, no network. Connections, DNS lookups and pipe openings are intercepted
 * and BLOCKED (in this process with spies, in child processes with net-block-hook.cjs),
 * so even the positive controls never reach anything.
 */

const SECRET = "S3cr3t-Pw-e44";

const ACCEPTED = [
  "redis://127.0.0.1:56379",
  "redis://localhost:56379",
  "redis://[::1]:56379",
  "rediss://127.0.0.1:56379",
  `redis://:${SECRET}@127.0.0.1:56379`,
  `redis://default:${SECRET}@localhost:56379/0`,
  "redis://127.0.0.1"
];

const REJECTED: Array<[string, string]> = [
  ["empty", ""],
  ["spaces only", "   "],
  ["leading space", " redis://127.0.0.1:56379"],
  ["trailing newline", "redis://127.0.0.1:56379\n"],
  ["inner space", "redis://local host:56379"],
  ["tab", "redis://127.0.0.1:56379\t"],
  ["backslashes", "redis:\\\\localhost:56379"],
  ["http", "http://localhost:6379"],
  ["https", "https://localhost:6379"],
  ["ftp", "ftp://localhost:6379"],
  ["x scheme (pipe path in ioredis)", "x://localhost:56379"],
  ["unix scheme", "unix:///tmp/redis.sock"],
  ["upper-case scheme", "REDIS://localhost:6379"],
  ["socket path", "/tmp/redis.sock"],
  ["protocol-relative", "//localhost:56379"],
  ["no scheme", "localhost:56379"],
  ["remote name", `redis://:${SECRET}@redis.example.com:6379`],
  ["remote IP", `redis://:${SECRET}@203.0.113.10:6379`],
  ["private IP", "redis://10.0.0.5:6379"],
  ["other loopback address", "redis://127.0.0.2:6379"],
  ["unspecified IPv4", "redis://0.0.0.0:6379"],
  ["unspecified IPv6", "redis://[::]:6379"],
  ["IPv4-mapped IPv6", "redis://[::ffff:127.0.0.1]:6379"],
  ["decimal IPv4", "redis://2130706433:6379"],
  ["hex IPv4", "redis://0x7f.1:6379"],
  ["percent-encoded host", "redis://%6c%6fcalhost:6379"],
  ["trailing-dot host", "redis://localhost.:6379"],
  ["upper-case host", "redis://LOCALHOST:6379"],
  ["loopback as a subdomain", "redis://127.0.0.1.redis.example.com:6379"],
  ["credentials before a remote host", "redis://localhost@redis.example.com:6379"],
  ["two @", `redis://u:${SECRET}@localhost@redis.example.com:6379`],
  ["query path (pipe in ioredis)", "redis://localhost:6379?path=//evil.example/pipe"],
  ["query host", "redis://localhost:6379?host=redis.example.com"],
  ["query tls / family", "rediss://localhost:6379?family=6"],
  ["fragment", "redis://localhost:6379#x"],
  ["path instead of db", "redis://localhost:6379/tmp/sock"],
  ["extra slashes", "redis://localhost:6379//0"],
  ["triple slash", "redis:///localhost:6379"],
  ["port out of range", "redis://localhost:70000"],
  ["unclosed IPv6", "redis://[::1:6379"],
  ["malformed", "redis://"]
];

describe("assertLocalValkeyUrl", () => {
  it.each(ACCEPTED)("accepts %s and returns it unchanged", (url) => {
    expect(assertLocalValkeyUrl(url)).toBe(url);
  });

  it.each(REJECTED)("rejects %s", (_label, url) => {
    expect(() => assertLocalValkeyUrl(url)).toThrow(UnsafeValkeyTargetError);
  });

  it("undefined is rejected", () => {
    expect(() => assertLocalValkeyUrl(undefined)).toThrow(UnsafeValkeyTargetError);
  });

  it("errors never carry the URL nor its credentials (message, properties, cause)", () => {
    for (const [, url] of REJECTED.filter(([, url]) => url.length > 0)) {
      try {
        assertLocalValkeyUrl(url);
        throw new Error("not rejected");
      } catch (error) {
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error);
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain("redis.example.com");
        expect((error as { cause?: unknown }).cause).toBeUndefined();
      }
    }
  });
});

describe("no network, DNS or pipe before the guard (this process)", () => {
  const events: Array<Record<string, unknown>> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    events.length = 0;
  });
  function intercept() {
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function blocked(this: net.Socket, ...args: unknown[]) {
      // net.createConnection passes Node's normalized arguments: [[options, callback]].
      const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; port?: number; path?: string };
      events.push(options.path !== undefined ? { kind: "pipe", path: options.path } : { kind: "tcp", host: options.host, port: Number(options.port) });
      process.nextTick(() => this.destroy(new Error("blocked by test")));
      return this;
    } as never);
    vi.spyOn(dns, "lookup").mockImplementation(((hostname: string) => {
      events.push({ kind: "dns", hostname });
    }) as never);
  }
  /** The guarded way every suite opens a client: validate, then connect with the unchanged value. */
  const openGuarded = (url: string) => new Redis(assertLocalValkeyUrl(url), { maxRetriesPerRequest: 0, retryStrategy: () => null });

  it("positive control: an accepted URL to a CLOSED loopback port is seen (and blocked) by the interception", async () => {
    intercept();
    const client = openGuarded("redis://127.0.0.1:1");
    client.on("error", () => undefined);
    await vi.waitFor(() => expect(events).toContainEqual({ kind: "tcp", host: "127.0.0.1", port: 1 }));
    client.disconnect();
  });

  it("positive control: an UNGUARDED x:// URL makes ioredis open a pipe, also seen (and blocked)", async () => {
    intercept();
    const client = new Redis("x://localhost:1", { maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: false });
    client.on("error", () => undefined);
    await vi.waitFor(() => expect(events.some((event) => event.kind === "pipe")).toBe(true));
    client.disconnect();
  });

  it.each(REJECTED)("rejected (%s): no TCP connection, no DNS lookup, no pipe", async (_label, url) => {
    intercept();
    expect(() => openGuarded(url)).toThrow(UnsafeValkeyTargetError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);
  });
});

describe("the helper process cannot bypass the guard (separate processes, network blocked)", () => {
  const helper = fileURLToPath(new URL("./imap-valkey-process.ts", import.meta.url));
  const hook = fileURLToPath(new URL("./net-block-hook.cjs", import.meta.url));
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Runs the helper with IMAP_VALKEY_URL under net-block-hook.cjs; returns its exit code, output and recorded events. */
  async function runHelper(url: string, settleMs: number) {
    dir = mkdtempSync(join(tmpdir(), "valkey-guard-"));
    const log = join(dir, "events.log");
    const child = spawn(process.execPath, ["--require", hook, "--import", "tsx", helper], {
      env: { ...process.env, IMAP_VALKEY_URL: url, NET_BLOCK_HOOK_LOG: log },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, settleMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const events = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind: string; host?: string; port?: number; path?: string })
          // tsx's own IPC channel (a local pipe in the temp directory, not opened by the helper's code).
          .filter((event) => !(event.kind === "pipe" && /tsx-/.test(event.path ?? "")))
      : [];
    return { exit, output, events };
  }

  it("positive control: an accepted URL to a CLOSED loopback port -> the hook records the TCP attempt", async () => {
    const result = await runHelper(`redis://:${SECRET}@127.0.0.1:1`, 6_000);
    expect(result.events).toContainEqual({ kind: "tcp", host: "127.0.0.1", port: 1 });
    expect(result.output).not.toContain(SECRET);
  }, 20_000);

  it.each([
    ["x scheme", `x://:${SECRET}@localhost:56379`],
    ["query path", `redis://:${SECRET}@localhost:56379?path=//evil.example/pipe`],
    ["remote host", `redis://:${SECRET}@redis.example.com:6379`],
    ["http scheme", `http://:${SECRET}@localhost:56379`]
  ])("%s: the helper exits before any TCP, DNS or pipe, without printing the credentials", async (_label, url) => {
    const result = await runHelper(url, 15_000);
    expect(result.exit).not.toBe(0);
    expect(result.exit).not.toBeNull();
    expect(result.output).toContain("IMAP_VALKEY_URL rejected");
    expect(result.output).not.toContain(SECRET);
    expect(result.events).toEqual([]);
  }, 20_000);
});
