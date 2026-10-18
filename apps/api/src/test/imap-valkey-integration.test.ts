import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FAIL_SCRIPT, LOCK_TTL_SCRIPT, RESET_SCRIPT } from "../infrastructure/login-throttle.js";
import { createRedisConnection } from "../infrastructure/queue.js";
import { INCR_SCRIPT } from "../infrastructure/rate-limit-store.js";
import {
  ACQUIRE_SLOT_SCRIPT,
  IMAP_CONNECTION_LIMITS,
  IMAP_LOGIN_LOCKOUT,
  imapMailboxGlobalKey,
  imapMailboxLockKey,
  RELEASE_SCRIPT,
  RESERVE_SCRIPT
} from "../modules/email-accounts/imap-connection.js";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";
import { assertLocalValkeyUrl } from "./valkey-target.js";

/*
 * IMAP E4.1 - REAL Valkey integration of the IMAP abuse limits. Opt-in: every
 * test here is SKIPPED unless IMAP_VALKEY_URL points at a THROWAWAY Valkey /
 * Redis (never a shared one: the tests read and write its keys, KEYS included).
 * CI never sets it. See docs/imap.md.
 *
 *   IMAP_VALKEY_PHASE=up    (default) scripts, two API processes, timeouts
 *   IMAP_VALKEY_PHASE=down  the server is stopped: every IMAP check refuses
 *
 * The "API instances" are separate Node processes (imap-valkey-process.ts) that
 * share only the Valkey server. IMAP servers and DNS are simulated: no socket is
 * opened towards a mail server.
 */

const RAW_URL = process.env.IMAP_VALKEY_URL ?? "";
const PHASE = process.env.IMAP_VALKEY_PHASE ?? "up";
const enabled = RAW_URL !== "";
// These tests write keys, run KEYS / DEL and CLIENT PAUSE: only ever a throwaway server on this
// machine over TCP (valkey-target.ts). Checked before any client exists; used unchanged afterwards.
const URL_ENV = enabled ? assertLocalValkeyUrl(RAW_URL) : "";
const PROCESS_SCRIPT = fileURLToPath(new URL("./imap-valkey-process.ts", import.meta.url));
const SECRET = randomBytes(32).toString("base64");
const HOST = "imap.hostinger.com";
const USERNAME = "ventas@empresa-correo.com";
const PASSWORD = "contraseña-de-prueba-e41";
const org = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- API processes */

interface Reply {
  id: number;
  status?: number;
  code?: string;
  ms?: number;
  opens?: number;
  resolves?: number;
  logs?: string[];
}

class ApiProcess {
  readonly child: ChildProcess;
  readonly #pending = new Map<number, (reply: Reply) => void>();
  #next = 1;
  readonly ready: Promise<{ redis: string }>;

  constructor(secret: string | null) {
    this.child = spawn(process.execPath, ["--import", "tsx", PROCESS_SCRIPT], {
      env: { ...process.env, IMAP_VALKEY_URL: URL_ENV, ...(secret ? { IMAP_TEST_LIMIT_SECRET: secret } : {}) },
      stdio: ["pipe", "pipe", "inherit"]
    });
    let markReady!: (value: { redis: string }) => void;
    this.ready = new Promise((resolve) => (markReady = resolve));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as Reply & { ready?: boolean; redis?: string };
      if (message.ready) return markReady({ redis: message.redis ?? "" });
      this.#pending.get(message.id)?.(message);
      this.#pending.delete(message.id);
    });
  }

  #send(command: Record<string, unknown>): Promise<Reply> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.child.stdin!.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }
  test(command: { org: string; user: string; host?: string; username?: string; port?: number; outcome?: string }) {
    return this.#send({ op: "test", host: HOST, username: USERNAME, ...command });
  }
  stats() {
    return this.#send({ op: "stats" });
  }
  logs() {
    return this.#send({ op: "logs" }).then((reply) => reply.logs ?? []);
  }
  async stop() {
    await Promise.race([this.#send({ op: "exit" }), sleep(2_000)]);
    this.child.kill();
  }
}

const opensOf = async (...processes: ApiProcess[]) => (await Promise.all(processes.map((p) => p.stats()))).reduce((sum, s) => sum + (s.opens ?? 0), 0);
const resolvesOf = async (...processes: ApiProcess[]) => (await Promise.all(processes.map((p) => p.stats()))).reduce((sum, s) => sum + (s.resolves ?? 0), 0);
const secretBytes = Buffer.from(SECRET, "base64");
const globalKeyOf = (host = HOST, username = USERNAME, secret = secretBytes) => `emailbot-imap-${imapMailboxGlobalKey(secret, host, username)}`;
const mailboxFailKey = (organizationId: string, host = HOST, username = USERNAME, secret = secretBytes) =>
  `emailbot-imap-login:fail:${imapMailboxLockKey(secret, organizationId, host, username)}`;
const mailboxLockKey = (organizationId: string, host = HOST, username = USERNAME, secret = secretBytes) =>
  `emailbot-imap-login:lock:${imapMailboxLockKey(secret, organizationId, host, username)}`;

/* ================================================================ phase "up" */

describe.runIf(enabled && PHASE === "up")("Valkey (real): IMAP limit scripts", () => {
  let admin: Redis;
  const ns = `e41test:${randomBytes(4).toString("hex")}`;
  beforeAll(async () => {
    admin = new Redis(URL_ENV, { maxRetriesPerRequest: 1 });
    await admin.ping();
  });
  afterAll(async () => {
    const keys = await admin.keys(`${ns}:*`);
    if (keys.length) await admin.del(...keys);
    admin.disconnect();
  });
  const run = (script: string, key: string | string[], ...args: Array<string | number>) => {
    const keys = Array.isArray(key) ? key : [key];
    return admin.eval(script, keys.length, ...keys, ...args);
  };

  it("server identity (for the report)", async () => {
    const info = await admin.info("server");
    const version = /valkey_version:(\S+)/.exec(info)?.[1] ?? /redis_version:(\S+)/.exec(info)?.[1];
    console.log(`E41 server: ${/server_name:(\S+)/.exec(info)?.[1] ?? "redis"} ${version}`);
    expect(version).toBeTruthy();
  });

  it("INCR_SCRIPT: creates, increments, sets the window once, expires", async () => {
    const key = `${ns}:incr`;
    expect(await run(INCR_SCRIPT, key, 400)).toEqual([1, 400]);
    const [count, ttl] = (await run(INCR_SCRIPT, key, 400)) as [number, number];
    expect(count).toBe(2);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
    expect(await admin.type(key)).toBe("string");
    expect(await admin.get(key)).toBe("2");
    await sleep(500);
    expect(await admin.exists(key)).toBe(0);
  });

  it("FAIL / LOCK_TTL / RESET: 9 failures counted, the 10th sets the lock (with its TTL) and clears the counter", async () => {
    const fail = `${ns}:fail`;
    const lock = `${ns}:lock`;
    for (let n = 1; n < 10; n += 1) expect(await run(FAIL_SCRIPT, [fail, lock], 60_000, 10, 30_000)).toBe(0);
    expect(await admin.get(fail)).toBe("9");
    expect(await admin.pttl(fail)).toBeGreaterThan(59_000);
    expect(await run(FAIL_SCRIPT, [fail, lock], 60_000, 10, 30_000)).toBe(30_000);
    expect(await admin.exists(fail)).toBe(0);
    const lockTtl = Number(await run(LOCK_TTL_SCRIPT, lock));
    expect(lockTtl).toBeGreaterThan(29_000);
    expect(lockTtl).toBeLessThanOrEqual(30_000);
    expect(Number(await run(LOCK_TTL_SCRIPT, `${ns}:no-lock`))).toBe(0);
    await run(FAIL_SCRIPT, [fail, lock], 60_000, 10, 30_000);
    await run(RESET_SCRIPT, fail);
    expect(await admin.exists(fail)).toBe(0);
  });

  it("RESERVE / RELEASE: capped, refused reservations leave nothing, release never goes below zero nor creates a key, window expires", async () => {
    const key = `${ns}:reserve`;
    for (let n = 0; n < 3; n += 1) expect(await run(RESERVE_SCRIPT, key, 500, 3)).toBe(1);
    expect(await run(RESERVE_SCRIPT, key, 500, 3)).toBe(0);
    expect(await admin.get(key)).toBe("3");
    expect(await admin.pttl(key)).toBeGreaterThan(0);
    await run(RELEASE_SCRIPT, key);
    expect(await admin.get(key)).toBe("2");
    const ttlAfterRelease = await admin.pttl(key);
    expect(ttlAfterRelease).toBeGreaterThan(0); // DECR keeps the expiry
    await run(RELEASE_SCRIPT, `${ns}:never-reserved`);
    expect(await admin.exists(`${ns}:never-reserved`)).toBe(0);
    await sleep(600);
    expect(await admin.exists(key)).toBe(0);
    expect(await run(RESERVE_SCRIPT, key, 500, 3)).toBe(1);
  });

  it("ACQUIRE_SLOT / RELEASE: one holder, lease refreshed, freed by release or by lease expiry", async () => {
    const key = `${ns}:slot`;
    expect(await run(ACQUIRE_SLOT_SCRIPT, key, 1, 400)).toBe(1);
    expect(await run(ACQUIRE_SLOT_SCRIPT, key, 1, 400)).toBe(0);
    expect(await admin.get(key)).toBe("1");
    expect(await admin.pttl(key)).toBeLessThanOrEqual(400);
    await run(RELEASE_SCRIPT, key);
    expect(await admin.get(key)).toBe("0");
    expect(await run(ACQUIRE_SLOT_SCRIPT, key, 1, 400)).toBe(1);
    await sleep(500); // the holder "died": the lease frees the slot
    expect(await admin.exists(key)).toBe(0);
    expect(await run(ACQUIRE_SLOT_SCRIPT, key, 1, 400)).toBe(1);
  });

  it("atomicity under 200 / 100 / 50 / 25 simultaneous calls (separate connections)", async () => {
    const clients = Array.from({ length: 8 }, () => new Redis(URL_ENV, { maxRetriesPerRequest: 1 }));
    try {
      const pick = (i: number) => clients[i % clients.length]!;
      const reserve = await Promise.all(Array.from({ length: 200 }, (_, i) => pick(i).eval(RESERVE_SCRIPT, 1, `${ns}:race-reserve`, 60_000, 30)));
      expect(reserve.filter((r) => r === 1)).toHaveLength(30);
      expect(await admin.get(`${ns}:race-reserve`)).toBe("30");

      const slot = await Promise.all(Array.from({ length: 100 }, (_, i) => pick(i).eval(ACQUIRE_SLOT_SCRIPT, 1, `${ns}:race-slot`, 1, 60_000)));
      expect(slot.filter((r) => r === 1)).toHaveLength(1);
      expect(await admin.get(`${ns}:race-slot`)).toBe("1");

      const incr = (await Promise.all(Array.from({ length: 50 }, (_, i) => pick(i).eval(INCR_SCRIPT, 1, `${ns}:race-incr`, 60_000)))) as Array<[number, number]>;
      expect(new Set(incr.map(([count]) => count)).size).toBe(50);

      const fails = await Promise.all(Array.from({ length: 25 }, (_, i) => pick(i).eval(FAIL_SCRIPT, 2, `${ns}:race-fail`, `${ns}:race-lock`, 60_000, 10, 30_000)));
      expect(fails.filter((r) => r === 30_000)).toHaveLength(2); // the 10th and the 20th failure
      expect(await admin.get(`${ns}:race-fail`)).toBe("5");
    } finally {
      for (const client of clients) client.disconnect();
    }
  });

  it("a script error (a key holding a non-integer) is a rejected call, not a silent success", async () => {
    await admin.set(`${ns}:not-a-number`, "abc");
    await expect(run(RESERVE_SCRIPT, `${ns}:not-a-number`, 500, 3)).rejects.toThrow(/not an integer|out of range/);
  });
});

describe.runIf(enabled && PHASE === "up")("Valkey (real): two independent API processes", () => {
  let admin: Redis;
  let one: ApiProcess;
  let two: ApiProcess;
  const all = () => [one, two];
  beforeAll(async () => {
    admin = new Redis(URL_ENV, { maxRetriesPerRequest: 1 });
    one = new ApiProcess(SECRET);
    two = new ApiProcess(SECRET);
    const states = await Promise.all([one.ready, two.ready]);
    expect(states.map((s) => s.redis)).toEqual(["ready", "ready"]);
  }, 30_000);
  afterAll(async () => {
    await Promise.all(all().map((p) => p.stop()));
    admin.disconnect();
  });

  it("1+2. same secret -> same HMAC keys in both processes; failures and the mailbox lock are shared", async () => {
    const o = org(1);
    for (let n = 0; n < IMAP_LOGIN_LOCKOUT.mailbox.maxFailures; n += 1) {
      const reply = await (n % 2 ? two : one).test({ org: o, user: user(n % 2), outcome: "auth" });
      expect(reply.code).toBe("IMAP_AUTH_FAILED");
    }
    expect(await admin.exists(mailboxLockKey(o))).toBe(1);
    expect(await admin.pttl(mailboxLockKey(o))).toBeGreaterThan(IMAP_LOGIN_LOCKOUT.mailbox.lockMs - 60_000);
    const before = await opensOf(one, two);
    expect((await one.test({ org: o, user: user(5), outcome: "ok" })).code).toBe("IMAP_LOGIN_LOCKED");
    expect((await two.test({ org: o, user: user(6), outcome: "ok", port: 143, username: "VENTAS@Empresa-Correo.com" })).code).toBe("IMAP_LOGIN_LOCKED");
    expect(await opensOf(one, two)).toBe(before);
    // One global key for that mailbox (both processes computed the same HMAC), holding the 10 refused logins.
    expect(await admin.get(globalKeyOf())).toBe("10");
    const ttl = await admin.pttl(globalKeyOf());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IMAP_CONNECTION_LIMITS.perMailboxGlobal.windowMs);
  });

  it("3. rotation: a process with another secret computes other keys, so the lock does not apply there", async () => {
    const rotated = new ApiProcess(randomBytes(32).toString("base64"));
    try {
      await rotated.ready;
      const reply = await rotated.test({ org: org(1), user: user(7), outcome: "ok" });
      expect(reply.code).toBe("OK");
    } finally {
      await rotated.stop();
    }
  });

  it("4+5. global budget across processes under concurrency: exactly 30 refused logins reach a server, the rest never connect", async () => {
    const target = { host: "imap.global-race.example-mail.com" };
    await admin.del(globalKeyOf(target.host));
    const before = await opensOf(one, two);
    const codes: string[] = [];
    // Waves of 8 simultaneous requests (4 per process: the per-instance cap), each from its own organization.
    for (let wave = 0; wave < 6; wave += 1) {
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 ? two : one).test({ org: org(100 + wave * 8 + i), user: user(100 + wave * 8 + i), outcome: "auth", ...target }))
      );
      codes.push(...replies.map((r) => r.code!));
    }
    const count = (code: string) => codes.filter((c) => c === code).length;
    expect(count("IMAP_AUTH_FAILED")).toBe(IMAP_CONNECTION_LIMITS.perMailboxGlobal.maxRefusedLogins);
    expect(count("IMAP_TEST_RATE_LIMITED")).toBe(48 - IMAP_CONNECTION_LIMITS.perMailboxGlobal.maxRefusedLogins);
    expect(await opensOf(one, two)).toBe(before + IMAP_CONNECTION_LIMITS.perMailboxGlobal.maxRefusedLogins);
    expect(await admin.get(globalKeyOf(target.host))).toBe(String(IMAP_CONNECTION_LIMITS.perMailboxGlobal.maxRefusedLogins));
  });

  it("4. per-organization slot across processes: two simultaneous tests of one organization -> exactly one runs", async () => {
    const o = org(300);
    const replies = await Promise.all([
      one.test({ org: o, user: user(300), outcome: "slow", host: "imap.slot.example-mail.com" }),
      two.test({ org: o, user: user(301), outcome: "slow", host: "imap.slot.example-mail.com" })
    ]);
    expect(replies.map((r) => r.code).sort()).toEqual(["IMAP_TEST_BUSY", "OK"]);
    expect(await admin.get(`emailbot-imap-busy:org:${o}`)).toBe("0");
  });

  it("per-user and per-organization attempt counters are shared and atomic across processes", async () => {
    const o = org(400);
    const replies = await Promise.all(
      Array.from({ length: 14 }, (_, i) => (i % 2 ? two : one).test({ org: o, user: user(400), outcome: "dns", host: `h${i}.example-mail.com` }))
    );
    const codes = replies.map((r) => r.code);
    expect(codes.filter((c) => c === "IMAP_TEST_RATE_LIMITED")).toHaveLength(14 - IMAP_CONNECTION_LIMITS.perUser.max);
    expect(await admin.get(`emailbot-imap-attempt:user:${user(400)}`)).toBe("14");
    const ttl = await admin.pttl(`emailbot-imap-attempt:user:${user(400)}`);
    expect(ttl).toBeGreaterThan(IMAP_CONNECTION_LIMITS.perUser.windowMs - 60_000);
  });

  it("7. password failures are told apart: DNS / TLS / timeout never touch the lockout nor keep a global reservation", async () => {
    const o = org(500);
    const host = "imap.kinds.example-mail.com";
    const kinds: Array<[string, string]> = [["dns", "IMAP_DNS_FAILED"], ["tls", "IMAP_TLS_FAILED"], ["timeout", "IMAP_TIMEOUT"]];
    for (const [outcome, code] of kinds) expect((await one.test({ org: o, user: user(500), outcome, host })).code).toBe(code);
    expect(await admin.exists(mailboxFailKey(o, host))).toBe(0);
    expect(await admin.exists(`emailbot-imap-login:fail:org:${o}`)).toBe(0);
    expect(Number((await admin.get(globalKeyOf(host))) ?? 0)).toBe(0);
    expect((await two.test({ org: o, user: user(501), outcome: "auth", host })).code).toBe("IMAP_AUTH_FAILED");
    expect(await admin.get(mailboxFailKey(o, host))).toBe("1");
    expect(await admin.get(`emailbot-imap-login:fail:org:${o}`)).toBe("1");
    expect(await admin.get(globalKeyOf(host))).toBe("1");
  });

  it("8. expiry: once the lock and the window end (TTL shortened ON THIS THROWAWAY SERVER), the mailbox works again", async () => {
    const o = org(1);
    expect((await one.test({ org: o, user: user(8), outcome: "ok" })).code).toBe("IMAP_LOGIN_LOCKED");
    // Simulates the passage of 15 minutes: PEXPIRE on the lock and the global window of this mailbox only.
    await admin.pexpire(mailboxLockKey(o), 50);
    await admin.pexpire(globalKeyOf(), 50);
    await sleep(150);
    expect((await one.test({ org: o, user: user(8), outcome: "ok" })).code).toBe("OK");
  });

  it("6. Redis not answering (CLIENT PAUSE): 503 within the store deadline, before DNS or any socket", async () => {
    const before = { opens: await opensOf(one, two), resolves: await resolvesOf(one, two) };
    await admin.client("PAUSE", 3_500, "ALL");
    try {
      const replies = await Promise.all([one.test({ org: org(600), user: user(600), outcome: "ok", host: "imap.pause.example-mail.com" }), two.test({ org: org(601), user: user(601), outcome: "auth", host: "imap.pause.example-mail.com" })]);
      for (const reply of replies) {
        expect([reply.status, reply.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
        expect(reply.ms!).toBeGreaterThanOrEqual(IMAP_CONNECTION_LIMITS.storeTimeoutMs - 100);
        expect(reply.ms!).toBeLessThan(IMAP_CONNECTION_LIMITS.storeTimeoutMs + 1_500);
      }
    } finally {
      await sleep(3_700);
    }
    expect({ opens: await opensOf(one, two), resolves: await resolvesOf(one, two) }).toEqual(before);
  }, 20_000);

  it("6. a store error (a corrupted key) is a 503, never a bypass nor a wrong password", async () => {
    const host = "imap.corrupted.example-mail.com";
    await admin.set(globalKeyOf(host), "not-a-number");
    const before = await opensOf(one, two);
    const reply = await one.test({ org: org(700), user: user(700), outcome: "ok", host });
    expect([reply.status, reply.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(await opensOf(one, two)).toBe(before);
    expect(await admin.get(`emailbot-imap-busy:org:${org(700)}`)).toBe("0");
    await admin.del(globalKeyOf(host));
  });

  it("9. logs of both processes and the keys never reveal the password, the secret, usernames or hosts", async () => {
    const logs = [...(await one.logs()), ...(await two.logs())].join("\n");
    expect(logs).toContain("imap.connection_test");
    expect(logs).toContain("imap.limits_unavailable");
    for (const forbidden of [PASSWORD, SECRET, USERNAME, HOST, "empresa-correo", imapMailboxGlobalKey(secretBytes, HOST, USERNAME).split(":")[1]!]) {
      expect(logs).not.toContain(forbidden);
    }
    const keys = await admin.keys("emailbot-imap*");
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.join(" ")).not.toMatch(/ventas|hostinger|empresa|correo|example-mail/i);
  });
});

describe.runIf(enabled && PHASE === "up")("Valkey (real): routes with the real client", () => {
  const owner = makeUser({ [ORG_A]: "OWNER" });

  it("production configuration (IMAP disabled): both routes 503 IMAP_NOT_AVAILABLE, no IMAP key written in Valkey", async () => {
    const redis = createRedisConnection(URL_ENV, { forProducer: true });
    await new Promise((resolve) => redis.once("ready", resolve));
    const admin = new Redis(URL_ENV, { maxRetriesPerRequest: 1 });
    const before = (await admin.keys("emailbot-imap*")).sort();
    const ctx = await createTestApp({ users: [owner], rateLimitRedis: redis });
    try {
      for (const url of ["/api/email-accounts/imap/test", "/api/email-accounts/imap"]) {
        const response = await ctx.app.inject({ method: "POST", url, headers: authHeaders(owner, ORG_A), payload: { password: PASSWORD } });
        expect([response.statusCode, response.json().error.code]).toEqual([503, "IMAP_NOT_AVAILABLE"]);
      }
      expect((await admin.keys("emailbot-imap*")).sort()).toEqual(before);
    } finally {
      await ctx.app.close();
      redis.disconnect();
      admin.disconnect();
    }
  });

  it("TEST configuration (IMAP enabled only here): the creation route works end to end on the real client", async () => {
    const redis = createRedisConnection(URL_ENV, { forProducer: true });
    await new Promise((resolve) => redis.once("ready", resolve));
    const open = vi.fn(async (_o: unknown, _l: unknown, onClient: (c: unknown) => void) => {
      const client = {
        mailbox: false as unknown,
        async getMailboxLock(path: string) {
          client.mailbox = { path, readOnly: true, uidValidity: 3n, uidNext: 10 };
          return { path, release: () => undefined };
        },
        logout: async () => undefined,
        close: () => undefined
      };
      onClient(client);
      return client;
    });
    const ctx = await createTestApp({
      users: [owner],
      config: { imapAccountsEnabled: true, imapOrganizationIds: [ORG_A] },
      rateLimitRedis: redis,
      imapResolver: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      imapProbeOpen: open as never
    });
    try {
      ctx.repos.emailAccounts.list.mockResolvedValue([]);
      ctx.privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: { id: "a" }, created: true, previousStatus: null } as never);
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/email-accounts/imap",
        headers: authHeaders(owner, ORG_A),
        payload: { emailAddress: "route@example-mail.com", host: "imap.route.example-mail.com", port: 993, security: "TLS", username: "route@example-mail.com", password: PASSWORD }
      });
      expect(response.statusCode).toBe(201);
      expect(ctx.privileged.connectImapEmailAccount.mock.calls[0]?.[0]).toMatchObject({ syncCursor: "imap:v1:3:9" });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.app.close();
      redis.disconnect();
    }
  });
});

/* ================================================================ phase "down" */

describe.runIf(enabled && PHASE === "down")("Valkey stopped: IMAP checks refuse before any DNS query or socket", () => {
  const owner = makeUser({ [ORG_A]: "OWNER" });

  it("two processes: 503 quickly, no simulated DNS / IMAP reached", async () => {
    const one = new ApiProcess(SECRET);
    const two = new ApiProcess(SECRET);
    try {
      const states = await Promise.all([one.ready, two.ready]);
      expect(states.every((s) => s.redis !== "ready")).toBe(true);
      const replies = await Promise.all([one.test({ org: org(800), user: user(800), outcome: "ok" }), two.test({ org: org(801), user: user(801), outcome: "auth" })]);
      for (const reply of replies) {
        expect([reply.status, reply.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
        expect(reply.ms!).toBeLessThan(IMAP_CONNECTION_LIMITS.storeTimeoutMs + 1_000);
      }
      expect(await opensOf(one, two)).toBe(0);
      expect(await resolvesOf(one, two)).toBe(0);
    } finally {
      await Promise.all([one.stop(), two.stop()]);
    }
  }, 30_000);

  it("route with the real client (IMAP enabled in TEST config): 503, no DNS, socket, encryption, persistence or queue", async () => {
    const redis = createRedisConnection(URL_ENV, { forProducer: true });
    redis.on("error", () => undefined);
    const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const open = vi.fn();
    const ctx = await createTestApp({ users: [owner], config: { imapAccountsEnabled: true, imapOrganizationIds: [ORG_A] }, rateLimitRedis: redis, imapResolver: resolver, imapProbeOpen: open as never });
    try {
      ctx.repos.emailAccounts.list.mockResolvedValue([]);
      const spies = ["encrypt", "encryptBound", "decrypt", "decryptBound"].map((m) => vi.spyOn(ctx.deps.secretBox, m as never));
      for (const url of ["/api/email-accounts/imap/test", "/api/email-accounts/imap"]) {
        const started = Date.now();
        const response = await ctx.app.inject({
          method: "POST",
          url,
          headers: authHeaders(owner, ORG_A),
          payload: { emailAddress: USERNAME, host: HOST, port: 993, security: "TLS", username: USERNAME, password: PASSWORD }
        });
        expect([response.statusCode, response.json().error.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
        expect(response.body).not.toMatch(/password|contraseña|refused the/i);
        expect(Date.now() - started).toBeLessThan(IMAP_CONNECTION_LIMITS.storeTimeoutMs + 6_000);
      }
      expect(resolver).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(ctx.privileged.connectImapEmailAccount).not.toHaveBeenCalled();
      expect(ctx.queue.enqueueEmailEvent).not.toHaveBeenCalled();
    } finally {
      await ctx.app.close();
      redis.disconnect();
    }
  }, 30_000);
});

describe.runIf(!enabled)("IMAP Valkey integration (skipped)", () => {
  it.skip("runs only with IMAP_VALKEY_URL pointing at a throwaway Valkey (see docs/imap.md)", () => undefined);
});

