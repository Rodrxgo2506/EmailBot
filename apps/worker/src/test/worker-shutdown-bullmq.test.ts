import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { QUEUE_NAMES, type EmailProcessingJob } from "@emailbot/shared";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createImapSyncSlots } from "../infrastructure/imap-slots.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import { createWorkerQueues } from "../infrastructure/queues.js";
import { createJobTracker, createShutdown, type ShutdownLimits } from "../infrastructure/shutdown.js";
import { createRealtimePublisher } from "../infrastructure/supabase-stores.js";
import type { ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { abortImapOperations, resetImapAbortForTests } from "../providers/imap/deadline.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import type { RealtimePublisher } from "../pipeline/ports.js";
import type { WorkerAccount } from "../providers/types.js";
import { claimThrowawayValkey, cleanupSteps, releaseClaimedValkey, resetClaimedValkey, type CleanupSteps } from "./a2-bullmq-target.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeEmail, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";
import { localImapOptions, SLOW_LOGIN, startSlowImapServer } from "./slow-imap-server.js";

/*
 * F5.1 - the shutdown orchestrator with REAL BullMQ on a THROWAWAY Valkey (opt-in: A2_BULLMQ_URL, guarded by
 * valkey-target.ts and a2-bullmq-target.ts; run in series with the other BullMQ suites, --no-file-parallelism).
 * In-process scenarios inject `exit`; the real process.exit is exercised in a child process
 * (fixtures/shutdown-child.ts), so the test runner itself is never terminated.
 */

const RAW_URL = process.env.A2_BULLMQ_URL ?? "";
const enabled = RAW_URL !== "";
const guard = enabled ? ((await import(new URL("../../../api/src/test/valkey-target.ts", import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string }) : null;
const TARGET = guard ? guard.assertLocalValkeyUrl(RAW_URL) : "";
const SUITE = "worker-shutdown-bullmq";
// cancelMs as in production (3 s): an interrupted ioredis client rejects its pending commands only after its
// disconnectTimeout (2 s by default) when the server does not answer (it ends the socket, then destroys it).
const LIMITS: ShutdownLimits = { totalMs: 12_000, graceMs: 1_500, cancelMs: 3_000, closeMs: 1_000, releaseMs: 1_000, flushMs: 200 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) };
const CHILD = fileURLToPath(new URL("./fixtures/shutdown-child.ts", import.meta.url));

describe.runIf(enabled)("F5.1: bounded shutdown with real BullMQ", () => {
  let admin: Redis;
  const hungSockets = new Set<net.Socket>();
  let hungServer: net.Server;
  let hungPort = 0;

  beforeAll(async () => {
    admin = new Redis(TARGET, { maxRetriesPerRequest: null });
    await claimThrowawayValkey(admin, SUITE);
    // A "Redis" that accepts connections and never answers (a hung realtime publisher).
    hungServer = net.createServer((socket) => {
      hungSockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => hungServer.listen(0, "127.0.0.1", resolve));
    hungPort = (hungServer.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    for (const socket of hungSockets) socket.destroy();
    await new Promise<void>((resolve) => hungServer.close(() => resolve()));
    if (admin) await releaseClaimedValkey(admin, SUITE).finally(() => admin.quit());
  });

  /** The processing pipeline of index.ts (real processors, real queues / producer), with in-memory stores. */
  async function pipeline(cleanup: CleanupSteps, options: { realtime: RealtimePublisher; publisher?: Redis; emails?: MemoryEmailStore; imap?: boolean; lockDuration?: number }) {
    const queueConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => queueConnection.quit());
    const workerConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => workerConnection.quit());
    const queues = createWorkerQueues(queueConnection);
    cleanup.defer(() => queues.close());
    const accounts: WorkerAccount[] = [makeAccount({ id: "gmail-1", provider: "GMAIL" }), makeAccount({ id: "microsoft-1", provider: "MICROSOFT", emailAddress: "m@outlook.com" })];
    let pool: ImapConnectionPool<ImapClient> | null = null;
    let imapServer: Awaited<ReturnType<typeof startSlowImapServer>> | null = null;
    let imapAdapter = makeAdapter({ provider: "IMAP" });
    if (options.imap) {
      imapServer = await startSlowImapServer({ dripSourceFrom: 1, attachments: 1 });
      cleanup.defer(() => imapServer!.stop());
      pool = new ImapConnectionPool<ImapClient>();
      cleanup.defer(() => pool!.closeAll());
      imapAdapter = createImapSyncAdapter({ pool, connect: (_e, credentials) => openImapClient(localImapOptions(imapServer!.port), credentials), deadlines: { connectMs: 2_000, listMs: 30_000, fetchMs: 30_000 } }) as never;
      accounts.push(makeAccount({ id: "imap-1", provider: "IMAP", emailAddress: SLOW_LOGIN.username, syncCursor: "imap:v1:7:3", accessTokenEncrypted: "v2.x", providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: SLOW_LOGIN.username } } }));
    }
    const store = makeAccountStore(accounts);
    const emails = options.emails ?? new MemoryEmailStore();
    emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
    const pdf = new TextEncoder().encode("%PDF-1.4 f5.1");
    const uploads: string[] = [];
    const objects = new Set<string>();
    const oauth = makeAdapter({
      fetchMessage: vi.fn(async (_c: unknown, id: string) => makeEmail({ providerMessageId: id, internetMessageId: `<${id}@x>`, attachments: [{ providerAttachmentId: "att-1", filename: "f.pdf", contentType: "application/pdf", size: pdf.length, contentId: null, isInline: false }] })),
      downloadAttachment: vi.fn(async () => pdf)
    });
    const processDeps: Omit<ProcessEmailDeps, "logger"> = {
      accounts: store, emails, routing: new MemoryRoutingStore(emails), audit: makeAudit(),
      storage: { exists: vi.fn(async (_b: string, path: string) => objects.has(path)), upload: vi.fn(async (_b: string, path: string) => void (uploads.push(path), objects.add(path))) },
      realtime: options.realtime, producer: queues.producer, providers: { GMAIL: oauth, MICROSOFT: oauth, IMAP: imapAdapter } as never,
      createContext: (account: WorkerAccount) => ({ account, getAccessToken: async () => "t", getImapCredentials: async () => SLOW_LOGIN }),
      attachmentsBucket: "email-attachments", maxAttachmentBytes: 1_000_000, storageRetryDelayMs: 0, imapSyncEnabled: true
    };
    const slots = createImapSyncSlots(2);
    const processors = createJobProcessors({ eventDeps: {} as never, processDeps, accounts: store, realtime: makeRealtime(), logger: logger as never, reportJobFailure: vi.fn(), jobType: () => "process-email", imapProcessingSlots: slots });
    const tracker = createJobTracker();
    const worker = new Worker<EmailProcessingJob>(QUEUE_NAMES.emailProcessing, tracker.wrap(processors.processing), { connection: workerConnection, concurrency: 10, ...(options.lockDuration ? { lockDuration: options.lockDuration } : {}) });
    cleanup.defer(() => worker.close(true));
    worker.on("error", () => undefined);
    await worker.waitUntilReady();
    const exits: number[] = [];
    const steps: string[] = [];
    const phaseLog = { ...silentLogger, info: (fields: unknown) => void steps.push(String((fields as { phase?: string }).phase ?? "")) };
    const shutdown = createShutdown(
      {
        logger: phaseLog,
        workers: [worker],
        tracker,
        markStopping: () => undefined,
        abortImap: abortImapOperations,
        interruptBlockedClients: () => options.publisher?.disconnect(),
        release: [...(pool ? [{ name: "imap pool", run: () => pool!.closeAll() }] : []), { name: "queues", run: () => queues.close() }],
        disconnect: () => undefined, // the test's own connections are closed by cleanup
        flush: async () => undefined,
        exit: (code) => exits.push(code)
      },
      LIMITS
    );
    const org = makeAccount().organizationId;
    const enqueue = (emailAccountId: string, provider: "GMAIL" | "MICROSOFT" | "IMAP", providerMessageId: string) => queues.producer.enqueueProcessing({ organizationId: org, emailAccountId, provider, providerMessageId });
    return { queues, worker, emails, uploads, shutdown, exits, steps, tracker, enqueue, imapServer, pool, slots };
  }

  async function scenario<T>(run: (cleanup: CleanupSteps) => Promise<T>): Promise<T> {
    resetImapAbortForTests();
    await resetClaimedValkey(admin, SUITE);
    const cleanup = cleanupSteps();
    try {
      return await run(cleanup);
    } finally {
      await cleanup.run();
      resetImapAbortForTests();
    }
  }

  const timed = async (shutdown: { onSignal(s: string): void; readonly running: Promise<number> | null }) => {
    const started = Date.now();
    shutdown.onSignal("SIGTERM");
    const code = await shutdown.running;
    return { code, ms: Date.now() - started };
  };

  it("1 + 9. Gmail / Microsoft are processed normally; with nothing in flight the shutdown is immediate and clean (exit 0)", async () => {
    const run = await scenario(async (cleanup) => {
      const env = await pipeline(cleanup, { realtime: makeRealtime() });
      for (let n = 0; n < 5; n++) await env.enqueue("gmail-1", "GMAIL", `g-${n}`);
      for (let n = 0; n < 5; n++) await env.enqueue("microsoft-1", "MICROSOFT", `m-${n}`);
      await vi.waitFor(() => expect(env.emails.rows.filter((row) => row.processing_status === "PROCESSED")).toHaveLength(10), { timeout: 10_000 });
      const result = await timed(env.shutdown);
      return { ...result, exits: env.exits, steps: env.steps, completed: await env.queues.emailProcessing.getCompletedCount() };
    });
    console.log("F5.1 (1, 9):", JSON.stringify(run));
    expect(run.code).toBe(0);
    expect(run.exits).toEqual([0]);
    expect(run.ms).toBeLessThan(1_000);
    expect(run.completed).toBe(10);
    expect(run.steps).toEqual(["stop", "grace", "close", "release", "exit"]);
  }, 60_000);

  it("2. a job that finishes during the grace period is waited for (completed normally, exit 0)", async () => {
    const run = await scenario(async (cleanup) => {
      let release: () => void = () => undefined;
      const slowRealtime: RealtimePublisher = { publish: () => new Promise<void>((resolve) => (release = resolve)) };
      const env = await pipeline(cleanup, { realtime: slowRealtime });
      await env.enqueue("gmail-1", "GMAIL", "g-slow");
      await vi.waitFor(() => expect(env.tracker.active()).toBe(1), { timeout: 10_000 });
      setTimeout(() => release(), 500);
      const result = await timed(env.shutdown);
      return { ...result, status: env.emails.rows[0]?.processing_status, completed: await env.queues.emailProcessing.getCompletedCount() };
    });
    console.log("F5.1 (2):", JSON.stringify(run));
    expect(run).toMatchObject({ code: 0, status: "PROCESSED", completed: 1 });
    expect(run.ms).toBeGreaterThanOrEqual(450);
  }, 60_000);

  it("3 + 8. a job hung on an unresponsive Redis (realtime publisher): interrupted after the grace period, NOT completed, retried by BullMQ; after the restart it finishes once (1 email, 1 upload, 1 notification)", async () => {
    const run = await scenario(async (cleanup) => {
      const hungPublisher = new Redis({ host: "127.0.0.1", port: hungPort, maxRetriesPerRequest: null });
      hungPublisher.on("error", () => undefined);
      cleanup.defer(() => hungPublisher.disconnect());
      const emails = new MemoryEmailStore();
      const env = await pipeline(cleanup, { realtime: createRealtimePublisher(hungPublisher), publisher: hungPublisher, emails });
      await env.enqueue("gmail-1", "GMAIL", "g-hung");
      await vi.waitFor(() => expect(emails.rows).toHaveLength(1), { timeout: 10_000 });
      await sleep(300); // now waiting on PUBLISH
      const result = await timed(env.shutdown);
      const [job] = await env.queues.emailProcessing.getJobs(["active", "waiting", "delayed", "failed", "completed"]);
      const afterShutdown = { state: await job!.getState(), attemptsMade: job!.attemptsMade, status: emails.rows[0]?.processing_status, uploads: env.uploads.length, steps: env.steps };
      // Restart (another worker, healthy Redis): the BullMQ retry (backoff 5 s) finishes the same email.
      const healthy = makeRealtime();
      const restarted = await pipeline(cleanup, { realtime: healthy, emails });
      await vi.waitFor(() => expect(emails.rows[0]?.processing_status).toBe("PROCESSED"), { timeout: 20_000, interval: 200 });
      return {
        ...result,
        afterShutdown,
        afterRestart: {
          rows: emails.rows.length,
          attachments: emails.attachments.length,
          uploads: env.uploads.length + restarted.uploads.length,
          notifications: await restarted.queues.notifications.getJobCounts("waiting", "delayed", "completed", "active"),
          publishes: (healthy.publish as ReturnType<typeof vi.fn>).mock.calls.length
        }
      };
    });
    console.log("F5.1 (3, 8):", JSON.stringify(run));
    expect(run.code).toBe(1); // something had to be interrupted
    expect(run.ms).toBeLessThan(LIMITS.totalMs);
    expect(run.afterShutdown).toMatchObject({ state: "delayed", attemptsMade: 1, status: "PROCESSING", uploads: 1 });
    expect(run.afterShutdown.steps).toEqual(["stop", "grace", "cancel", "close", "release", "exit"]);
    expect(run.afterRestart).toMatchObject({ rows: 1, attachments: 1, uploads: 1 });
    expect(Object.values(run.afterRestart.notifications).reduce((sum, n) => sum + n, 0)).toBe(1);
  }, 90_000);

  it("3b + 8. a job hung on something that cannot be cancelled: closed FORCED, left active (never completed); after the restart, once its real 30 s lock expires, it is retried and finishes once", async () => {
    const run = await scenario(async (cleanup) => {
      const emails = new MemoryEmailStore();
      const findEmail = emails.findEmail.getMockImplementation()!;
      let hang = true;
      emails.findEmail.mockImplementation(async (accountId: string, id: string) => (hang ? new Promise(() => undefined) : findEmail(accountId, id)) as never);
      const env = await pipeline(cleanup, { realtime: makeRealtime(), emails }); // production lockDuration (30 s)
      await env.enqueue("gmail-1", "GMAIL", "g-stuck");
      await vi.waitFor(() => expect(env.tracker.active()).toBe(1), { timeout: 10_000 });
      const result = await timed(env.shutdown);
      const [job] = await env.queues.emailProcessing.getJobs(["active", "waiting", "delayed", "failed", "completed"]);
      const afterShutdown = { state: await job!.getState(), finishedOn: job!.finishedOn ?? null, steps: env.steps };
      hang = false; // the "new process" can reach the database
      const restartedAt = Date.now();
      const restarted = await pipeline(cleanup, { realtime: makeRealtime(), emails });
      await vi.waitFor(() => expect(emails.rows[0]?.processing_status).toBe("PROCESSED"), { timeout: 75_000, interval: 500 });
      const fresh = await restarted.queues.emailProcessing.getJob(job!.id!);
      return { ...result, afterShutdown, recoveredAfterMs: Date.now() - restartedAt, rows: emails.rows.length, finalState: await fresh!.getState(), attemptsStarted: fresh!.attemptsStarted };
    });
    console.log("F5.1 (3b, 8):", JSON.stringify(run));
    expect(run.code).toBe(1);
    expect(run.ms).toBeLessThan(LIMITS.totalMs);
    expect(run.afterShutdown).toMatchObject({ state: "active", finishedOn: null });
    expect(run.afterShutdown.steps).toEqual(["stop", "grace", "cancel", "close", "release", "exit"]);
    expect(run.rows).toBe(1);
    expect(run.finalState).toBe("completed");
    expect(run.recoveredAfterMs).toBeLessThan(75_000);
  }, 150_000);

  it("6. IMAP: the operation in flight is closed at the start (socket really closed), the job fails as transient and is retried; pool and slot released", async () => {
    const run = await scenario(async (cleanup) => {
      const env = await pipeline(cleanup, { realtime: makeRealtime(), imap: true });
      await env.enqueue("imap-1", "IMAP", "7:1");
      await vi.waitFor(() => expect(env.imapServer!.activeDrips()).toBe(1), { timeout: 10_000 });
      const result = await timed(env.shutdown);
      await env.imapServer!.allClosed(2_000);
      const [job] = await env.queues.emailProcessing.getJobs(["active", "waiting", "delayed", "failed", "completed"]);
      return { ...result, openSockets: env.imapServer!.openSockets(), drips: env.imapServer!.activeDrips(), pool: env.pool!.stats(), slots: env.slots.inUse(), state: await job!.getState(), steps: env.steps };
    });
    console.log("F5.1 (6):", JSON.stringify(run));
    expect(run).toMatchObject({ code: 0, openSockets: 0, drips: 0, slots: 0, state: "delayed" });
    expect(run.pool).toMatchObject({ open: 0, busy: 0, opening: 0 });
    expect(run.ms).toBeLessThan(1_500);
  }, 60_000);

  /** Runs the child worker process; returns its exit code and the time from the first signal to its exit. */
  async function child(queue: string, drive: (proc: ChildProcess, events: string[]) => Promise<void>) {
    const proc = fork(CHILD, [], { execArgv: ["--import", "tsx"], env: { ...process.env, F51_QUEUE: queue, F51_TOTAL_MS: "15000" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const events: string[] = [];
    let firstSignalAt = 0;
    const exited = new Promise<{ code: number | null; ms: number }>((resolve) => proc.on("exit", (code) => resolve({ code, ms: firstSignalAt ? Date.now() - firstSignalAt : -1 })));
    proc.on("message", (message: { event: string; fields?: { phase?: string } }) => events.push(message.event === "log" && message.fields?.phase ? `phase:${message.fields.phase}` : message.event));
    const originalSend = proc.send.bind(proc);
    (proc as { send: typeof proc.send }).send = ((message: { signal?: string }, ...rest: never[]) => {
      if (message.signal && !firstSignalAt) firstSignalAt = Date.now();
      return originalSend(message as never, ...rest);
    }) as typeof proc.send;
    await vi.waitFor(() => expect(events).toContain("ready"), { timeout: 20_000 });
    const queueConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    const producer = new Queue(queue, { connection: queueConnection });
    await producer.add("j", {});
    await vi.waitFor(() => expect(events).toContain("active"), { timeout: 10_000 });
    try {
      await drive(proc, events);
      const result = await Promise.race([exited, sleep(30_000).then(() => ({ code: -1, ms: -1 }))]);
      if (result.code === -1) proc.kill();
      return { ...result, events, job: await (async () => { const [job] = await producer.getJobs(["active", "waiting", "delayed", "failed", "completed"]); return job ? { state: await job.getState() } : null; })() };
    } finally {
      await producer.close();
      await queueConnection.quit();
    }
  }

  it("7. real process: BullMQ's own Redis stops answering (CLIENT PAUSE WRITE 30 s) while the worker shuts down: the process still exits within the 15 s budget", async () => {
    await resetClaimedValkey(admin, SUITE);
    const run = await child("f51-pause", async (proc) => {
      proc.send({ signal: "SIGTERM" });
      await sleep(300);
      await admin.call("CLIENT", "PAUSE", "30000", "WRITE");
      proc.send({ finish: true }); // the job ends now, but its completion cannot be written to Redis
    });
    await admin.call("CLIENT", "UNPAUSE");
    console.log("F5.1 (7):", JSON.stringify({ code: run.code, ms: run.ms, job: run.job, phases: run.events.filter((e) => e.startsWith("phase:")) }));
    expect(run.code).toBe(1);
    expect(run.ms).toBeGreaterThan(0);
    expect(run.ms).toBeLessThan(15_000 + 1_000);
  }, 90_000);

  it("4. real process: a second signal skips the grace period; a third one exits at once", async () => {
    await resetClaimedValkey(admin, SUITE);
    const second = await child("f51-second", async (proc) => {
      proc.send({ signal: "SIGTERM" });
      await sleep(300);
      proc.send({ signal: "SIGTERM" });
    });
    await resetClaimedValkey(admin, SUITE);
    const third = await child("f51-third", async (proc) => {
      proc.send({ signal: "SIGTERM" });
      await sleep(200);
      proc.send({ signal: "SIGINT" });
      proc.send({ signal: "SIGTERM" });
    });
    console.log("F5.1 (4):", JSON.stringify({ second: { code: second.code, ms: second.ms, job: second.job }, third: { code: third.code, ms: third.ms, job: third.job } }));
    expect(second.code).toBe(1);
    expect(second.ms).toBeLessThan(300 + 1_000 + 3_000 + 5_000); // no 12 s grace
    expect(third.code).toBe(1);
    expect(third.ms).toBeLessThan(1_000);
    expect(second.job?.state).not.toBe("completed");
    expect(third.job?.state).not.toBe("completed");
  }, 120_000);
});

describe.runIf(!enabled)("F5.1 shutdown with real BullMQ (skipped)", () => {
  it.skip("runs only with A2_BULLMQ_URL pointing at a throwaway Valkey (see the header)", () => undefined);
});
