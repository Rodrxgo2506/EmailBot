import { QUEUE_NAMES, type EmailProcessingJob } from "@emailbot/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createImapSyncSlots, imapSyncSlotCount } from "../infrastructure/imap-slots.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import { createWorkerQueues } from "../infrastructure/queues.js";
import type { ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { abortImapOperations, resetImapAbortForTests, runningImapOperations } from "../providers/imap/deadline.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import type { ProviderAdapter, WorkerAccount } from "../providers/types.js";
import { claimThrowawayValkey, cleanupSteps, releaseClaimedValkey, resetClaimedValkey, type CleanupSteps } from "./a2-bullmq-target.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeEmail, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";
import { localImapOptions, SLOW_LOGIN, startSlowImapServer, type SlowServer } from "./slow-imap-server.js";

/*
 * IMAP A2.1 - CRITICAL test, against REAL BullMQ (opt-in: A2_BULLMQ_URL must name a THROWAWAY Valkey on this
 * machine; same URL guard as the E4 suites, plus a2-bullmq-target.ts: the database must be empty or this suite's,
 * one suite at a time; run with the other A2 suites only with --no-file-parallelism).
 *
 * What really runs: a BullMQ Worker on email-processing with concurrency 10 (WORKER_PROCESSING_CONCURRENCY's
 * default) whose processor delegates to the PRODUCTION processor (job-processors.ts `processing`: IMAP slots,
 * "slots busy -> delayed", the A2.1 budget, failure mapping); jobs added by the production producer
 * (DEFAULT_JOB_OPTIONS: 5 attempts, exponential backoff); the real processEmail (new-email and resume paths,
 * attachment completion); the real IMAP adapter + pool + deadlines and ImapFlow against local servers that serve
 * multipart messages with 3 attachments and drip from a chosen download on. In memory: the database, Storage and
 * the Gmail / Microsoft APIs. The wrapper around the processor only counts; it decides nothing.
 *
 * Control: the same saturation WITHOUT the IMAP slots (as before A2.1) must delay Gmail / Microsoft.
 */

const RAW_URL = process.env.A2_BULLMQ_URL ?? "";
const enabled = RAW_URL !== "";
const GUARD_MODULE = "../../../api/src/test/valkey-target.ts";
const guard = enabled ? ((await import(new URL(GUARD_MODULE, import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string }) : null;
const TARGET = guard ? guard.assertLocalValkeyUrl(RAW_URL) : "";
const SUITE = "imap-a2-1-processing-isolation";
const PROCESSING_CONCURRENCY = 10;
const IMAP_SLOTS = imapSyncSlotCount(PROCESSING_CONCURRENCY, 2); // production wiring: 2
const MAILBOXES = 5;
const OTHER_ACCOUNTS = 10; // per provider
const ATTACHMENTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface EnvOptions {
  withSlots: boolean;
  /** Adapter deadlines (shortened). */
  fetchMs: number;
  /** A2.1 budget of one IMAP job (shortened): no IMAP operation starts after startMs, all are closed at hardMs. */
  budget: { startMs: number; hardMs: number };
  /** Attachments of every message (default ATTACHMENTS). */
  attachments?: number;
  /** The Nth download of every server and the later ones drip (0 = normal). */
  dripSourceFrom: number;
  pausedMailbox?: boolean;
}

describe.runIf(enabled)("A2.1: IMAP recovery jobs cannot take the email-processing slots of Gmail / Microsoft (real BullMQ)", () => {
  const servers: SlowServer[] = [];
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(TARGET, { maxRetriesPerRequest: null });
    await claimThrowawayValkey(admin, SUITE);
    for (let n = 0; n < MAILBOXES; n++) servers.push(await startSlowImapServer({ attachments: ATTACHMENTS, dripMs: 200 }));
  });
  afterAll(async () => {
    for (const server of servers) await server.stop();
    if (admin) await releaseClaimedValkey(admin, SUITE).finally(() => admin.quit());
  });

  async function scenario<T>(run: (cleanup: CleanupSteps) => Promise<T>): Promise<T> {
    resetImapAbortForTests();
    await resetClaimedValkey(admin, SUITE);
    const cleanup = cleanupSteps();
    try {
      return await run(cleanup);
    } finally {
      await cleanup.run();
    }
  }

  async function environment(options: EnvOptions, cleanup: CleanupSteps) {
    for (const server of servers) {
      server.options.dripSourceFrom = options.dripSourceFrom > 0 ? server.sourceFetches() + options.dripSourceFrom : 0;
      server.options.attachments = options.attachments ?? ATTACHMENTS;
    }
    const queueConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => queueConnection.quit());
    const workerConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => workerConnection.quit());
    const queues = createWorkerQueues(queueConnection);
    cleanup.defer(() => queues.close());

    const portByUser = new Map<string, number>();
    const imapAccounts: WorkerAccount[] = servers.map((server, n) => {
      const user = `slow-${n}@empresa-correo.com`;
      portByUser.set(user, server.port);
      return makeAccount({
        id: `imap-${n}`,
        provider: "IMAP",
        emailAddress: user,
        syncCursor: "imap:v1:7:3",
        accessTokenEncrypted: "v2.not-used-here",
        providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: user } },
        ...(options.pausedMailbox && n === 0 ? { status: "PAUSED" as const } : {})
      });
    });
    const others: WorkerAccount[] = [];
    for (let n = 0; n < OTHER_ACCOUNTS; n++) {
      others.push(makeAccount({ id: `gmail-${n}`, provider: "GMAIL", emailAddress: `g${n}@gmail.com` }));
      others.push(makeAccount({ id: `microsoft-${n}`, provider: "MICROSOFT", emailAddress: `m${n}@outlook.com` }));
    }
    const accounts = makeAccountStore([...imapAccounts, ...others]);
    const pool = new ImapConnectionPool<ImapClient>();
    cleanup.defer(() => pool.closeAll());
    const imap = createImapSyncAdapter({
      pool,
      deadlines: { connectMs: 1_000, listMs: options.fetchMs, fetchMs: options.fetchMs },
      connect: (_endpoint, credentials) => openImapClient(localImapOptions(portByUser.get(credentials.username)!), credentials)
    });
    const otherFetch = vi.fn(async (_context: unknown, id: string) => makeEmail({ providerMessageId: id, internetMessageId: `<${id}@x>` }));
    const providers = {
      IMAP: imap,
      GMAIL: makeAdapter({ provider: "GMAIL", fetchMessage: otherFetch }),
      MICROSOFT: makeAdapter({ provider: "MICROSOFT", fetchMessage: otherFetch })
    } as unknown as Record<"IMAP" | "GMAIL" | "MICROSOFT", ProviderAdapter>;
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
    const objects = new Map<string, Uint8Array>();
    const uploads: string[] = [];
    const processDeps: Omit<ProcessEmailDeps, "logger"> = {
      accounts,
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: {
        exists: vi.fn(async (_bucket: string, path: string) => objects.has(path)),
        upload: vi.fn(async (_bucket: string, path: string, content: Uint8Array) => {
          uploads.push(path);
          objects.set(path, content);
        })
      },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers,
      createContext: (account: WorkerAccount) => ({
        account,
        getAccessToken: async () => "token",
        getImapCredentials: async () => ({ username: account.emailAddress, password: SLOW_LOGIN.password })
      }),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1_000_000,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true
    };
    const productionSlots = createImapSyncSlots(IMAP_SLOTS);
    let maxInUse = 0;
    const slots = {
      tryAcquire: vi.fn(() => {
        const taken = productionSlots.tryAcquire();
        maxInUse = Math.max(maxInUse, productionSlots.inUse());
        return taken;
      }),
      release: vi.fn(() => productionSlots.release()),
      inUse: () => productionSlots.inUse()
    };
    const logger = { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) };
    const processors = createJobProcessors({
      eventDeps: {} as never,
      processDeps,
      accounts,
      realtime: makeRealtime(),
      logger: logger as never,
      reportJobFailure: vi.fn(),
      jobType: () => "process-email",
      imapProcessingBudget: { softMs: options.budget.startMs, startMs: options.budget.startMs, hardMs: options.budget.hardMs },
      ...(options.withSlots ? { imapProcessingSlots: slots } : {})
    });

    const stats = { imapRuns: 0, activeImap: 0, maxActiveImap: 0, otherDoneAt: [] as number[], imapHolds: [] as number[], failed: [] as string[] };
    const worker = new Worker<EmailProcessingJob>(
      QUEUE_NAMES.emailProcessing,
      async (job, token) => {
        const imapJob = job.data.provider === "IMAP";
        const started = Date.now();
        if (imapJob) {
          stats.imapRuns += 1;
          stats.activeImap += 1;
          stats.maxActiveImap = Math.max(stats.maxActiveImap, stats.activeImap);
        }
        try {
          return await processors.processing(job, token); // the production processor
        } finally {
          if (imapJob) {
            stats.activeImap -= 1;
            stats.imapHolds.push(Date.now() - started);
          }
        }
      },
      { connection: workerConnection, concurrency: PROCESSING_CONCURRENCY }
    );
    cleanup.defer(() => worker.close());
    cleanup.defer(() => abortImapOperations()); // runs first: the worker never waits for a slow IMAP server
    worker.on("completed", (job) => {
      if (job.data.provider !== "IMAP") stats.otherDoneAt.push(Date.now());
    });
    worker.on("failed", (job, error) => {
      if (job) stats.failed.push(`${job.data.provider}:${error.name}`);
    });
    await worker.waitUntilReady();

    const enqueueImap = async (count: number, messageOf: (n: number) => string = (n) => `7:${1 + Math.floor(n / MAILBOXES)}`) => {
      for (let n = 0; n < count; n++) {
        const account = imapAccounts[n % MAILBOXES] as WorkerAccount;
        await queues.producer.enqueueProcessing({ organizationId: account.organizationId, emailAccountId: account.id, provider: "IMAP", providerMessageId: messageOf(n) });
      }
    };
    const enqueueOthers = async () => {
      const at = Date.now();
      for (const account of others) {
        await queues.producer.enqueueProcessing({ organizationId: account.organizationId, emailAccountId: account.id, provider: account.provider, providerMessageId: `${account.id}-m1` });
      }
      return at;
    };
    const waitOthers = async (windowMs: number) => {
      const until = Date.now() + windowMs;
      while (Date.now() < until && stats.otherDoneAt.length < others.length) await sleep(25);
      return stats.otherDoneAt.length;
    };
    const imapJobs = async () => (await queues.emailProcessing.getJobs(["active", "waiting", "delayed", "completed", "failed"])).filter((job) => job.data.provider === "IMAP");
    const shutdown = async () => {
      const closing = Date.now();
      abortImapOperations();
      await worker.close();
      const closeMs = Date.now() - closing;
      await pool.closeAll();
      for (const server of servers) await server.allClosed(5_000);
      return closeMs;
    };
    return { queues, worker, emails, uploads, slots, stats, others, imapAccounts, pool, enqueueImap, enqueueOthers, waitOthers, imapJobs, shutdown, getMaxInUse: () => maxInUse, otherFetch };
  }

  const released = () => ({
    openSockets: servers.reduce((sum, server) => sum + server.openSockets(), 0),
    activeDrips: servers.reduce((sum, server) => sum + server.activeDrips(), 0),
    runningImap: runningImapOperations()
  });

  it("1. baseline: without IMAP jobs the 20 Gmail / Microsoft jobs finish at once through the same path", async () => {
    const run = await scenario(async (cleanup) => {
      const env = await environment({ withSlots: true, fetchMs: 20_000, budget: { startMs: 30_000, hardMs: 30_000 }, dripSourceFrom: 0 }, cleanup);
      const at = await env.enqueueOthers();
      const done = await env.waitOthers(10_000);
      const allMs = Math.max(...env.stats.otherDoneAt) - at;
      await env.shutdown();
      return { done, allMs, stored: env.emails.rows.length, tryAcquire: env.slots.tryAcquire.mock.calls.length, fetches: env.otherFetch.mock.calls.length };
    });
    console.log("A2.1 isolation (1 baseline):", JSON.stringify(run));
    expect(run.done).toBe(2 * OTHER_ACCOUNTS);
    expect(run.allMs).toBeLessThan(1_500);
    expect(run.stored).toBe(2 * OTHER_ACCOUNTS); // really processed (rule matched, stored)
    expect(run.tryAcquire).toBe(0); // 10. Gmail / Microsoft never touch the IMAP slots
    expect(run.fetches).toBe(2 * OTHER_ACCOUNTS);
  }, 60_000);

  it("2 + 3 + 8 + 10. 10 saturated IMAP jobs hold at most 2 slots, the other 8 go back to delayed with 0 attempts; Gmail / Microsoft finish; shutdown releases everything", async () => {
    const run = await scenario(async (cleanup) => {
      // Every download drips; deadlines and budget far beyond the observation window: IMAP stays saturated.
      const env = await environment({ withSlots: true, fetchMs: 20_000, budget: { startMs: 30_000, hardMs: 30_000 }, dripSourceFrom: 1 }, cleanup);
      await env.enqueueImap(10);
      await vi.waitFor(() => expect(env.slots.inUse()).toBe(IMAP_SLOTS), { timeout: 10_000 });
      await vi.waitFor(
        async () => expect((await Promise.all((await env.imapJobs()).map((job) => job.getState()))).filter((state) => state === "delayed").length).toBe(10 - IMAP_SLOTS),
        { timeout: 10_000, interval: 100 }
      );
      const at = await env.enqueueOthers();
      const done = await env.waitOthers(10_000);
      const firstMs = Math.min(...env.stats.otherDoneAt) - at;
      const allMs = Math.max(...env.stats.otherDoneAt) - at;
      const jobs = await env.imapJobs();
      const states = await Promise.all(jobs.map((job) => job.getState()));
      const inUseBeforeShutdown = env.slots.inUse();
      const runningBeforeShutdown = runningImapOperations();
      const failedBeforeShutdown = env.stats.failed.length;
      const closeMs = await env.shutdown();
      return {
        done,
        firstMs,
        allMs,
        maxInUse: env.getMaxInUse(),
        inUseBeforeShutdown,
        runningBeforeShutdown,
        delayed: states.filter((state) => state === "delayed").length,
        active: states.filter((state) => state === "active").length,
        attempts: jobs.map((job) => job.attemptsMade),
        tryAcquireCalls: env.slots.tryAcquire.mock.calls.length,
        imapRuns: env.stats.imapRuns,
        failedBeforeShutdown,
        // The 2 IMAP jobs inside the slots, stopped by the shutdown (transient: retried after the restart).
        failedAtShutdown: env.stats.failed.slice(failedBeforeShutdown),
        closeMs,
        inUseAfterShutdown: env.slots.inUse(),
        releases: env.slots.release.mock.calls.length,
        acquired: env.slots.tryAcquire.mock.results.filter((result) => result.value === true).length,
        stored: env.emails.rows.length,
        ...released(),
        pool: env.pool.stats()
      };
    });
    console.log("A2.1 isolation (2 saturated, slots on):", JSON.stringify(run));
    expect(run.done).toBe(2 * OTHER_ACCOUNTS);
    expect(run.allMs).toBeLessThan(1_500); // as fast as the baseline, while IMAP is saturated
    expect(run.maxInUse).toBe(IMAP_SLOTS); // never more than 2 IMAP jobs inside the processor
    expect(run.inUseBeforeShutdown).toBe(IMAP_SLOTS);
    expect(run.runningBeforeShutdown).toBe(IMAP_SLOTS); // IMAP still saturated when Gmail / Microsoft were done
    expect(run.delayed).toBe(10 - IMAP_SLOTS); // 3. back to delayed...
    expect(run.attempts.every((attempts) => attempts === 0)).toBe(true); // ...without using an attempt
    expect(run.tryAcquireCalls).toBe(run.imapRuns); // 10. only IMAP jobs ask for a slot
    expect(run.stored).toBe(2 * OTHER_ACCOUNTS); // no IMAP email stored (each download drips)
    expect(run.failedBeforeShutdown).toBe(0); // the delays never count as failures
    expect(run.failedAtShutdown).toEqual(Array.from({ length: IMAP_SLOTS }, () => "IMAP:ImapDeadlineError"));
    // 8. shutdown: bounded, slots and connections released exactly once each.
    expect(run.closeMs).toBeLessThan(3_000);
    expect(run.inUseAfterShutdown).toBe(0);
    expect(run.releases).toBe(run.acquired);
    expect(run).toMatchObject({ openSockets: 0, activeDrips: 0, runningImap: 0 });
    expect(run.pool).toMatchObject({ open: 0, busy: 0, opening: 0 });
  }, 90_000);

  it("9. control WITHOUT the IMAP slots (before A2.1): the 10 IMAP jobs take all 10 slots and Gmail / Microsoft do not advance", async () => {
    const run = await scenario(async (cleanup) => {
      const env = await environment({ withSlots: false, fetchMs: 20_000, budget: { startMs: 30_000, hardMs: 30_000 }, dripSourceFrom: 1 }, cleanup);
      await env.enqueueImap(10);
      await vi.waitFor(() => expect(env.stats.activeImap).toBe(PROCESSING_CONCURRENCY), { timeout: 10_000 });
      await env.enqueueOthers();
      const done = await env.waitOthers(4_000);
      const closeMs = await env.shutdown();
      return { done, maxActiveImap: env.stats.maxActiveImap, closeMs, ...released() };
    });
    console.log("A2.1 isolation (9 control, slots off):", JSON.stringify(run));
    expect(run.maxActiveImap).toBe(PROCESSING_CONCURRENCY);
    expect(run.done).toBe(0);
    expect(run).toMatchObject({ openSockets: 0, activeDrips: 0 });
  }, 90_000);

  it("4 + 5 + 6. a job with 30 attachments whose message read hangs holds its slot only until the hard limit; the BullMQ retry stores all 30 once, reading the message once", async () => {
    const run = await scenario(async (cleanup) => {
      // First attempt: the message read drips forever (deadline 20 s); start limit 1.5 s, hard limit 3 s.
      const env = await environment({ withSlots: true, fetchMs: 20_000, budget: { startMs: 1_500, hardMs: 3_000 }, dripSourceFrom: 1, attachments: 30 }, cleanup);
      const server = servers[0]!;
      const readsBefore = server.sourceFetches();
      await env.enqueueImap(1);
      await vi.waitFor(() => expect(env.stats.imapHolds.length).toBe(1), { timeout: 15_000 });
      const hold = env.stats.imapHolds[0]!;
      const [job] = await env.imapJobs();
      const afterFirst = {
        state: await job!.getState(),
        attempts: (await env.queues.emailProcessing.getJob(job!.id!))!.attemptsMade,
        rows: env.emails.rows.length, // nothing half-stored: the message was never read
        uploads: env.uploads.length,
        inUse: env.slots.inUse(),
        ...released()
      };
      // The server recovers; the BullMQ retry (exponential backoff, 5 s) processes the email.
      for (const target of servers) target.options.dripSourceFrom = 0;
      await vi.waitFor(() => expect(env.emails.rows[0]?.processing_status).toBe("PROCESSED"), { timeout: 20_000, interval: 100 });
      const closeMs = await env.shutdown();
      return {
        hold,
        afterFirst,
        reads: server.sourceFetches() - readsBefore,
        attachments: env.emails.attachments.length,
        allStored: env.emails.attachments.every((row) => row.storage_uploaded),
        uploads: env.uploads.length,
        uniqueUploads: new Set(env.uploads).size,
        acquired: env.slots.tryAcquire.mock.results.filter((result) => result.value === true).length,
        releases: env.slots.release.mock.calls.length,
        closeMs
      };
    });
    console.log("A2.1 isolation (4-6, 30 attachments):", JSON.stringify(run));
    expect(run.hold).toBeGreaterThanOrEqual(2_800); // not cut at the start limit (1.5 s)...
    expect(run.hold).toBeLessThan(3_000 + 1_500); // ...closed at the hard limit (plus the closing margin), never at 20 s
    expect(run.afterFirst.state).toBe("delayed"); // BullMQ retry with backoff (a real failed attempt)
    expect(run.afterFirst.attempts).toBe(1);
    expect(run.afterFirst.rows).toBe(0);
    expect(run.afterFirst.uploads).toBe(0);
    expect(run.afterFirst.inUse).toBe(0); // 5. the slot is free again
    expect(run.afterFirst).toMatchObject({ activeDrips: 0, runningImap: 0 });
    expect(run.reads).toBe(2); // the cut read + ONE read for the 30 attachments (not 31)
    expect(run.attachments).toBe(30); // 6. no duplicated rows...
    expect(run.allStored).toBe(true);
    expect(run.uploads).toBe(30); // ...and every content uploaded exactly once
    expect(run.uniqueUploads).toBe(30);
    expect(run.releases).toBe(run.acquired);
  }, 90_000);

  it("7. a paused mailbox: its recovery job is skipped without any IMAP operation; Gmail / Microsoft unaffected", async () => {
    const run = await scenario(async (cleanup) => {
      const env = await environment({ withSlots: true, fetchMs: 20_000, budget: { startMs: 30_000, hardMs: 30_000 }, dripSourceFrom: 0, pausedMailbox: true }, cleanup);
      const connections = servers[0]!.connections();
      const account = env.imapAccounts[0]!;
      await env.queues.producer.enqueueProcessing({ organizationId: account.organizationId, emailAccountId: account.id, provider: "IMAP", providerMessageId: "7:1" });
      await vi.waitFor(() => expect(env.stats.imapHolds.length).toBe(1), { timeout: 10_000 });
      const [job] = await env.imapJobs();
      const state = await job!.getState();
      const value = (await env.queues.emailProcessing.getJob(job!.id!))!.returnvalue as unknown;
      await env.enqueueOthers();
      const done = await env.waitOthers(10_000);
      await env.shutdown();
      return { state, value, newConnections: servers[0]!.connections() - connections, done, releases: env.slots.release.mock.calls.length };
    });
    console.log("A2.1 isolation (7 paused):", JSON.stringify(run));
    expect(run.state).toBe("completed");
    expect(run.value).toMatchObject({ status: "skipped", reason: "account_inactive" });
    expect(run.newConnections).toBe(0);
    expect(run.releases).toBe(1);
    expect(run.done).toBe(2 * OTHER_ACCOUNTS);
  }, 60_000);
});

describe.runIf(!enabled)("A2.1 isolation (skipped)", () => {
  it.skip("runs only with A2_BULLMQ_URL pointing at a throwaway Valkey (see the header)", () => undefined);
});
