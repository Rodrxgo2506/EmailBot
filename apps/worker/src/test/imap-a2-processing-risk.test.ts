import { QUEUE_NAMES, type EmailProcessingJob } from "@emailbot/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import { createWorkerQueues } from "../infrastructure/queues.js";
import type { HandleEventDeps } from "../pipeline/handle-email-event.js";
import type { ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { abortImapOperations, resetImapAbortForTests } from "../providers/imap/deadline.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import type { ProviderAdapter, WorkerAccount } from "../providers/types.js";
import { claimThrowawayValkey, cleanupSteps, releaseClaimedValkey, resetClaimedValkey, type CleanupSteps } from "./a2-bullmq-target.js";
import {
  makeAccount,
  makeAccountStore,
  makeAdapter,
  makeAudit,
  makeEmail,
  makeProducer,
  makeRealtime,
  makeRuleRow,
  MemoryEmailStore,
  MemoryRoutingStore,
  silentLogger
} from "./fakes.js";
import { localImapOptions, SLOW_LOGIN, startSlowImapServer, type SlowServer } from "./slow-imap-server.js";

/*
 * IMAP A2 final review - RESIDUAL RISK of the email-processing queue (measurement, not a fix), against REAL
 * BullMQ (opt-in: A2_BULLMQ_URL must name a THROWAWAY Valkey on this machine, same guard as the isolation test).
 *
 * The email-processing queue only receives RECOVER_INCOMPLETE jobs (emails left RECEIVED / PROCESSING, e.g.
 * ATTACHMENTS_PENDING after an attachment deadline). Its processor (job-processors.ts `processing`) has NO
 * IMAP slots and NO run budget: an IMAP job holds one of the WORKER_PROCESSING_CONCURRENCY (10) slots for
 * every IMAP operation it runs, each bounded only by its own deadline (fetchMs), and completeAttachments runs
 * one operation per pending attachment, sequentially, catching each failure.
 *
 * What really runs: a BullMQ Worker on email-processing with concurrency 10, the production processor, jobs
 * added by the production producer (DEFAULT_JOB_OPTIONS), processEmail, and the real IMAP adapter + pool +
 * deadlines + ImapFlow against local servers that drip the message source forever. The deadlines are
 * shortened (fetchMs 1.5 s instead of 180 s) so the run is fast; holds scale linearly with fetchMs.
 * In memory: the database stores and the Gmail / Microsoft APIs. "attachments" scenario: the IMAP message
 * metadata comes from a fake fetchMessage (3 attachments); every download is the REAL adapter call.
 *
 * It MEASURES risk F1 with the processor WITHOUT the A2.1 IMAP slots (as before A2.1): a control, not a proof of
 * isolation; the production wiring with the slots is tested in imap-a2-1-processing-isolation.test.ts. The database is
 * emptied between scenarios only after a2-bullmq-target.ts proved it belongs to these suites (empty at the
 * start, one suite at a time). Run together with imap-a2-isolation.test.ts only with --no-file-parallelism.
 * Every resource is closed in `finally`, also on failure. Synthetic messages and fictitious logins only.
 */

const RAW_URL = process.env.A2_BULLMQ_URL ?? "";
const enabled = RAW_URL !== "";
const GUARD_MODULE = "../../../api/src/test/valkey-target.ts";
const guard = enabled ? ((await import(new URL(GUARD_MODULE, import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string }) : null;
const TARGET = guard ? guard.assertLocalValkeyUrl(RAW_URL) : "";
const PROCESSING_CONCURRENCY = 10;
const IMAP_MAILBOXES = 5; // 2 pooled connections each = the pool's 10 per process
const IMAP_JOBS = 10;
const OTHER_ACCOUNTS = 10; // per provider
const FETCH_MS = 1_500;
const ATTACHMENTS = 3;
const SUITE = "imap-a2-processing-risk";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Scenario = "baseline" | "fetch" | "attachments";

describe.runIf(enabled)("A2 residual risk: slow IMAP jobs on the email-processing queue (real BullMQ)", () => {
  const servers: SlowServer[] = [];
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(TARGET, { maxRetriesPerRequest: null });
    await claimThrowawayValkey(admin, SUITE);
    for (let n = 0; n < IMAP_MAILBOXES; n++) servers.push(await startSlowImapServer({ dripSourceUids: [1, 2], dripMs: 200 }));
  });
  afterAll(async () => {
    for (const server of servers) await server.stop();
    if (admin) await releaseClaimedValkey(admin, SUITE).finally(() => admin.quit());
  });

  async function run(scenario: Scenario) {
    resetImapAbortForTests();
    await resetClaimedValkey(admin, SUITE);
    const cleanup = cleanupSteps();
    try {
      return await runScenario(scenario, cleanup);
    } finally {
      await cleanup.run();
    }
  }

  async function runScenario(scenario: Scenario, cleanup: CleanupSteps) {
    const queueConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => queueConnection.quit());
    const workerConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => workerConnection.quit());
    const queues = createWorkerQueues(queueConnection);
    cleanup.defer(() => queues.close());

    const portByUser = new Map<string, number>();
    const accounts: WorkerAccount[] = [];
    servers.forEach((server, n) => {
      const user = `slow-${n}@empresa-correo.com`;
      portByUser.set(user, server.port);
      accounts.push(
        makeAccount({
          id: `imap-${n}`,
          provider: "IMAP",
          emailAddress: user,
          syncCursor: "imap:v1:7:0",
          accessTokenEncrypted: "v2.not-used-here",
          providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: user } }
        })
      );
    });
    for (let n = 0; n < OTHER_ACCOUNTS; n++) {
      accounts.push(makeAccount({ id: `gmail-${n}`, provider: "GMAIL", emailAddress: `g${n}@gmail.com` }));
      accounts.push(makeAccount({ id: `microsoft-${n}`, provider: "MICROSOFT", emailAddress: `m${n}@outlook.com` }));
    }
    const store = makeAccountStore(accounts);
    const pool = new ImapConnectionPool<ImapClient>();
    cleanup.defer(() => pool.closeAll());
    const realImap = createImapSyncAdapter({
      pool,
      deadlines: { connectMs: 1_000, listMs: FETCH_MS, fetchMs: FETCH_MS },
      connect: (_endpoint, credentials) => openImapClient(localImapOptions(portByUser.get(credentials.username)!), credentials)
    });
    const imap: ProviderAdapter =
      scenario === "attachments"
        ? {
            ...realImap,
            // Metadata only (fake); every attachment download below is the real adapter against a dripping server.
            fetchMessage: async (_context, id) =>
              makeEmail({
                provider: "IMAP",
                providerMessageId: id,
                internetMessageId: `<${id}@streaming.example>`,
                attachments: Array.from({ length: ATTACHMENTS }, (_, index) => ({
                  providerAttachmentId: `part-${index}`,
                  filename: `factura-${index}.pdf`,
                  contentType: "application/pdf",
                  size: 10,
                  contentId: null,
                  isInline: false
                }))
              })
          }
        : realImap;
    const oauth = (provider: "GMAIL" | "MICROSOFT"): ProviderAdapter =>
      makeAdapter({ provider, fetchMessage: vi.fn(async (_context, id: string) => makeEmail({ providerMessageId: id, provider, internetMessageId: `<${id}@x>` })) });
    const providers = { GMAIL: oauth("GMAIL"), MICROSOFT: oauth("MICROSOFT"), IMAP: imap };
    const createContext = (account: WorkerAccount) => ({
      account,
      getAccessToken: async () => "token",
      getImapCredentials: async () => ({ username: account.emailAddress, password: SLOW_LOGIN.password })
    });
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow()];
    const processDeps: Omit<ProcessEmailDeps, "logger"> = {
      accounts: store,
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers,
      createContext,
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true
    };
    const eventDeps: Omit<HandleEventDeps, "logger"> = {
      accounts: store,
      emails,
      producer: queues.producer,
      providers,
      createContext,
      enqueueSync: (account, reason) => queues.enqueueSync(account, reason),
      imapSyncEnabled: true
    };
    const logger = { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) };
    const processors = createJobProcessors({
      eventDeps,
      processDeps,
      accounts: store,
      realtime: makeRealtime(),
      logger: logger as never,
      reportJobFailure: vi.fn(),
      jobType: () => "process-email"
    });

    const otherDoneAt: number[] = [];
    const imapHolds: number[] = [];
    let activeImap = 0;
    let maxActiveImap = 0;
    const worker = new Worker<EmailProcessingJob>(
      QUEUE_NAMES.emailProcessing,
      async (job) => {
        const imapJob = job.data.provider === "IMAP";
        const started = Date.now();
        if (imapJob) activeImap += 1;
        maxActiveImap = Math.max(maxActiveImap, activeImap);
        try {
          return await processors.processing(job);
        } finally {
          if (imapJob) {
            activeImap -= 1;
            imapHolds.push(Date.now() - started);
          }
        }
      },
      { connection: workerConnection, concurrency: PROCESSING_CONCURRENCY }
    );
    cleanup.defer(() => worker.close());
    cleanup.defer(() => abortImapOperations()); // runs first: the worker never waits for a slow IMAP server
    worker.on("completed", (job) => {
      if (job.data.provider !== "IMAP") otherDoneAt.push(Date.now());
    });
    await worker.waitUntilReady();

    // IMAP first (as RECOVER_INCOMPLETE would enqueue the oldest incomplete emails), then Gmail / Microsoft.
    if (scenario !== "baseline") {
      for (let n = 0; n < IMAP_JOBS; n++) {
        const account = accounts[n % IMAP_MAILBOXES] as WorkerAccount;
        await queues.producer.enqueueProcessing({ organizationId: account.organizationId, emailAccountId: account.id, provider: "IMAP", providerMessageId: `7:${1 + Math.floor(n / IMAP_MAILBOXES)}` });
      }
      await vi.waitFor(() => expect(activeImap).toBe(IMAP_JOBS), { timeout: 10_000 });
    }
    const others = accounts.filter((account) => account.provider !== "IMAP");
    const enqueuedAt = Date.now();
    for (const account of others) {
      await queues.producer.enqueueProcessing({ organizationId: account.organizationId, emailAccountId: account.id, provider: account.provider, providerMessageId: `${account.id}-m1` });
    }
    const until = Date.now() + 30_000;
    while (Date.now() < until && otherDoneAt.length < others.length) await sleep(25);

    const closing = Date.now();
    abortImapOperations();
    await worker.close();
    const closeMs = Date.now() - closing;
    await pool.closeAll();
    for (const server of servers) await server.allClosed(5_000);

    const sorted = [...otherDoneAt].sort((a, b) => a - b);
    return {
      scenario,
      othersDone: otherDoneAt.length,
      firstOtherMs: sorted.length > 0 ? (sorted[0] as number) - enqueuedAt : null,
      allOthersMs: sorted.length === others.length ? (sorted[sorted.length - 1] as number) - enqueuedAt : null,
      maxActiveImap,
      imapHoldsMs: { min: Math.min(...imapHolds), max: Math.max(...imapHolds), count: imapHolds.length },
      closeMs,
      openSockets: servers.reduce((sum, server) => sum + server.openSockets(), 0),
      activeDrips: servers.reduce((sum, server) => sum + server.activeDrips(), 0),
      poolStats: pool.stats()
    };
  }

  it("baseline: without IMAP jobs the 20 Gmail / Microsoft processing jobs finish at once", async () => {
    const result = await run("baseline");
    console.log("A2 processing risk:", JSON.stringify(result));
    expect(result.othersDone).toBe(2 * OTHER_ACCOUNTS);
    expect(result.allOthersMs).toBeLessThan(FETCH_MS);
  }, 60_000);

  it("risk: 10 IMAP jobs whose message source drips take all 10 slots; Gmail / Microsoft wait one full fetch deadline", async () => {
    const result = await run("fetch");
    console.log("A2 processing risk:", JSON.stringify(result));
    expect(result.maxActiveImap).toBe(PROCESSING_CONCURRENCY);
    expect(result.firstOtherMs).toBeGreaterThanOrEqual(FETCH_MS * 0.8);
    expect(result.othersDone).toBe(2 * OTHER_ACCOUNTS);
    expect(result.openSockets).toBe(0);
    expect(result.activeDrips).toBe(0);
  }, 60_000);

  it(`risk: with ${ATTACHMENTS} pending attachments each, one IMAP job holds its slot ~${ATTACHMENTS} fetch deadlines; Gmail / Microsoft wait that long`, async () => {
    const result = await run("attachments");
    console.log("A2 processing risk:", JSON.stringify(result));
    expect(result.maxActiveImap).toBe(PROCESSING_CONCURRENCY);
    expect(result.imapHoldsMs.min).toBeGreaterThanOrEqual(ATTACHMENTS * FETCH_MS * 0.8);
    expect(result.firstOtherMs).toBeGreaterThanOrEqual(ATTACHMENTS * FETCH_MS * 0.8);
    expect(result.othersDone).toBe(2 * OTHER_ACCOUNTS);
    expect(result.openSockets).toBe(0);
    expect(result.activeDrips).toBe(0);
  }, 60_000);
});

describe.runIf(!enabled)("A2 processing risk (skipped)", () => {
  it.skip("runs only with A2_BULLMQ_URL pointing at a throwaway Valkey (see the header)", () => undefined);
});
