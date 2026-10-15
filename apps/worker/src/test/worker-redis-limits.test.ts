import { randomBytes } from "node:crypto";
import type { EmailProcessingJob } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import { AppRedisError, appRedisOptions, createAppRedis, redisOutcome, withRedisDeadline, type AppRedis } from "../infrastructure/app-redis.js";
import { readiness } from "../infrastructure/health.js";
import { createAppRealtimePublisher } from "../infrastructure/supabase-stores.js";
import { createAppRedisSyncLock, createRedisSyncLock } from "../infrastructure/sync-lock.js";
import { handleAccountFailure } from "../pipeline/failures.js";
import { syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import type { WorkerAccount } from "../providers/types.js";
import { refusedPort, startFakeRespServer, type FakeRespServer } from "./fake-resp-server.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRegistry, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";

/*
 * F5.2: the bounded application Redis clients (infrastructure/app-redis.ts) against a scripted RESP server on
 * 127.0.0.1 (fake-resp-server.ts: no real Redis). The real Valkey / BullMQ scenarios are in
 * worker-redis-limits-valkey.test.ts (opt-in).
 */

const LIMIT_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const open: Array<{ stop(): Promise<void> } | AppRedis> = [];

async function server(mode: FakeRespServer["mode"]) {
  const fake = await startFakeRespServer(mode);
  open.push(fake);
  return fake;
}
function client(url: string) {
  const app = createAppRedis(url, LIMIT_MS);
  app.client.on("error", () => undefined);
  open.push(app);
  return app;
}
async function ready(app: AppRedis) {
  await vi.waitFor(() => expect(app.client.status).toBe("ready"), { timeout: 3_000, interval: 10 });
}
async function timed<T>(work: () => Promise<T>) {
  const started = Date.now();
  try {
    await work();
    return { error: null as unknown, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}
const names = (fake: FakeRespServer) => fake.received.map(([name]) => name).filter((name) => !["info", "client", "hello", "select"].includes(name ?? ""));

afterEach(async () => {
  for (const item of open.splice(0)) {
    if ("client" in item) item.client.disconnect();
    else await item.stop();
  }
});

describe("F5.2: bounded application Redis clients", () => {
  it("options: command timeout, no offline queue, no re-sending, no per-request retries (BullMQ's connection is not built here)", () => {
    expect(appRedisOptions(5_000)).toEqual({ commandTimeout: 5_000, enableOfflineQueue: false, autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0 });
  });

  it("1. Redis answers: the sync lock, realtime publishing and PING work normally", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    const lock = createAppRedisSyncLock(app);
    const token = await lock.acquire("acc-1", 60_000);
    expect(token).toEqual(expect.any(String));
    expect(await lock.acquire("acc-1", 60_000)).toBeNull(); // held: a second run does not get it
    await lock.release("acc-1", token as string);
    expect(await lock.acquire("acc-1", 60_000)).toEqual(expect.any(String));
    await createAppRealtimePublisher(app).publish({ type: "email-account.status", organizationId: "o", emailAccountId: "a", status: "ERROR" });
    expect(await app.client.ping()).toBe("PONG");
    expect(names(fake)).toEqual(["set", "set", "eval", "set", "publish", "ping"]);
  });

  it("2. Redis refuses connections: every command fails within the limit, NOT sent (never a success)", async () => {
    const app = client(`redis://127.0.0.1:${await refusedPort()}`);
    const lock = createAppRedisSyncLock(app);
    const acquire = await timed(() => lock.acquire("acc-1", 60_000));
    const publish = await timed(() => createAppRealtimePublisher(app).publish({ type: "notification", organizationId: "o", emailId: "e", title: "t", body: "b" }));
    for (const result of [acquire, publish]) {
      expect(result.error).toBeInstanceOf(AppRedisError);
      expect(redisOutcome(result.error)).toBe("not_sent");
      expect(result.ms).toBeLessThan(LIMIT_MS + 300);
    }
  });

  it("3. Redis accepts the connection and never answers (not even the ready check): not ready, NOT sent, within the limit", async () => {
    const fake = await server("silent-all");
    const app = client(fake.url);
    const result = await timed(() => createAppRedisSyncLock(app).acquire("acc-1", 60_000));
    expect(result.error).toBeInstanceOf(AppRedisError);
    expect(redisOutcome(result.error)).toBe("not_sent");
    expect(result.ms).toBeGreaterThanOrEqual(LIMIT_MS - 20);
    expect(result.ms).toBeLessThan(LIMIT_MS + 300);
    expect(names(fake)).toEqual([]); // nothing but the handshake reached the server
  });

  it("3b. 20 commands waiting for the connection at once (the worker's concurrency) share ONE pair of ready / end listeners: no listener warning, all fail within the limit, nothing left after disconnect", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => void warnings.push(warning.name);
    process.on("warning", onWarning);
    try {
      const fake = await server("silent-all");
      const app = client(fake.url);
      const started = Date.now();
      const runs = Array.from({ length: 20 }, () => app.run("ping", (redis) => redis.ping()).catch((error: unknown) => redisOutcome(error)));
      const peak = { ready: app.client.listenerCount("ready"), end: app.client.listenerCount("end") };
      const outcomes = await Promise.all(runs);
      expect(Date.now() - started).toBeLessThan(LIMIT_MS + 300);
      expect(outcomes).toEqual(Array.from({ length: 20 }, () => "not_sent"));
      expect(peak).toEqual({ ready: 1, end: 1 });
      app.client.disconnect();
      await vi.waitFor(() => expect(app.client.status).toBe("end"));
      expect({ ready: app.client.listenerCount("ready"), end: app.client.listenerCount("end") }).toEqual({ ready: 0, end: 0 });
      await sleep(20);
      expect(warnings).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("4 + 5. connected, then Redis stops answering: the acquire fails within the limit with an UNKNOWN result, no lease is returned, our token is released after the SET, and nothing is re-sent after a reconnection", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    await ready(app);
    fake.mode = "paused";
    const result = await timed(() => createAppRedisSyncLock(app).acquire("acc-1", 60_000));
    expect(result.error).toBeInstanceOf(AppRedisError);
    expect(redisOutcome(result.error)).toBe("unknown");
    expect(result.ms).toBeGreaterThanOrEqual(LIMIT_MS - 20);
    expect(result.ms).toBeLessThan(LIMIT_MS + 300);
    await vi.waitFor(() => expect(names(fake)).toEqual(["set", "eval"]));
    const set = fake.received.find(([name]) => name === "set")!;
    const release = fake.received.find(([name]) => name === "eval")!;
    expect(release.slice(-2)).toEqual([set[1], set[2]]); // same key, same token: compare-and-delete of OUR lease only
    // The connection drops and comes back: the timed-out commands are never sent again.
    fake.mode = "answer";
    fake.dropConnections();
    await sleep(100);
    await ready(app);
    expect(await app.client.ping()).toBe("PONG");
    expect(names(fake)).toEqual(["set", "eval", "ping"]);
  });

  it("Redis answers with an error: result REJECTED (definitive), no compensation; the acquire still fails", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    await ready(app);
    fake.mode = "error";
    const result = await timed(() => createAppRedisSyncLock(app).acquire("acc-1", 60_000));
    expect(result.error).toBeInstanceOf(AppRedisError);
    expect(redisOutcome(result.error)).toBe("rejected");
    expect(names(fake)).toEqual(["set"]);
  });

  it("the compensating release runs only for an UNKNOWN result (fakes)", async () => {
    for (const outcome of ["unknown", "not_sent", "rejected"] as const) {
      const release = vi.fn(async () => 1);
      const lock = createRedisSyncLock({ set: async () => Promise.reject(new AppRedisError("sync lock acquire", outcome, new Error("x"))), eval: release });
      await expect(lock.acquire("acc-1", 1_000)).rejects.toBeInstanceOf(AppRedisError);
      expect(release).toHaveBeenCalledTimes(outcome === "unknown" ? 1 : 0);
    }
  });

  it("5. a lock that could not be acquired never lets a sync continue: nothing listed, cursor unchanged; the failure is transient (no account error)", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    await ready(app);
    fake.mode = "paused";
    const account = makeAccount({ syncCursor: "100" });
    const store = makeAccountStore([account]);
    const adapter = makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["m1"], nextCursor: "120" })) });
    const processMessage = vi.fn();
    const deps: HandleEventDeps = {
      accounts: store, emails: new MemoryEmailStore(), producer: makeProducer(), providers: makeRegistry(adapter),
      createContext: (worker) => ({ account: worker, getAccessToken: async () => "t" }),
      enqueueSync: vi.fn(async () => undefined), processMessage, lock: createAppRedisSyncLock(app), audit: makeAudit(), logger: silentLogger
    };
    const error = await syncAccount(account, deps, "POLL").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppRedisError);
    expect(adapter.listNewMessageIds).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
    expect(store.advanceSyncCursor).not.toHaveBeenCalled();
    // The job's failure handling rethrows it as is: BullMQ retries the job; the account is not marked ERROR.
    await expect(handleAccountFailure(error, account, { accounts: store, realtime: { publish: vi.fn() }, logger: silentLogger })).rejects.toBe(error);
    expect(store.markError).not.toHaveBeenCalled();
  });

  it("6. a realtime publish that fails or times out fails the processing: the email is NOT PROCESSED; the retry publishes and completes it once", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    await ready(app);
    const account = makeAccount();
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
    const deps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]), emails, routing: new MemoryRoutingStore(emails), audit: makeAudit(),
      storage: { exists: vi.fn(async () => false), upload: vi.fn(async () => undefined) },
      realtime: createAppRealtimePublisher(app), producer: makeProducer(), providers: makeRegistry(makeAdapter()) as never,
      createContext: (worker: WorkerAccount) => ({ account: worker, getAccessToken: async () => "t" }),
      attachmentsBucket: "email-attachments", maxAttachmentBytes: 1_000_000, storageRetryDelayMs: 0, logger: silentLogger
    };
    const job: EmailProcessingJob = { organizationId: account.organizationId, emailAccountId: account.id, provider: "GMAIL", providerMessageId: "m-1" };
    fake.mode = "paused";
    const failed = await timed(() => processEmail(job, deps, { attempt: 1 }));
    expect(failed.error).toBeInstanceOf(AppRedisError);
    expect(redisOutcome(failed.error)).toBe("unknown");
    expect(failed.ms).toBeLessThan(LIMIT_MS + 1_000);
    expect(emails.rows).toHaveLength(1);
    expect(emails.rows[0]?.processing_status).not.toBe("PROCESSED");
    fake.resume(); // the late answer of the timed-out PUBLISH arrives (ignored: that command already failed)
    fake.mode = "error";
    await expect(processEmail(job, deps, { attempt: 2 })).rejects.toBeInstanceOf(AppRedisError);
    expect(emails.rows[0]?.processing_status).not.toBe("PROCESSED");
    fake.mode = "answer";
    await processEmail(job, deps, { attempt: 3 });
    expect(emails.rows).toHaveLength(1);
    expect(emails.rows[0]?.processing_status).toBe("PROCESSED");
  });

  it("health: /readyz is not ready within its 1 s probe when Redis stops answering, and every PING settles (rejected) at the command limit", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    await ready(app);
    fake.mode = "paused";
    const state = { initialized: true, failed: false, stopping: false };
    const pings: Array<Promise<unknown>> = [];
    const pingRedis = async () => {
      const ping = app.client.ping();
      pings.push(ping);
      return app.client.status === "ready" && (await ping) === "PONG";
    };
    const started = Date.now();
    const reports = await Promise.all([1, 2, 3].map(() => readiness({ state, pingRedis })));
    expect(reports.map((report) => report.status)).toEqual(["not_ready", "not_ready", "not_ready"]);
    expect(Date.now() - started).toBeLessThan(1_300);
    // No promise is left pending: each PING is rejected at the command limit ("Command timed out"). ioredis keeps
    // the rejected entries until Redis answers or the connection closes, to match the late replies (documented).
    const settled = await Promise.race([Promise.allSettled(pings), sleep(LIMIT_MS + 300).then(() => null)]);
    expect(settled?.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("7 (bounded call). withRedisDeadline: result as is, other errors as is, UNKNOWN past the deadline", async () => {
    await expect(withRedisDeadline("op", 200, async () => "ok")).resolves.toBe("ok");
    const own = new Error("bullmq failure");
    await expect(withRedisDeadline("op", 200, async () => Promise.reject(own))).rejects.toBe(own);
    const result = await timed(() => withRedisDeadline("enqueue processing", 200, () => new Promise(() => undefined)));
    expect(result.error).toBeInstanceOf(AppRedisError);
    expect(result.error).toMatchObject({ operation: "enqueue processing", outcome: "unknown" });
    expect(result.ms).toBeGreaterThanOrEqual(190);
    expect(result.ms).toBeLessThan(500);
  });

  it("11. after disconnect(): status end, no reconnection, commands rejected at once (not sent)", async () => {
    const fake = await server("answer");
    const app = client(fake.url);
    await ready(app);
    app.client.disconnect();
    await vi.waitFor(() => expect(app.client.status).toBe("end"));
    const result = await timed(() => app.run("ping", (redis) => redis.ping()));
    expect(redisOutcome(result.error)).toBe("not_sent");
    expect(result.ms).toBeLessThan(50);
    const before = fake.received.length;
    await sleep(300);
    expect(fake.received.length).toBe(before);
  });

  it("config: WORKER_REDIS_COMMAND_TIMEOUT_MS 5000 by default, 500..30000; IMAP stays disabled", () => {
    const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };
    expect(loadWorkerConfig(base).redisCommandTimeoutMs).toBe(5_000);
    expect(loadWorkerConfig({ ...base, WORKER_REDIS_COMMAND_TIMEOUT_MS: "2000" }).redisCommandTimeoutMs).toBe(2_000);
    for (const bad of ["499", "30001", "1500.5", "abc"]) {
      expect(() => loadWorkerConfig({ ...base, WORKER_REDIS_COMMAND_TIMEOUT_MS: bad })).toThrow(/WORKER_REDIS_COMMAND_TIMEOUT_MS/);
    }
    expect(loadWorkerConfig(base).imapSyncEnabled).toBe(false);
  });
});
