import { QUEUE_NAMES, type EmailEventJob } from "@emailbot/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createImapSyncSlots, imapSyncSlotCount } from "../infrastructure/imap-slots.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import { createWorkerQueues } from "../infrastructure/queues.js";
import type { HandleEventDeps, ImapSyncSlots } from "../pipeline/handle-email-event.js";
import type { ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { abortImapOperations, resetImapAbortForTests, runningImapOperations } from "../providers/imap/deadline.js";
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
 * IMAP A2 - CRITICAL isolation test, against REAL BullMQ (opt-in: A2_BULLMQ_URL must name a THROWAWAY
 * Valkey on this machine, checked by the same guard as the E4 Valkey suite; CI never sets it).
 *
 * What really runs: a BullMQ Worker on the email-events queue with concurrency 5 (WORKER_EVENTS_CONCURRENCY's
 * default) and the production processors (job-processors.ts: failure mapping + the "IMAP slots busy -> delayed"
 * path), jobs added by the production queue helpers (createWorkerQueues -> addCoalescedSync), the real
 * handleEmailEvent -> syncAccount -> processEmail pipeline, and the real IMAP adapter + pool + deadlines with a
 * real ImapFlow against 6 local IMAP servers that answer UID SEARCH byte by byte forever (saturated IMAP).
 * In memory: the database stores (accounts, emails, routing) and the Gmail / Microsoft APIs (fake adapters).
 *
 * Control: the same run WITHOUT the IMAP slots must starve Gmail / Microsoft (proves the test can fail).
 *
 * The database is emptied between scenarios only after a2-bullmq-target.ts proved it belongs to these suites
 * (empty at the start, one suite at a time). Run together with imap-a2-processing-risk.test.ts only with
 * --no-file-parallelism (docs/imap.md, "Worker"). Every resource is closed in `finally`, also on failure.
 */

const RAW_URL = process.env.A2_BULLMQ_URL ?? "";
const enabled = RAW_URL !== "";
// The E4.4 guard of the Valkey suites (apps/api/src/test/valkey-target.ts), loaded as is (not duplicated):
// only redis:// or rediss:// over TCP to 127.0.0.1, localhost or [::1]; anything else throws before any client exists.
const GUARD_MODULE = "../../../api/src/test/valkey-target.ts";
const guard = enabled ? ((await import(new URL(GUARD_MODULE, import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string }) : null;
const TARGET = guard ? guard.assertLocalValkeyUrl(RAW_URL) : "";
const EVENTS_CONCURRENCY = 5;
const IMAP_ACCOUNTS = 6;
const OTHER_ACCOUNTS = 10; // per provider
const SUITE = "imap-a2-isolation";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(enabled)("A2: IMAP cannot take the events slots of Gmail / Microsoft (real BullMQ)", () => {
  const servers: SlowServer[] = [];
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(TARGET, { maxRetriesPerRequest: null });
    await claimThrowawayValkey(admin, SUITE);
    for (let n = 0; n < IMAP_ACCOUNTS; n++) servers.push(await startSlowImapServer({ search: "drip", dripMs: 200 }));
  });
  afterAll(async () => {
    for (const server of servers) await server.stop();
    if (admin) await releaseClaimedValkey(admin, SUITE).finally(() => admin.quit());
  });

  async function scenario(withSlots: boolean, windowMs: number) {
    resetImapAbortForTests();
    await resetClaimedValkey(admin, SUITE);
    const cleanup = cleanupSteps();
    try {
      return await runScenario(withSlots, windowMs, cleanup);
    } finally {
      await cleanup.run();
    }
  }

  async function runScenario(withSlots: boolean, windowMs: number, cleanup: CleanupSteps) {
    const queueConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => queueConnection.quit());
    const workerConnection = new Redis(TARGET, { maxRetriesPerRequest: null });
    cleanup.defer(() => workerConnection.quit());
    const queues = createWorkerQueues(queueConnection);
    cleanup.defer(() => queues.close());

    // Accounts: 6 IMAP (one slow server each), 10 Gmail, 10 Microsoft.
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
      accounts.push(makeAccount({ id: `gmail-${n}`, provider: "GMAIL", emailAddress: `g${n}@gmail.com`, syncCursor: "100" }));
      accounts.push(makeAccount({ id: `microsoft-${n}`, provider: "MICROSOFT", emailAddress: `m${n}@outlook.com`, syncCursor: "100" }));
    }
    const store = makeAccountStore(accounts);
    const pool = new ImapConnectionPool<ImapClient>();
    cleanup.defer(() => pool.closeAll());
    const imap = createImapSyncAdapter({
      pool,
      connect: (_endpoint, credentials) => openImapClient(localImapOptions(portByUser.get(credentials.username)!), credentials)
    });
    const oauth = (provider: "GMAIL" | "MICROSOFT"): ProviderAdapter =>
      makeAdapter({
        provider,
        listNewMessageIds: vi.fn(async (context) => ({ messageIds: [`${context.account.id}-m1`, `${context.account.id}-m2`], nextCursor: "102" })),
        fetchMessage: vi.fn(async (_context, id: string) => makeEmail({ providerMessageId: id, provider }))
      });
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
    const slots: (ImapSyncSlots & { inUse(): number }) | undefined = withSlots ? createImapSyncSlots(imapSyncSlotCount(EVENTS_CONCURRENCY, 2)) : undefined;
    const eventDeps: Omit<HandleEventDeps, "logger"> = {
      accounts: store,
      emails,
      producer: queues.producer,
      providers,
      createContext,
      enqueueSync: (account, reason) => queues.enqueueSync(account, reason),
      imapSyncEnabled: true,
      ...(slots ? { imapSlots: slots } : {})
    };
    const logger = { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) };
    const processors = createJobProcessors({
      eventDeps,
      processDeps,
      accounts: store,
      realtime: makeRealtime(),
      logger: logger as never,
      reportJobFailure: vi.fn(),
      jobType: (data) => (data as EmailEventJob).type
    });

    const completed = new Set<string>();
    const failed: string[] = [];
    let activeImap = 0;
    let maxActiveImap = 0;
    const worker = new Worker<EmailEventJob>(
      QUEUE_NAMES.emailEvents,
      async (job, token) => {
        const imapJob = job.data.type === "SYNC_ACCOUNT" && job.data.emailAccountId.startsWith("imap-");
        if (imapJob) activeImap += 1;
        maxActiveImap = Math.max(maxActiveImap, activeImap);
        try {
          return await processors.events(job, token);
        } finally {
          if (imapJob) activeImap -= 1;
        }
      },
      { connection: workerConnection, concurrency: EVENTS_CONCURRENCY }
    );
    cleanup.defer(() => worker.close());
    cleanup.defer(() => abortImapOperations()); // runs first: the worker never waits for a slow IMAP server
    worker.on("completed", (job) => {
      if (job.data.type === "SYNC_ACCOUNT") completed.add(job.data.emailAccountId);
    });
    worker.on("failed", (job, error) => {
      if (job && error.name !== "DelayedError") failed.push(`${job.data.type}:${error.message}`);
    });
    await worker.waitUntilReady();

    // IMAP first (it fills what it can), then the Gmail / Microsoft work.
    const imapAccounts = accounts.filter((account) => account.provider === "IMAP");
    const others = accounts.filter((account) => account.provider !== "IMAP");
    for (const account of imapAccounts) await queues.enqueueSync(account, "POLL");
    await vi.waitFor(() => expect(runningImapOperations()).toBeGreaterThanOrEqual(withSlots ? 2 : EVENTS_CONCURRENCY), { timeout: 10_000 });
    const enqueuedAt = Date.now();
    for (const account of others) await queues.enqueueSync(account, "POLL");

    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline && [...completed].filter((id) => !id.startsWith("imap-")).length < others.length) await sleep(50);
    const othersDone = [...completed].filter((id) => !id.startsWith("imap-")).length;
    const othersMs = Date.now() - enqueuedAt;
    const imapStillRunning = runningImapOperations();
    const imapCompleted = [...completed].filter((id) => id.startsWith("imap-")).length;
    const delayedImap = (await Promise.all(imapAccounts.map((account) => queues.emailEvents.getJob(`sync-${account.id}`))))
      .filter((job) => job !== undefined)
      .map((job) => job!);
    const delayedStates = await Promise.all(delayedImap.map((job) => job.getState()));
    const attempts = delayedImap.map((job) => job.attemptsMade);
    const failedBeforeShutdown = [...failed];

    // Shutdown as index.ts does it: close the IMAP operations first, then the worker (bounded).
    const closing = Date.now();
    abortImapOperations();
    await worker.close();
    const closeMs = Date.now() - closing;
    await pool.closeAll();
    for (const server of servers) await server.allClosed(5_000);

    return {
      othersDone,
      othersMs,
      maxActiveImap,
      imapStillRunning,
      imapCompleted,
      delayedStates,
      attempts,
      failed: failedBeforeShutdown,
      closeMs,
      storedOthers: emails.rows.length,
      openSockets: servers.reduce((sum, server) => sum + server.openSockets(), 0),
      activeDrips: servers.reduce((sum, server) => sum + server.activeDrips(), 0),
      poolStats: pool.stats()
    };
  }

  it("with the IMAP slots (production wiring): 6 saturated IMAP mailboxes take at most 2 slots; all 20 Gmail / Microsoft syncs finish", async () => {
    const run = await scenario(true, 15_000);
    console.log("A2 isolation (slots on):", JSON.stringify(run));
    expect(run.othersDone).toBe(2 * OTHER_ACCOUNTS);
    expect(run.storedOthers).toBe(2 * OTHER_ACCOUNTS * 2); // 2 messages each, really processed
    expect(run.maxActiveImap).toBeLessThanOrEqual(2 + 1); // 2 holding slots (+1 briefly checking a slot before delaying)
    expect(run.imapStillRunning).toBe(2); // IMAP is still saturated while the others finished
    expect(run.imapCompleted).toBe(0);
    expect(run.delayedStates.filter((state) => state === "delayed").length).toBeGreaterThanOrEqual(IMAP_ACCOUNTS - 2);
    expect(run.attempts.every((attempts) => attempts === 0)).toBe(true); // delaying never used an attempt
    expect(run.failed).toEqual([]);
    expect(run.closeMs).toBeLessThan(5_000); // shutdown never waits for the slow IMAP servers
    expect(run.openSockets).toBe(0);
    expect(run.activeDrips).toBe(0);
    expect(run.poolStats).toMatchObject({ open: 0, busy: 0, opening: 0 });
  }, 60_000);

  it("control WITHOUT the slots (the A2 risk): the saturated IMAP mailboxes take all 5 slots and Gmail / Microsoft do not advance", async () => {
    const run = await scenario(false, 5_000);
    console.log("A2 isolation (control, slots off):", JSON.stringify(run));
    expect(run.maxActiveImap).toBe(EVENTS_CONCURRENCY);
    expect(run.othersDone).toBe(0);
    expect(run.closeMs).toBeLessThan(5_000);
    expect(run.openSockets).toBe(0);
  }, 60_000);
});

describe.runIf(!enabled)("A2 isolation (skipped)", () => {
  it.skip("runs only with A2_BULLMQ_URL pointing at a throwaway Valkey (see the header)", () => undefined);
});
