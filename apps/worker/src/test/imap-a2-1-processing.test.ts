import type { EmailProcessingJob } from "@emailbot/shared";
import { DelayedError, type Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { createImapSyncSlots, imapSyncSlotCount } from "../infrastructure/imap-slots.js";
import { createJobProcessors, IMAP_SLOT_RETRY_DELAY_MS } from "../infrastructure/job-processors.js";
import type { ImapSyncSlots } from "../pipeline/handle-email-event.js";
import { AttachmentsPendingError, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import {
  abortImapOperations,
  IMAP_OPERATION_DEADLINES,
  IMAP_PROCESSING_BUDGET,
  ImapDeadlineError,
  resetImapAbortForTests,
  runImapOperation,
  runningImapOperations,
  assertImapOperationAlive,
  type ImapRunBudgetLimits
} from "../providers/imap/deadline.js";
import { imapMessageScopeStats, rememberImapSource, withImapMessageScope } from "../providers/imap/message-scope.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { ProviderHttpError } from "../providers/http.js";
import { ProviderTransientError, type ProviderAdapter, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { IMAP_TEST_ORGANIZATION_IDS, makeAccount, makeAccountStore, makeAdapter, makeAudit, makeEmail, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";
import { localImapOptions, SLOW_LOGIN, startSlowImapServer, type SlowServer, type SlowServerOptions } from "./slow-imap-server.js";

/*
 * IMAP A2.1: the email-processing processor (job-processors.ts `processing`, the production code) for jobs of an
 * IMAP mailbox: its own slots (busy -> back to "delayed" with the job's token), its run budget (start limit, each
 * operation's own deadline, hard limit) and its message scope (the message it read serves its attachments).
 * Everything below the processor is real: processEmail (new-email, resume and completed-email paths, attachment
 * completion), the IMAP adapter, pool, deadlines and message scope, and ImapFlow against a local server that serves
 * real multipart messages with attachments, can drip from its Nth download on or answer a download slowly. In
 * memory: the database, Storage and the Gmail / Microsoft APIs. Deadlines and budgets are scaled down (seconds
 * instead of minutes); the cancellation is the real one (sockets closed, checked on the server side).
 * The BullMQ-level behaviour is in imap-a2-1-processing-isolation.test.ts.
 */

const DEADLINES = { connectMs: 1_000, listMs: 1_500, fetchMs: 1_500 };
const SLACK_MS = 1_000;
const ATTACHMENTS = 3;
const LONG_BUDGET: ImapRunBudgetLimits = { softMs: 10_000, startMs: 10_000, hardMs: 10_000 };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  resetImapAbortForTests();
  for (const step of cleanup.splice(0).reverse()) await step();
});

// Nothing may reject unhandled after an operation was closed (late rejections are consumed).
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeAll(() => void process.on("unhandledRejection", onUnhandled));
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

type CountingSlots = ImapSyncSlots & { inUse(): number; acquired: number; released: number; tryAcquire: Mock };

/** The production slots, counting every acquisition and release (a slot must be released exactly once). */
function countingSlots(max: number): CountingSlots {
  const slots = createImapSyncSlots(max);
  const counting = {
    acquired: 0,
    released: 0,
    inUse: () => slots.inUse(),
    tryAcquire: vi.fn(() => {
      const taken = slots.tryAcquire();
      if (taken) counting.acquired += 1;
      return taken;
    }),
    release: () => {
      counting.released += 1;
      slots.release();
    }
  };
  return counting;
}

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const uploads: string[] = [];
  const failing = new Set<string>();
  return {
    objects,
    uploads,
    /** Filenames whose upload fails (Storage down for them). */
    failing,
    storage: {
      exists: vi.fn(async (_bucket: string, path: string) => objects.has(path)),
      upload: vi.fn(async (_bucket: string, path: string, content: Uint8Array) => {
        if ([...failing].some((name) => path.endsWith(name))) throw new Error("storage unavailable");
        uploads.push(path);
        objects.set(path, content);
      })
    }
  };
}

interface SetupOptions {
  slots?: number | null;
  budget?: ImapRunBudgetLimits;
  deadlines?: Partial<typeof DEADLINES>;
  pool?: ConstructorParameters<typeof ImapConnectionPool>[0];
  account?: Partial<WorkerAccount>;
  imapSyncEnabled?: boolean;
}

async function setup(serverOptions: SlowServerOptions = {}, options: SetupOptions = {}) {
  const server = await startSlowImapServer({ attachments: ATTACHMENTS, ...serverOptions });
  cleanup.push(() => server.stop());
  const pool = new ImapConnectionPool<ImapClient>(options.pool ?? {});
  cleanup.push(() => pool.closeAll());
  const imap = createImapSyncAdapter({
    pool,
    connect: (_endpoint, credentials) => openImapClient(localImapOptions(server.port), credentials),
    deadlines: { ...DEADLINES, ...options.deadlines }
  });
  const account = makeAccount({
    id: "imap-a21",
    provider: "IMAP",
    emailAddress: SLOW_LOGIN.username,
    syncCursor: "imap:v1:7:3",
    accessTokenEncrypted: "v2.not-used-here",
    providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: SLOW_LOGIN.username } },
    ...options.account
  });
  const gmail = makeAccount({ id: "gmail-a21", provider: "GMAIL", emailAddress: "g@gmail.com" });
  const accounts = makeAccountStore([account, gmail]);
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
  const store = memoryStorage();
  const gmailFetch = vi.fn(async (_context: unknown, id: string) => makeEmail({ providerMessageId: id, internetMessageId: `<${id}@x>` }));
  const providers = {
    IMAP: imap,
    GMAIL: makeAdapter({ provider: "GMAIL", fetchMessage: gmailFetch }),
    MICROSOFT: makeAdapter({ provider: "MICROSOFT" })
  } as unknown as Record<"IMAP" | "GMAIL" | "MICROSOFT", ProviderAdapter>;
  const scopeBytesSeen: number[] = [];
  const processDeps: Omit<ProcessEmailDeps, "logger"> = {
    accounts,
    emails,
    routing: new MemoryRoutingStore(emails),
    audit: makeAudit(),
    storage: {
      exists: store.storage.exists,
      upload: vi.fn(async (bucket: string, path: string, content: Uint8Array) => {
        scopeBytesSeen.push(imapMessageScopeStats().bytes); // memory held by the job while it stores contents
        return store.storage.upload(bucket, path, content);
      })
    },
    realtime: makeRealtime(),
    producer: makeProducer(),
    providers,
    createContext: (target: WorkerAccount) => ({ account: target, getAccessToken: async () => "token", getImapCredentials: async () => SLOW_LOGIN }),
    attachmentsBucket: "email-attachments",
    maxAttachmentBytes: 1_000_000,
    storageRetryDelayMs: 0,
    imapSyncEnabled: options.imapSyncEnabled ?? true,
    imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
  };
  const slots = options.slots === null ? undefined : countingSlots(options.slots ?? 1);
  const reportJobFailure = vi.fn();
  const runner = createJobProcessors({
    eventDeps: {} as never,
    processDeps,
    accounts,
    realtime: makeRealtime(),
    logger: { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) } as never,
    reportJobFailure,
    jobType: () => "process-email",
    random: () => 0.5,
    ...(slots ? { imapProcessingSlots: slots } : {}),
    imapProcessingBudget: options.budget ?? LONG_BUDGET
  });
  const context: ProviderContext = { account, getAccessToken: async () => "", getImapCredentials: async () => SLOW_LOGIN };
  return { server, pool, imap, account, context, gmail, accounts, emails, store, slots, runner, reportJobFailure, gmailFetch, scopeBytesSeen };
}

type Box = Awaited<ReturnType<typeof setup>>;
type FakeJob = Job<EmailProcessingJob> & { moveToDelayed: Mock; attemptsMade: number };

function processingJob(account: WorkerAccount, providerMessageId: string, id = `resume-${providerMessageId}`): FakeJob {
  return {
    id,
    queueName: "email-processing",
    name: "process-email",
    data: { organizationId: account.organizationId, emailAccountId: account.id, provider: account.provider, providerMessageId },
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed: vi.fn(async () => undefined)
  } as unknown as FakeJob;
}

/** An email already stored for "7:1" with its 3 attachment rows (`uploaded`: contents already in Storage). */
function seedEmail(box: Box, status: "PROCESSING" | "FAILED", uploaded: number[] = []) {
  box.emails.rows.push({
    organization_id: box.account.organizationId,
    email_account_id: box.account.id,
    provider_message_id: "7:1",
    processing_status: status,
    processing_attempts: 3,
    processing_started_at: new Date(Date.now() - 3_600_000).toISOString(),
    processing_error_code: status === "PROCESSING" ? "ATTACHMENTS_PENDING" : "RECOVERY_EXHAUSTED",
    bot_id: null,
    provider_metadata: {},
    extracted_data: {}
  } as never);
  for (let n = 0; n < ATTACHMENTS; n++) {
    const path = `seeded/factura-${n}.pdf`;
    box.emails.attachments.push({
      id: `attachment-${n + 1}`,
      email_id: "email-1",
      organization_id: box.account.organizationId,
      provider_attachment_id: `part-${n}`,
      filename: `factura-${n}.pdf`,
      content_type: "application/pdf",
      file_size: 40,
      content_id: null,
      is_inline: false,
      ...(uploaded.includes(n) ? { storage_uploaded: true, storage_path: path } : {})
    } as never);
  }
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = Date.now();
  try {
    return { value: await promise, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

/** The connection really ended: server sockets closed, no drip or delayed answer pending, no IMAP operation left. */
async function expectClosed(server: SlowServer) {
  await server.allClosed(SLACK_MS);
  expect(server.openSockets()).toBe(0);
  expect(server.activeDrips()).toBe(0);
  expect(server.pendingDelays()).toBe(0);
  expect(runningImapOperations()).toBe(0);
}

const scopesReleased = () => expect(imapMessageScopeStats()).toEqual({ open: 0, bytes: 0 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe("A2.1: IMAP slots of the email-processing processor (production processor, real ImapFlow)", () => {
  it("two IMAP jobs race for the last slot: one runs, the other is moved back to delayed with its token; the slot is released once", async () => {
    const box = await setup({ dripSourceFrom: 1 }, { slots: 1 });
    const first = processingJob(box.account, "7:1");
    const second = processingJob(box.account, "7:2");
    const before = Date.now();
    // Both start in the same tick: the slot is taken synchronously, so exactly one wins.
    const [a, b] = await Promise.all([settle(box.runner.processing(first, "token-a")), settle(box.runner.processing(second, "token-b"))]);

    expect(b.error).toBeInstanceOf(DelayedError);
    expect(second.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = second.moveToDelayed.mock.calls[0]!;
    expect(token).toBe("token-b");
    expect(timestamp).toBeGreaterThanOrEqual(before + IMAP_SLOT_RETRY_DELAY_MS);
    expect(second.attemptsMade).toBe(0);
    // The winner ran the real pipeline and failed transient at its message deadline (retried by BullMQ).
    expect(a.error).toBeInstanceOf(ImapDeadlineError);
    expect(first.moveToDelayed).not.toHaveBeenCalled();
    expect(box.slots).toMatchObject({ acquired: 1, released: 1 });
    expect(box.slots!.inUse()).toBe(0);
    expect(box.reportJobFailure).toHaveBeenCalledTimes(1); // the winner's real failure only, never the delay
    await expectClosed(box.server);
    scopesReleased();
  });

  it("the delayed job, run again later, takes the freed slot and processes the email (3 attachments stored)", async () => {
    const box = await setup({ dripSourceFrom: 1 }, { slots: 1 });
    const holder = processingJob(box.account, "7:1");
    const delayed = processingJob(box.account, "7:2");
    const running = settle(box.runner.processing(holder, "t1"));
    await expect(box.runner.processing(delayed, "t2")).rejects.toBeInstanceOf(DelayedError);
    await running;
    box.server.options.dripSourceFrom = 0; // the server answers normally again
    const outcome = await box.runner.processing(delayed, "t2-retry");
    expect(outcome).toMatchObject({ status: "processed" });
    expect(box.store.uploads).toHaveLength(ATTACHMENTS);
    expect(box.slots).toMatchObject({ acquired: 2, released: 2 });
    expect(box.slots!.inUse()).toBe(0);
  });

  it("BullMQ refuses the move (e.g. lost lock): the error is thrown as is (not DelayedError), no slot is held", async () => {
    const box = await setup({}, { slots: 0 });
    const job = processingJob(box.account, "7:1");
    job.moveToDelayed.mockRejectedValueOnce(new Error("Missing lock for job resume-7:1. moveToDelayed"));
    const result = await settle(box.runner.processing(job, "stale-token"));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(DelayedError);
    expect((result.error as Error).message).toContain("Missing lock");
    expect(box.slots).toMatchObject({ acquired: 0, released: 0 });
    expect(box.server.connections()).toBe(0);
  });
});

describe("A2.1 (C): the message read by a job serves its attachments", () => {
  it("1. 30 attachments: the message is read ONCE (not once per attachment), 30 contents stored exactly once, memory released", async () => {
    const box = await setup({ attachments: 30 }, { slots: 1 });
    const outcome = await box.runner.processing(processingJob(box.account, "7:1"), "t");
    expect(outcome).toMatchObject({ status: "processed" });
    expect(box.server.sourceFetches()).toBe(1); // fetchMessage only; the 30 downloads came from the job's copy
    expect(box.emails.attachments).toHaveLength(30);
    expect(box.emails.attachments.every((row) => row.storage_uploaded)).toBe(true);
    expect(box.store.uploads).toHaveLength(30);
    expect(new Set(box.store.uploads).size).toBe(30);
    // The stored bytes are the right attachments (factura-<n> of message 1, in order).
    const first = box.emails.attachments.find((row) => row.provider_attachment_id === "part-7")!;
    expect(text(box.store.objects.get(first.storage_path!)!)).toBe("%PDF-1.4 factura 7 del mensaje 1");
    expect(Math.max(...box.scopeBytesSeen)).toBeGreaterThan(0); // held while the job ran...
    expect(Math.max(...box.scopeBytesSeen)).toBeLessThanOrEqual(10 * 1024 * 1024); // ...never above maxMessageBytes
    scopesReleased(); // ...and released when it ended
    expect(box.slots).toMatchObject({ acquired: 1, released: 1 });
  });

  it("the reported failure: every read takes 95% of its deadline and the message has 30 attachments -> PROCESSED in ONE run", async () => {
    // Before C + A this stored 0 attachments per run (the first download's deadline was cut below what it needed)
    // and the email ended FAILED after 25 runs. Scale: fetchMs 1 s = 180 s, start limit 2 s = 6 min, hard 3 s = 9 min.
    const box = await setup({ attachments: 30, sourceDelayMs: 950 }, { slots: 1, budget: { softMs: 2_000, startMs: 2_000, hardMs: 3_000 }, deadlines: { fetchMs: 1_000 } });
    const result = await settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    expect(result.value).toMatchObject({ status: "processed" });
    expect(box.server.sourceFetches()).toBe(1);
    expect(box.store.uploads).toHaveLength(30);
    expect(box.emails.rows[0]).toMatchObject({ processing_status: "PROCESSED", processing_attempts: 1 });
    scopesReleased();
  });

  it("2. a slow IMAP download with several attachments: the slow read happens once, not once per attachment", async () => {
    const box = await setup({ attachments: 5, sourceDelayMs: 1_000 }, { slots: 1 });
    const result = await settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    expect(result.value).toMatchObject({ status: "processed" });
    expect(box.server.sourceFetches()).toBe(1);
    expect(result.ms).toBeLessThan(2 * 1_000); // 6 slow reads would take 6 s
    expect(box.store.uploads).toHaveLength(5);
    scopesReleased();
  });

  it("3 + 4. a retry after a failure re-reads the message once and stores only the missing contents (no duplicates)", async () => {
    const box = await setup({ attachments: 30 }, { slots: 1 });
    box.store.failing.add("factura-29.pdf"); // Storage refuses this one (3 tries in the job)
    const job = processingJob(box.account, "7:1");
    const first = await settle(box.runner.processing(job, "t"));
    expect(first.error).toBeInstanceOf(AttachmentsPendingError);
    expect((first.error as AttachmentsPendingError).pending).toBe(1);
    expect(box.emails.rows[0]).toMatchObject({ processing_status: "PROCESSING", processing_error_code: "ATTACHMENTS_PENDING" });
    expect(box.store.uploads).toHaveLength(29);
    scopesReleased(); // failure: released too

    box.store.failing.clear();
    job.attemptsMade = 1;
    const retry = await box.runner.processing(job, "t-retry");
    expect(retry).toMatchObject({ status: "resumed", insertedAttachments: 0 });
    expect(box.emails.rows[0]).toMatchObject({ processing_status: "PROCESSED" });
    expect(box.server.sourceFetches()).toBe(2); // one read per job run, not 30
    expect(box.store.uploads).toHaveLength(30);
    expect(new Set(box.store.uploads).size).toBe(30); // each content uploaded exactly once over both runs
    expect(box.emails.attachments).toHaveLength(30);
    scopesReleased();
  });

  it("5. a different UIDVALIDITY is never served from the job's copy (it goes to the server, which no longer has it)", async () => {
    const box = await setup({ uidValidity: 7 });
    await withImapMessageScope(async () => {
      await box.imap.fetchMessage(box.context, "7:1");
      expect(box.server.sourceFetches()).toBe(1);
      // Same account and UID, older generation: not the job's message.
      await expect(box.imap.downloadAttachment(box.context, "8:1", "part-0")).rejects.toMatchObject({ status: 404 });
      await expect(box.imap.downloadAttachment(box.context, "8:1", "part-0")).rejects.toBeInstanceOf(ProviderHttpError);
      expect(box.server.sourceFetches()).toBe(1); // refused by the server's UIDVALIDITY check, never from memory
      // The job's own message (same UIDVALIDITY) is still served from memory.
      expect(text(await box.imap.downloadAttachment(box.context, "7:1", "part-0"))).toBe("%PDF-1.4 factura 0 del mensaje 1");
      expect(box.server.sourceFetches()).toBe(1);
    });
    scopesReleased();
  });

  it("6. two accounts, same UIDVALIDITY and UID: each gets its own mailbox's bytes, never the other one's", async () => {
    const a = await setup({ label: "buzon-A" });
    const b = await setup({ label: "buzon-B" }, { account: { id: "imap-b", emailAddress: "otro@empresa-correo.com" } });
    await withImapMessageScope(async () => {
      await a.imap.fetchMessage(a.context, "7:1");
      // B's download of the same "7:1": B's server, B's bytes.
      expect(text(await b.imap.downloadAttachment(b.context, "7:1", "part-0"))).toBe("%PDF-1.4 factura 0 del mensaje 1 buzon-B");
      expect(b.server.sourceFetches()).toBe(1);
      // One message per scope: B's read replaced A's; A reads its own mailbox again, never B's copy.
      expect(text(await a.imap.downloadAttachment(a.context, "7:1", "part-1"))).toBe("%PDF-1.4 factura 1 del mensaje 1 buzon-A");
      expect(a.server.sourceFetches()).toBe(2);
    });
    scopesReleased();
  });

  it("7. memory is released after success, failure and cancellation; nothing is remembered outside a job or after it", async () => {
    const box = await setup({}, { slots: 1 });
    // Outside a job (e.g. a synchronization run): nothing is kept.
    await box.imap.fetchMessage(box.context, "7:1");
    scopesReleased();
    // Cancellation: a slow read stopped by the worker shutdown.
    box.server.options.sourceDelayMs = 3_000;
    const running = settle(box.runner.processing(processingJob(box.account, "7:2"), "t"));
    await vi.waitFor(() => expect(box.server.pendingDelays()).toBe(1));
    abortImapOperations();
    expect((await running).error).toMatchObject({ reason: "shutdown" });
    await expectClosed(box.server);
    scopesReleased();
    // A late result of an operation that already expired is never kept (the adapter checks before remembering).
    resetImapAbortForTests();
    await withImapMessageScope(async () => {
      const late = runImapOperation("fetch", 50, async () => {
        await sleep(150);
        assertImapOperationAlive();
        rememberImapSource({ accountId: "imap-a21", uidValidity: 7, uid: 9 }, new Uint8Array(1024), 10 * 1024 * 1024);
      });
      await expect(late).rejects.toBeInstanceOf(ImapDeadlineError);
      await sleep(200);
      expect(imapMessageScopeStats().bytes).toBe(0);
    });
    scopesReleased();
  });
});

describe("A2.1 (A): start limit, each operation's own deadline, hard limit", () => {
  it("1. an operation started before the start limit completes within its own deadline (not cut at the start limit)", async () => {
    // The message read takes 2 s; the start limit is at 1 s, the hard limit at 3.5 s, the read's deadline 2.5 s.
    const box = await setup({ sourceDelayMs: 2_000 }, { slots: 1, budget: { softMs: 1_000, startMs: 1_000, hardMs: 3_500 }, deadlines: { fetchMs: 2_500 } });
    const result = await settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    expect(result.value).toMatchObject({ status: "processed" });
    expect(result.ms).toBeGreaterThanOrEqual(1_900);
    expect(box.server.sourceFetches()).toBe(1);
    expect(box.store.uploads).toHaveLength(ATTACHMENTS); // after the start limit, from the job's copy (no IMAP operation)
    expect(box.server.connections()).toBe(1);
    scopesReleased();
  });

  it("2a. the start limit passes while the job waits for a pooled connection: it never opens or uses one afterwards", async () => {
    // One connection per mailbox; a listing holds it (UID SEARCH drips) and is cut at 1.5 s, after the start limit.
    const box = await setup(
      { search: "drip" },
      { slots: 1, budget: { softMs: 1_000, startMs: 1_000, hardMs: 6_000 }, deadlines: { listMs: 1_500, fetchMs: 4_000 }, pool: { maxPerKey: 1 }, account: { syncCursor: "imap:v1:7:0" } }
    );
    const holder = settle(box.imap.listNewMessageIds(box.context));
    await vi.waitFor(() => expect(box.server.connections()).toBe(1));
    const result = await settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    expect(result.error).toBeInstanceOf(ImapDeadlineError);
    expect(result.error).toMatchObject({ reason: "run_budget" });
    expect(result.error).toBeInstanceOf(ProviderTransientError); // retried, never an account error
    expect(result.ms).toBeLessThan(1_500 + SLACK_MS); // when the slot freed (1.5 s), not at its 4 s deadline
    await holder;
    await sleep(300);
    expect(box.server.connections()).toBe(1); // no new connection
    expect(box.server.sourceFetches()).toBe(0);
    expect(box.slots).toMatchObject({ acquired: 1, released: 1 });
    await expectClosed(box.server);
    scopesReleased();
  });

  it("2b. the hard limit comes while the job waits for a pooled connection: closed then, no connection afterwards", async () => {
    const box = await setup(
      { search: "drip" },
      { slots: 1, budget: { softMs: 1_000, startMs: 1_000, hardMs: 1_000 }, deadlines: { listMs: 4_000 }, pool: { maxPerKey: 1 }, account: { syncCursor: "imap:v1:7:0" } }
    );
    const holder = settle(box.imap.listNewMessageIds(box.context));
    await vi.waitFor(() => expect(box.server.connections()).toBe(1));
    const result = await settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    expect(result.error).toMatchObject({ reason: "run_budget" });
    expect(result.ms).toBeLessThan(1_000 + SLACK_MS);
    await holder; // cut at 4 s: frees the pool slot...
    await sleep(500);
    expect(box.server.connections()).toBe(1); // ...and the expired job never connects
    expect(box.slots).toMatchObject({ acquired: 1, released: 1 });
    await expectClosed(box.server);
  });

  it("3. the start limit passes while an attachment is downloaded: that download finishes, the others come from the job's copy", async () => {
    // A completed (FAILED) email with 3 contents missing: no message read first, the attachments go to the server.
    const box = await setup({ sourceDelayMs: 2_000 }, { slots: 1, budget: { softMs: 1_000, startMs: 1_000, hardMs: 3_500 }, deadlines: { fetchMs: 2_500 } });
    seedEmail(box, "FAILED");
    const outcome = await box.runner.processing(processingJob(box.account, "7:1"), "t");
    expect(outcome).toMatchObject({ status: "skipped", reason: "duplicate" }); // completed emails keep their status
    expect(box.server.sourceFetches()).toBe(1);
    expect(box.emails.attachments.every((row) => row.storage_uploaded)).toBe(true);
    expect(box.store.uploads).toHaveLength(ATTACHMENTS);
    scopesReleased();
  });

  it("4 + 5 + 6. a download still running at the hard limit is closed then (socket destroyed); no other operation starts", async () => {
    // The download drips forever; its own deadline (30 s) is longer than the hard limit (2.5 s).
    const box = await setup({ dripSourceFrom: 1 }, { slots: 1, budget: { softMs: 1_000, startMs: 1_000, hardMs: 2_500 }, deadlines: { fetchMs: 30_000 } });
    seedEmail(box, "FAILED");
    const result = await settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    expect(result.value).toMatchObject({ status: "skipped", reason: "duplicate" });
    expect(result.ms).toBeGreaterThanOrEqual(2_300); // not at the start limit (1 s)...
    expect(result.ms).toBeLessThan(2_500 + SLACK_MS); // ...nor at the 30 s operation deadline
    await expectClosed(box.server); // the socket really closed on the server side
    expect(box.server.sourceFetches()).toBe(1); // attachments 1 and 2 never started
    expect(box.server.connections()).toBe(1);
    expect(box.store.storage.exists).toHaveBeenCalledTimes(1); // nor even looked up
    expect(box.store.uploads).toHaveLength(0);
    expect(box.emails.attachments.some((row) => row.storage_uploaded)).toBe(false); // still recoverable
    await sleep(300);
    expect(box.store.uploads).toHaveLength(0); // nothing stored late
    expect(box.slots).toMatchObject({ acquired: 1, released: 1 });
    scopesReleased();
  });

  it("7. an email with contents pending stays resumable (never PROCESSED) when the message read is cut; the retry completes it once", async () => {
    const box = await setup({ dripSourceFrom: 1 }, { slots: 1, budget: { softMs: 1_000, startMs: 1_000, hardMs: 2_000 }, deadlines: { fetchMs: 30_000 } });
    seedEmail(box, "PROCESSING", [0]);
    box.store.objects.set("seeded/factura-0.pdf", new Uint8Array([1]));
    const job = processingJob(box.account, "7:1");
    const first = await settle(box.runner.processing(job, "t"));
    expect(first.error).toMatchObject({ reason: "run_budget" }); // transient: BullMQ retries
    expect(first.ms).toBeLessThan(2_000 + SLACK_MS);
    expect(box.emails.rows[0]).toMatchObject({ processing_status: "PROCESSING", processing_attempts: 4 });
    expect(box.emails.attachments.filter((row) => row.storage_uploaded)).toHaveLength(1);
    await expectClosed(box.server);

    box.server.options.dripSourceFrom = 0;
    job.attemptsMade = 1;
    const retry = await box.runner.processing(job, "t-retry");
    expect(retry).toMatchObject({ status: "resumed", insertedAttachments: 0 });
    expect(box.emails.rows[0]).toMatchObject({ processing_status: "PROCESSED" });
    expect(box.store.uploads).toHaveLength(2); // only the 2 missing ones
    expect(new Set(box.store.uploads).size).toBe(2);
    expect(box.server.sourceFetches()).toBe(2);
    scopesReleased();
  });

  it("worker shutdown during the message read: closed at once, no further operation, slot and memory released; a new job opens nothing", async () => {
    const box = await setup({ dripSourceFrom: 1 }, { slots: 2, budget: { softMs: 60_000, startMs: 60_000, hardMs: 60_000 }, deadlines: { fetchMs: 60_000 } });
    seedEmail(box, "PROCESSING");
    const running = settle(box.runner.processing(processingJob(box.account, "7:1"), "t"));
    await vi.waitFor(() => expect(box.server.activeDrips()).toBe(1));
    const abortedAt = Date.now();
    abortImapOperations();
    const result = await running;
    expect(Date.now() - abortedAt).toBeLessThan(SLACK_MS);
    expect(result.error).toMatchObject({ reason: "shutdown" }); // transient: resumed after the restart
    expect(box.emails.rows[0]).toMatchObject({ processing_status: "PROCESSING" });
    await expectClosed(box.server);
    expect(box.server.sourceFetches()).toBe(1);
    expect(box.slots!.inUse()).toBe(0);
    scopesReleased();

    const connections = box.server.connections();
    const late = await settle(box.runner.processing(processingJob(box.account, "7:2"), "t2"));
    expect(late.error).toMatchObject({ reason: "shutdown" });
    expect(box.server.connections()).toBe(connections);
    expect(box.slots).toMatchObject({ acquired: 2, released: 2 });
  });
});

describe("A2.1: lifecycle and other providers", () => {
  for (const status of ["PAUSED", "DISCONNECTED"] as const) {
    it(`a ${status} mailbox: the job is skipped before any IMAP operation (M1), slot released`, async () => {
      const box = await setup({}, { slots: 1, account: { status } });
      const outcome = await box.runner.processing(processingJob(box.account, "7:1"), "t");
      expect(outcome).toMatchObject({ status: "skipped", reason: "account_inactive" });
      expect(box.server.connections()).toBe(0);
      expect(box.slots).toMatchObject({ acquired: 1, released: 1 });
      scopesReleased();
    });
  }

  it("Gmail / Microsoft never touch the IMAP slots (even all busy) and run exactly as before", async () => {
    const box = await setup({}, { slots: 0 });
    const job = processingJob(box.gmail, "g-1");
    const outcome = await box.runner.processing(job, "t");
    expect(outcome).toMatchObject({ status: "processed" });
    expect(box.slots!.tryAcquire).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(box.gmailFetch).toHaveBeenCalledTimes(1);
    expect(box.scopeBytesSeen).toEqual([]); // no attachment, no scope
  });

  it("IMAP disabled (no slots wired, as index.ts does): the unchanged path skips the job without connecting", async () => {
    const box = await setup({}, { slots: null, imapSyncEnabled: false });
    const outcome = await box.runner.processing(processingJob(box.account, "7:1"), "t");
    expect(outcome).toMatchObject({ status: "skipped", reason: "imap_disabled" });
    expect(box.server.connections()).toBe(0);
  });

  it("slot count and budget: never every processing slot (from 2 up); a started operation keeps its full deadline", () => {
    expect(imapSyncSlotCount(10, 2)).toBe(2);
    expect(imapSyncSlotCount(10, 50)).toBe(9);
    expect(imapSyncSlotCount(2, 2)).toBe(1);
    expect(imapSyncSlotCount(1, 2)).toBe(1); // a queue of 1 reserves nothing (documented)
    expect(IMAP_PROCESSING_BUDGET).toEqual({ softMs: 6 * 60_000, startMs: 6 * 60_000, hardMs: 9 * 60_000 });
    // An operation started at the start limit still has its whole deadline before the hard limit.
    expect(IMAP_PROCESSING_BUDGET.hardMs - IMAP_PROCESSING_BUDGET.startMs).toBeGreaterThanOrEqual(IMAP_OPERATION_DEADLINES.fetchMs);
    expect(IMAP_PROCESSING_BUDGET.hardMs - IMAP_PROCESSING_BUDGET.startMs).toBeGreaterThanOrEqual(IMAP_OPERATION_DEADLINES.listMs);
  });
});
