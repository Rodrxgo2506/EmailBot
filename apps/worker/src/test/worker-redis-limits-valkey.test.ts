import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QUEUE_NAMES, type EmailProcessingJob } from "@emailbot/shared";
import { REALTIME_REDIS_CHANNEL } from "@emailbot/types";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppRedisError, createAppRedis, redisOutcome, type AppRedis } from "../infrastructure/app-redis.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import { createWorkerQueues } from "../infrastructure/queues.js";
import { createJobTracker, createShutdown, shutdownLimits } from "../infrastructure/shutdown.js";
import { createAppRealtimePublisher } from "../infrastructure/supabase-stores.js";
import { createAppRedisSyncLock } from "../infrastructure/sync-lock.js";
import { syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import type { RealtimePublisher } from "../pipeline/ports.js";
import type { WorkerAccount } from "../providers/types.js";
import { claimThrowawayValkey, cleanupSteps, releaseClaimedValkey, resetClaimedValkey, type CleanupSteps } from "./a2-bullmq-target.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeRealtime, makeRegistry, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";
import { startFreezeProxy } from "./freeze-proxy.js";

/*
 * F5.2 - the bounded application Redis clients and the bounded queue producers against a THROWAWAY Valkey
 * (opt-in: A2_BULLMQ_URL, guarded by valkey-target.ts and a2-bullmq-target.ts; run in series with the other
 * BullMQ suites, --no-file-parallelism). "Redis stops answering" / "refuses connections" is a loopback proxy
 * (freeze-proxy.ts) in front of it: frozen bytes are held, not lost, so late execution is observable.
 */

const RAW_URL = process.env.A2_BULLMQ_URL ?? "";
const enabled = RAW_URL !== "";
const guard = enabled ? ((await import(new URL("../../../api/src/test/valkey-target.ts", import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string }) : null;
const TARGET = guard ? guard.assertLocalValkeyUrl(RAW_URL) : "";
const SUITE = "worker-redis-limits-valkey";
const LIMIT_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) };
const CHILD = fileURLToPath(new URL("./fixtures/redis-clients-child.ts", import.meta.url));

async function timed<T>(work: () => Promise<T>) {
  const started = Date.now();
  try {
    return { value: await work(), error: null as unknown, ms: Date.now() - started };
  } catch (error) {
    return { value: null, error, ms: Date.now() - started };
  }
}

describe.runIf(enabled)("F5.2: bounded application Redis clients with a real Valkey", () => {
  let admin: Redis;
  const target = enabled ? { host: new URL(TARGET).hostname, port: Number(new URL(TARGET).port) } : { host: "", port: 0 };

  beforeAll(async () => {
    admin = new Redis(TARGET, { maxRetriesPerRequest: null });
    await claimThrowawayValkey(admin, SUITE);
  });
  afterAll(async () => {
    if (admin) await releaseClaimedValkey(admin, SUITE).finally(() => admin.quit());
  });

  async function scenario<T>(run: (cleanup: CleanupSteps) => Promise<T>): Promise<T> {
    await resetClaimedValkey(admin, SUITE);
    const cleanup = cleanupSteps();
    try {
      return await run(cleanup);
    } finally {
      await cleanup.run();
    }
  }
  function app(cleanup: CleanupSteps, url: string, limitMs = LIMIT_MS): AppRedis {
    const client = createAppRedis(url, limitMs);
    client.client.on("error", () => undefined);
    cleanup.defer(() => client.client.disconnect());
    return client;
  }
  async function proxy(cleanup: CleanupSteps) {
    const frozen = await startFreezeProxy(target);
    cleanup.defer(() => frozen.stop());
    return frozen;
  }
  /** Calls of `command` since the last CONFIG RESETSTAT (INFO commandstats). */
  async function calls(command: string): Promise<number> {
    const info = await admin.info("commandstats");
    return Number(new RegExp(`cmdstat_${command}:calls=(\\d+)`).exec(info)?.[1] ?? 0);
  }

  function processDeps(options: { realtime: RealtimePublisher; producer: ProcessEmailDeps["producer"]; emails: MemoryEmailStore; accounts: WorkerAccount[] }): Omit<ProcessEmailDeps, "logger"> {
    options.emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
    return {
      accounts: makeAccountStore(options.accounts), emails: options.emails, routing: new MemoryRoutingStore(options.emails), audit: makeAudit(),
      storage: { exists: vi.fn(async () => false), upload: vi.fn(async () => undefined) },
      realtime: options.realtime, producer: options.producer, providers: makeRegistry(makeAdapter()) as never,
      createContext: (account: WorkerAccount) => ({ account, getAccessToken: async () => "t" }),
      attachmentsBucket: "email-attachments", maxAttachmentBytes: 1_000_000, storageRetryDelayMs: 0
    };
  }

  it("1 + 8 + 10. Redis answers: Gmail / Microsoft sync (application lock) and processing (application publisher, bounded producers, BullMQ worker) work as before; BullMQ keeps its own connection settings", async () => {
    const run = await scenario(async (cleanup) => {
      const connection = new Redis(TARGET, { maxRetriesPerRequest: null });
      cleanup.defer(() => connection.quit());
      const appRedis = app(cleanup, TARGET);
      const publisher = app(cleanup, TARGET);
      const subscriber = new Redis(TARGET);
      cleanup.defer(() => subscriber.quit());
      const published: string[] = [];
      subscriber.on("message", (_channel: string, message: string) => published.push(JSON.parse(message).type));
      await subscriber.subscribe(REALTIME_REDIS_CHANNEL);
      const queues = createWorkerQueues(connection, { producerTimeoutMs: LIMIT_MS });
      cleanup.defer(() => queues.close());
      const accounts = [makeAccount({ id: "gmail-1", provider: "GMAIL", syncCursor: "100" }), makeAccount({ id: "microsoft-1", provider: "MICROSOFT", emailAddress: "m@outlook.com", syncCursor: "200" })];
      const emails = new MemoryEmailStore();
      const deps = processDeps({ realtime: createAppRealtimePublisher(publisher), producer: queues.producer, emails, accounts });
      // Sync path: the per-account lease on the application client, for both providers.
      const store = makeAccountStore(accounts);
      const syncDeps: HandleEventDeps = {
        accounts: store, emails, producer: queues.producer, providers: makeRegistry(makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["s1", "s2"], nextCursor: "300" })) })),
        createContext: (account) => ({ account, getAccessToken: async () => "t" }), enqueueSync: (account, reason) => queues.enqueueSync(account, reason),
        processMessage: (job) => processEmail(job, { ...deps, accounts: store, logger: silentLogger }, { attempt: 1 }),
        lock: createAppRedisSyncLock(appRedis), audit: makeAudit(), logger: silentLogger
      };
      for (const account of accounts) await syncAccount(account, syncDeps, "POLL");
      const leasesAfterSync = await admin.keys("emailbot-sync-lock:*");
      // Processing path: a real BullMQ worker on BullMQ's connection.
      const processors = createJobProcessors({ eventDeps: {} as never, processDeps: deps, accounts: deps.accounts, realtime: makeRealtime(), logger: logger as never, reportJobFailure: vi.fn(), jobType: () => "process-email" });
      const worker = new Worker<EmailProcessingJob>(QUEUE_NAMES.emailProcessing, processors.processing, { connection, concurrency: 5 });
      cleanup.defer(() => worker.close(true));
      worker.on("error", () => undefined);
      for (let n = 0; n < 5; n++) await queues.producer.enqueueProcessing({ organizationId: accounts[0]!.organizationId, emailAccountId: "gmail-1", provider: "GMAIL", providerMessageId: `g-${n}` });
      for (let n = 0; n < 5; n++) await queues.producer.enqueueProcessing({ organizationId: accounts[1]!.organizationId, emailAccountId: "microsoft-1", provider: "MICROSOFT", providerMessageId: `m-${n}` });
      await vi.waitFor(() => expect(emails.rows.filter((row) => row.processing_status === "PROCESSED")).toHaveLength(14), { timeout: 15_000 });
      await vi.waitFor(() => expect(published.filter((type) => type === "email.processed")).toHaveLength(14), { timeout: 5_000 });
      return {
        processed: emails.rows.filter((row) => row.processing_status === "PROCESSED").length,
        cursors: (store.advanceSyncCursor as ReturnType<typeof vi.fn>).mock.calls.length,
        leasesAfterSync: leasesAfterSync.length,
        published: published.length,
        completed: await queues.emailProcessing.getCompletedCount(),
        notifications: Object.values(await queues.notifications.getJobCounts("waiting", "delayed", "completed", "active")).reduce((sum, n) => sum + n, 0),
        bullmq: { maxRetriesPerRequest: connection.options.maxRetriesPerRequest, enableOfflineQueue: connection.options.enableOfflineQueue, commandTimeout: connection.options.commandTimeout ?? null, sameConnection: worker.opts.connection === connection },
        application: { maxRetriesPerRequest: appRedis.client.options.maxRetriesPerRequest, enableOfflineQueue: appRedis.client.options.enableOfflineQueue, commandTimeout: appRedis.client.options.commandTimeout }
      };
    });
    console.log("F5.2 (1, 8, 10):", JSON.stringify(run));
    expect(run).toMatchObject({ processed: 14, cursors: 2, leasesAfterSync: 0, completed: 10 });
    expect(run.notifications).toBe(14);
    expect(run.bullmq).toEqual({ maxRetriesPerRequest: null, enableOfflineQueue: true, commandTimeout: null, sameConnection: true });
    expect(run.application).toEqual({ maxRetriesPerRequest: 0, enableOfflineQueue: false, commandTimeout: LIMIT_MS });
  }, 60_000);

  it("2 + 3 + 4 + 5. real Redis: refused / accepted-but-silent / silent-after-connect, each within the limit and never a success; a late SET runs before our compensating release (no orphan lease); nothing runs late from a refused period", async () => {
    const run = await scenario(async (cleanup) => {
      const frozen = await proxy(cleanup);
      const url = frozen.url(TARGET);
      const appRedis = app(cleanup, url);
      const lock = createAppRedisSyncLock(appRedis);
      expect(await appRedis.run("ping", (redis) => redis.ping())).toBe("PONG");
      await admin.config("RESETSTAT");
      // 4: connected, then Redis stops answering.
      frozen.freeze();
      const silent = await timed(() => lock.acquire("acc-late", 60_000));
      const duringFreeze = await admin.exists("emailbot-sync-lock:acc-late");
      // 3: a NEW connection while Redis does not answer (not even the ready check).
      const fresh = app(cleanup, url);
      const notReady = await timed(() => fresh.run("ping", (redis) => redis.ping()));
      // The held bytes reach Redis: the late SET, then our compensating compare-and-delete.
      frozen.thaw();
      await vi.waitFor(async () => expect(await calls("eval")).toBe(1), { timeout: 5_000 });
      const afterThaw = { set: await calls("set"), eval: await calls("eval"), lease: await admin.exists("emailbot-sync-lock:acc-late") };
      // Contrast (why the release is needed): a late SET without it leaves a lease until its TTL.
      frozen.freeze();
      await appRedis.client.set("emailbot-sync-lock:acc-orphan", "x", "PX", 60_000, "NX").catch(() => undefined);
      frozen.thaw();
      await vi.waitFor(async () => expect(await admin.exists("emailbot-sync-lock:acc-orphan")).toBe(1), { timeout: 5_000 });
      const orphanTtl = await admin.pttl("emailbot-sync-lock:acc-orphan");
      // 2: Redis refuses connections; nothing is queued for later.
      await vi.waitFor(() => expect(appRedis.client.status).toBe("ready"), { timeout: 5_000 });
      await admin.config("RESETSTAT");
      await frozen.refuse();
      // A command sent while the connection is being dropped: its result is unknown (it may have been written).
      const dropped = await timed(() => lock.acquire("acc-dropped", 60_000));
      // Once the client knows the connection is gone (reconnecting, refused): rejected at the limit, never sent.
      await vi.waitFor(() => expect(appRedis.client.status).not.toBe("ready"), { timeout: 5_000 });
      const refused = await timed(() => lock.acquire("acc-refused", 60_000));
      const publishRefused = await timed(() => createAppRealtimePublisher(appRedis).publish({ type: "notification", organizationId: "o", emailId: "e", title: "t", body: "b" }));
      await frozen.listen();
      await vi.waitFor(() => expect(appRedis.client.status).toBe("ready"), { timeout: 10_000 });
      await sleep(300);
      return {
        silent: { outcome: redisOutcome(silent.error), isError: silent.error instanceof AppRedisError, ms: silent.ms, duringFreeze },
        notReady: { outcome: redisOutcome(notReady.error), ms: notReady.ms },
        afterThaw,
        orphanTtl,
        dropped: { outcome: redisOutcome(dropped.error), isError: dropped.error instanceof AppRedisError, ms: dropped.ms },
        refused: { outcome: redisOutcome(refused.error), ms: refused.ms },
        publishRefused: { outcome: redisOutcome(publishRefused.error), ms: publishRefused.ms },
        lateAfterRefused: { set: await calls("set"), publish: await calls("publish"), leases: (await admin.keys("emailbot-sync-lock:acc-*ed")).length }
      };
    });
    console.log("F5.2 (2, 3, 4, 5):", JSON.stringify(run));
    expect(run.silent).toMatchObject({ outcome: "unknown", isError: true, duringFreeze: 0 });
    expect(run.silent.ms).toBeGreaterThanOrEqual(LIMIT_MS - 20);
    expect(run.silent.ms).toBeLessThan(LIMIT_MS + 500);
    expect(run.notReady.outcome).toBe("not_sent");
    expect(run.notReady.ms).toBeLessThan(LIMIT_MS + 500);
    expect(run.afterThaw).toEqual({ set: 1, eval: 1, lease: 0 });
    expect(run.orphanTtl).toBeGreaterThan(50_000);
    expect(run.dropped).toMatchObject({ outcome: "unknown", isError: true });
    expect(run.dropped.ms).toBeLessThan(LIMIT_MS + 500);
    expect(run.refused.outcome).toBe("not_sent");
    expect(run.refused.ms).toBeLessThan(LIMIT_MS + 500);
    expect(run.publishRefused.outcome).toBe("not_sent");
    expect(run.lateAfterRefused).toEqual({ set: 0, publish: 0, leases: 0 });
  }, 60_000);

  it("5b. lock with an UNKNOWN acquire: (a) SET ran, answer lost -> our token released on the same connection; (b) connection lost between SET and release -> released on the new one; (c) another holder's lease is never deleted; (d) residual: the release cannot reach Redis -> the late lease lasts only its TTL", async () => {
    const run = await scenario(async (cleanup) => {
      const frozen = await proxy(cleanup);
      const appRedis = app(cleanup, frozen.url(TARGET));
      const lock = createAppRedisSyncLock(appRedis);
      const key = (id: string) => `emailbot-sync-lock:${id}`;
      const isReady = () => vi.waitFor(() => expect(appRedis.client.status).toBe("ready"), { timeout: 5_000 });
      await isReady();
      await admin.config("RESETSTAT");
      // (a) Redis runs the SET; its answer never arrives in time.
      frozen.mute();
      const a = await timed(() => lock.acquire("acc-a", 60_000));
      await vi.waitFor(async () => expect(await calls("eval")).toBe(1), { timeout: 5_000 });
      const aAfter = { set: await calls("set"), eval: await calls("eval"), lease: await admin.exists(key("acc-a")) };
      frozen.unmute(); // the late answers arrive and are ignored (those commands already failed)
      // (b) The SET ran, then the connection is lost before the release.
      await isReady();
      frozen.mute();
      const pendingB = timed(() => lock.acquire("acc-b", 60_000));
      await vi.waitFor(async () => expect(await admin.exists(key("acc-b"))).toBe(1), { timeout: 5_000 });
      frozen.drop();
      frozen.unmute();
      const b = await pendingB;
      await vi.waitFor(async () => expect(await admin.exists(key("acc-b"))).toBe(0), { timeout: 5_000 });
      // (c) Another process holds the account: our late SET NX fails and our release (other token) deletes nothing.
      await isReady();
      await admin.set(key("acc-c"), "other-process-token", "PX", 60_000);
      frozen.mute();
      const c = await timed(() => lock.acquire("acc-c", 60_000));
      frozen.unmute();
      await sleep(200);
      const cAfter = { value: await admin.get(key("acc-c")), ttl: await admin.pttl(key("acc-c")) };
      // (d) The SET ran, then Redis cannot be reached at all: the release is never sent; the lease expires by itself.
      await isReady();
      frozen.mute();
      const pendingD = timed(() => lock.acquire("acc-d", 2_500));
      await vi.waitFor(async () => expect(await admin.exists(key("acc-d"))).toBe(1), { timeout: 5_000 });
      const setAt = Date.now();
      await frozen.refuse();
      const d = await pendingD;
      await sleep(LIMIT_MS + 200); // the compensating release gave up (not sent)
      const dHeld = await admin.exists(key("acc-d"));
      await vi.waitFor(async () => expect(await admin.exists(key("acc-d"))).toBe(0), { timeout: 5_000, interval: 50 });
      const dExpiredAfterMs = Date.now() - setAt;
      await frozen.listen();
      return {
        a: { outcome: redisOutcome(a.error), ms: a.ms, ...aAfter },
        b: { outcome: redisOutcome(b.error), isError: b.error instanceof AppRedisError, ms: b.ms },
        c: { outcome: redisOutcome(c.error), ...cAfter },
        d: { outcome: redisOutcome(d.error), heldAfterFailedRelease: dHeld, expiredAfterMs: dExpiredAfterMs }
      };
    });
    console.log("F5.2 (5b):", JSON.stringify(run));
    expect(run.a).toMatchObject({ outcome: "unknown", set: 1, eval: 1, lease: 0 });
    expect(run.a.ms).toBeLessThan(LIMIT_MS + 500);
    expect(run.b).toMatchObject({ outcome: "unknown", isError: true });
    expect(run.b.ms).toBeLessThan(LIMIT_MS + 500);
    expect(run.c).toMatchObject({ outcome: "unknown", value: "other-process-token" });
    expect(run.c.ttl).toBeGreaterThan(50_000);
    expect(run.d).toMatchObject({ outcome: "unknown", heldAfterFailedRelease: 1 });
    expect(run.d.expiredAfterMs).toBeLessThan(2_500 + 500);
  }, 60_000);

  it("7. queue producers (BullMQ's connection, bounded calls): silent or refused Redis -> the call fails within the limit with an UNKNOWN result; the commands run late, and retrying is idempotent (one job each)", async () => {
    const run = await scenario(async (cleanup) => {
      const frozen = await proxy(cleanup);
      const connection = new Redis(frozen.url(TARGET), { maxRetriesPerRequest: null });
      connection.on("error", () => undefined);
      cleanup.defer(() => connection.disconnect());
      const queues = createWorkerQueues(connection, { producerTimeoutMs: LIMIT_MS });
      cleanup.defer(() => queues.close());
      await Promise.all([queues.emailProcessing.waitUntilReady(), queues.emailEvents.waitUntilReady(), queues.notifications.waitUntilReady()]);
      const account = makeAccount({ id: "gmail-1" });
      const job: EmailProcessingJob = { organizationId: account.organizationId, emailAccountId: account.id, provider: "GMAIL", providerMessageId: "late-1" };
      const notification = { organizationId: account.organizationId, emailId: "email-1", ruleId: "rule-1", channel: "in_app" as const, title: "t", body: "b" };
      frozen.freeze();
      const processing = await timed(() => queues.producer.enqueueProcessing(job));
      const notify = await timed(() => queues.producer.enqueueNotification(notification));
      const sync = await timed(() => queues.enqueueSync(account, "POLL"));
      const whileFrozen = (await admin.keys("bull:*:late-1")).length;
      frozen.thaw();
      await vi.waitFor(async () => expect(await queues.emailProcessing.getJobCountByTypes("waiting")).toBe(1), { timeout: 5_000 });
      await vi.waitFor(async () => expect(await queues.notifications.getJobCountByTypes("waiting")).toBe(1), { timeout: 5_000 });
      // The job's retry repeats the same calls: still one job each.
      await queues.producer.enqueueProcessing(job);
      await queues.producer.enqueueNotification(notification);
      await vi.waitFor(async () => expect(await queues.emailEvents.getJobCountByTypes("waiting")).toBe(1), { timeout: 5_000 });
      await queues.enqueueSync(account, "POLL");
      const afterRetry = {
        processing: await queues.emailProcessing.getJobCountByTypes("waiting", "delayed", "active", "completed", "failed"),
        notifications: await queues.notifications.getJobCountByTypes("waiting", "delayed", "active", "completed", "failed"),
        syncs: await queues.emailEvents.getJobCountByTypes("waiting", "delayed", "active", "completed", "failed")
      };
      // Refused connections: BullMQ's connection queues the command; the bounded call fails, the job appears once later.
      await frozen.refuse();
      const refusedJob = { ...job, providerMessageId: "late-2" };
      const refused = await timed(() => queues.producer.enqueueProcessing(refusedJob));
      await frozen.listen();
      await vi.waitFor(async () => expect(await queues.emailProcessing.getJobCountByTypes("waiting")).toBe(2), { timeout: 15_000 });
      await queues.producer.enqueueProcessing(refusedJob);
      return {
        frozen: [processing, notify, sync].map((result) => ({ outcome: redisOutcome(result.error), isError: result.error instanceof AppRedisError, ms: result.ms })),
        whileFrozen,
        afterRetry,
        refused: { outcome: redisOutcome(refused.error), isError: refused.error instanceof AppRedisError, ms: refused.ms },
        processingAfterRefused: await queues.emailProcessing.getJobCountByTypes("waiting", "delayed", "active", "completed", "failed")
      };
    });
    console.log("F5.2 (7):", JSON.stringify(run));
    for (const call of [...run.frozen, run.refused]) {
      expect(call).toMatchObject({ outcome: "unknown", isError: true });
      expect(call.ms).toBeGreaterThanOrEqual(LIMIT_MS - 20);
      expect(call.ms).toBeLessThan(LIMIT_MS + 500);
    }
    expect(run.whileFrozen).toBe(0);
    expect(run.afterRetry).toEqual({ processing: 1, notifications: 1, syncs: 1 });
    expect(run.processingAfterRefused).toBe(2);
  }, 60_000);

  it("9. F5.1 with Redis not answering: a job waiting on the realtime publisher fails by itself at the command limit (never completed), the shutdown is not forced and ends well within its budget", async () => {
    const run = await scenario(async (cleanup) => {
      const frozen = await proxy(cleanup);
      // As in production, the command limit (here 1 s; 5 s by default) is below the grace period (1.9 s for a 15 s
      // budget; 11.9 s for the default 25 s).
      const publisher = app(cleanup, frozen.url(TARGET));
      const connection = new Redis(TARGET, { maxRetriesPerRequest: null });
      cleanup.defer(() => connection.quit());
      const queues = createWorkerQueues(connection, { producerTimeoutMs: LIMIT_MS });
      cleanup.defer(() => queues.close());
      const account = makeAccount({ id: "gmail-1", provider: "GMAIL" });
      const emails = new MemoryEmailStore();
      const deps = processDeps({ realtime: createAppRealtimePublisher(publisher), producer: queues.producer, emails, accounts: [account] });
      const processors = createJobProcessors({ eventDeps: {} as never, processDeps: deps, accounts: deps.accounts, realtime: makeRealtime(), logger: logger as never, reportJobFailure: vi.fn(), jobType: () => "process-email" });
      const tracker = createJobTracker();
      const worker = new Worker<EmailProcessingJob>(QUEUE_NAMES.emailProcessing, tracker.wrap(processors.processing), { connection, concurrency: 1 });
      cleanup.defer(() => worker.close(true));
      worker.on("error", () => undefined);
      await worker.waitUntilReady();
      const exits: number[] = [];
      const steps: string[] = [];
      const shutdown = createShutdown(
        {
          logger: { ...silentLogger, info: (fields: unknown) => void steps.push(String((fields as { phase?: string }).phase ?? "")) },
          workers: [worker],
          tracker,
          markStopping: () => undefined,
          abortImap: () => undefined,
          interruptBlockedClients: () => publisher.client.disconnect(),
          release: [{ name: "queues", run: () => queues.close() }],
          disconnect: () => undefined,
          flush: async () => undefined,
          exit: (code) => exits.push(code)
        },
        shutdownLimits(15_000)
      );
      frozen.freeze();
      await queues.producer.enqueueProcessing({ organizationId: account.organizationId, emailAccountId: account.id, provider: "GMAIL", providerMessageId: "g-frozen" });
      await vi.waitFor(() => expect(tracker.active()).toBe(1), { timeout: 10_000 });
      await vi.waitFor(() => expect(emails.rows).toHaveLength(1), { timeout: 10_000 });
      const started = Date.now();
      shutdown.onSignal("SIGTERM");
      const code = await shutdown.running;
      const ms = Date.now() - started;
      const [job] = await queues.emailProcessing.getJobs(["active", "waiting", "delayed", "failed", "completed"]);
      return { code, ms, exits, steps, state: await job!.getState(), attemptsMade: job!.attemptsMade, status: emails.rows[0]?.processing_status };
    });
    console.log("F5.2 (9):", JSON.stringify(run));
    expect(run.ms).toBeLessThan(LIMIT_MS + 1_000);
    expect(run.code).toBe(0); // the job ended (failed) during the grace period: nothing had to be forced
    expect(run.steps).toEqual(["stop", "grace", "close", "release", "exit"]);
    expect(run).toMatchObject({ state: "delayed", attemptsMade: 1 });
    expect(run.status).not.toBe("PROCESSED");
  }, 60_000);

  /**
   * The index.ts Redis wiring in a child process, every client through the proxy; F5.1 shutdown WITHOUT process.exit
   * after Redis is put in `state`. The child must end on its own (no artificial timer in it): the time from its
   * shutdown's end to its exit is measured; it is killed (and the test fails) only after 15 s.
   */
  async function childShutdown(state: "available" | "refused" | "silent") {
    await resetClaimedValkey(admin, SUITE);
    const frozen = await startFreezeProxy(target);
    const proc = fork(CHILD, [], { execArgv: ["--import", "tsx"], env: { ...process.env, A2_BULLMQ_URL: frozen.url(TARGET), F52_QUEUE: `f52-child-${state}` }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const events: Array<{ event: string; code?: number; resources?: string[]; at: number }> = [];
    proc.on("message", (message: { event: string }) => events.push({ ...message, at: Date.now() }));
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => proc.on("exit", (code) => resolve({ code, at: Date.now() })));
    try {
      await vi.waitFor(() => expect(events.map((e) => e.event)).toContain("ready"), { timeout: 20_000 });
      proc.send({ enqueue: true });
      await vi.waitFor(() => expect(events.map((e) => e.event)).toContain("completed"), { timeout: 10_000 });
      if (state === "refused") await frozen.refuse();
      if (state === "silent") frozen.freeze();
      const signalAt = Date.now();
      proc.send({ signal: "SIGTERM" });
      const result = await Promise.race([exited, sleep(30_000).then(() => null)]);
      if (!result) proc.kill();
      const done = events.find((e) => e.event === "shutdown");
      return {
        state,
        code: done?.code ?? null,
        shutdownMs: done ? done.at - signalAt : null,
        exitCode: result?.code ?? "still running",
        endedAfterShutdownMs: result && done ? result.at - done.at : null,
        resourcesAtExitCall: done?.resources ?? []
      };
    } finally {
      if (proc.exitCode === null) proc.kill();
      await frozen.stop();
    }
  }

  it("11. real process with the index.ts Redis wiring, Redis available / refusing connections / accepting without answering: the F5.1 shutdown ends within its budget and the process then ends by itself (no socket, listener or timer left)", async () => {
    const runs = [];
    for (const state of ["available", "refused", "silent"] as const) runs.push(await childShutdown(state));
    console.log("F5.2 (11):", JSON.stringify(runs));
    for (const run of runs) {
      expect(run.code === 0 || run.code === 1).toBe(true);
      expect(run.shutdownMs).not.toBeNull();
      expect(run.shutdownMs!).toBeLessThan(15_000);
      expect(run.exitCode).toBe(0);
      expect(run.endedAfterShutdownMs!).toBeLessThan(3_000); // ioredis destroys a socket to a silent peer after 2 s
    }
    expect(runs[0]?.code).toBe(0);
  }, 120_000);
});

describe.runIf(!enabled)("F5.2 Redis limits with a real Valkey (skipped)", () => {
  it.skip("runs only with A2_BULLMQ_URL pointing at a throwaway Valkey (see the header)", () => undefined);
});
