import type { EmailEventJob, EmailProcessingJob } from "@emailbot/shared";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImapSyncSlots, imapSyncSlotCount } from "../infrastructure/imap-slots.js";
import { createJobProcessors, IMAP_SLOT_RETRY_DELAY_MS } from "../infrastructure/job-processors.js";
import { ImapSlotsBusyError, syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import type { ProcessEmailOutcome } from "../pipeline/process-email.js";
import { formatImapCursor, parseImapCursor, parseImapMessageId } from "../providers/imap/cursor.js";
import { ImapDeadlineError, resetImapAbortForTests } from "../providers/imap/deadline.js";
import { ProviderAuthError, ProviderTransientError, type ChangeSet, type ProviderAdapter, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRealtime, silentLogger } from "./fakes.js";

/*
 * IMAP A2: the cursor only moves past the CONTIGUOUS prefix of durably handled messages (never past a
 * pending, failed or unstarted one), the run budget, M1's pause / disconnect semantics, the in-process IMAP
 * slots and the job runner's "slots busy -> delayed". The IMAP adapter is in memory here (its deadlines are
 * covered with a real ImapFlow in imap-a2-deadlines.test.ts) so the order in which messages finish is exact.
 */

afterEach(() => resetImapAbortForTests());

type Behaviour = { delayMs?: number; fail?: Error; halt?: boolean };

interface Mailbox {
  uidValidity: number;
  uids: number[];
  outOfWindow?: number[];
  /** History gap: the next listing answers historyGap and recovery lists these (new UIDVALIDITY). */
  recovery?: { uidValidity: number; uids: number[] };
}

function imapAdapter(box: Mailbox): ProviderAdapter & { listNewMessageIds: ReturnType<typeof vi.fn> } {
  return {
    provider: "IMAP",
    listNewMessageIds: vi.fn(async (context): Promise<ChangeSet> => {
      const cursor = parseImapCursor(context.account.syncCursor);
      if (!cursor) return { messageIds: [], nextCursor: formatImapCursor({ uidValidity: box.uidValidity, uid: Math.max(0, ...box.uids) }) };
      if (cursor.uidValidity !== box.uidValidity) return { messageIds: [], nextCursor: null, historyGap: true };
      const after = (uid: number) => uid > cursor.uid;
      const taken = box.uids.filter(after);
      const outside = (box.outOfWindow ?? []).filter(after);
      const top = Math.max(cursor.uid, ...taken, ...outside);
      return {
        messageIds: taken.map((uid) => `${box.uidValidity}:${uid}`),
        nextCursor: formatImapCursor({ uidValidity: box.uidValidity, uid: top }),
        hasMore: false,
        outOfWindow: outside.length,
        outOfWindowUids: outside
      };
    }),
    recoverMessageIds: vi.fn(async () => {
      const recovery = box.recovery!;
      return {
        messageIds: recovery.uids.map((uid) => `${recovery.uidValidity}:${uid}`),
        nextCursor: formatImapCursor({ uidValidity: recovery.uidValidity, uid: Math.max(...recovery.uids) }),
        truncated: false
      };
    }),
    fetchMessage: vi.fn(),
    downloadAttachment: vi.fn()
  } as unknown as ProviderAdapter & { listNewMessageIds: ReturnType<typeof vi.fn> };
}

const imapAccount = (overrides: Partial<WorkerAccount> = {}) =>
  makeAccount({
    id: "imap-1",
    provider: "IMAP",
    syncCursor: "imap:v1:7:0",
    emailAddress: "ventas@empresa-correo.com",
    providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: "ventas@empresa-correo.com" } },
    accessTokenEncrypted: "v2.x",
    ...overrides
  });

/** A pipeline that stores each message once (provider message id), with per-UID behaviour. */
function harness(account: WorkerAccount, box: Mailbox, behaviours: Record<number, Behaviour> = {}, extra: Partial<HandleEventDeps> = {}) {
  const accounts = makeAccountStore([account]);
  const audit = makeAudit();
  const stored = new Map<string, number>();
  const started: number[] = [];
  const finished: number[] = [];
  const imap = imapAdapter(box);
  const processMessage = vi.fn(async (job: EmailProcessingJob): Promise<ProcessEmailOutcome> => {
    const ref = parseImapMessageId(job.providerMessageId)!;
    started.push(ref.uid);
    const behaviour = behaviours[ref.uid] ?? {};
    await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs ?? 5));
    if (behaviour.halt || account.status !== "ACTIVE") return { status: "skipped", reason: "account_inactive" };
    if (behaviour.fail) throw behaviour.fail;
    finished.push(ref.uid);
    if (stored.has(job.providerMessageId)) return { status: "skipped", reason: "duplicate" };
    stored.set(job.providerMessageId, (stored.get(job.providerMessageId) ?? 0) + 1);
    return { status: "processed", emailId: `email-${ref.uid}`, matchedRuleIds: [] };
  });
  const deps: HandleEventDeps = {
    accounts,
    emails: { listIncompleteEmails: vi.fn(async () => []), updateProcessingState: vi.fn() },
    producer: makeProducer(),
    providers: { GMAIL: makeAdapter(), MICROSOFT: makeAdapter({ provider: "MICROSOFT" }), IMAP: imap },
    createContext: (acc) => ({ account: acc, getAccessToken: () => Promise.reject(new Error("not OAuth")), getImapCredentials: async () => ({ username: "u", password: "p" }) }),
    enqueueSync: vi.fn(async () => undefined),
    processMessage,
    audit,
    logger: silentLogger,
    imapSyncEnabled: true,
    ...extra
  };
  return { deps, accounts, audit, stored, started, finished, imap, processMessage };
}

const transient = (_uid: number) => new ImapDeadlineError("fetch", "deadline");
const windowAudits = (audit: ReturnType<typeof makeAudit>) =>
  audit.recordAccountEvent.mock.calls.map(([entry]) => entry).filter((entry) => entry.event === "imap.sync.outside_window");

describe("A2: contiguous-prefix cursor (IMAP)", () => {
  it("11+12. out-of-order completion with a failed message in the middle: the cursor stops just before it", async () => {
    const account = imapAccount();
    // 6 messages, 3 at a time; 1 is the slowest, 3 fails (its deadline), 4-6 finish before 1.
    const { deps, stored, finished } = harness(account, { uidValidity: 7, uids: [1, 2, 3, 4, 5, 6] }, {
      1: { delayMs: 250 },
      2: { delayMs: 20 },
      3: { delayMs: 40, fail: transient(3) },
      4: { delayMs: 5 },
      5: { delayMs: 5 },
      6: { delayMs: 5 }
    });
    const error = await syncAccount(account, deps, "POLL").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderTransientError); // retried with backoff; never an account ERROR
    expect(finished.indexOf(6)).toBeLessThan(finished.indexOf(1)); // really out of order
    expect([...stored.keys()].sort()).toEqual(["7:1", "7:2", "7:4", "7:5", "7:6"]);
    // 4, 5 and 6 are stored, but 3 is pending: the cursor never jumps it.
    expect(account.syncCursor).toBe("imap:v1:7:2");
  });

  it("13. the retry resumes from that cursor: the failed message is processed, the later ones are not duplicated", async () => {
    const account = imapAccount();
    const behaviours: Record<number, Behaviour> = { 3: { fail: transient(3) } };
    const { deps, stored } = harness(account, { uidValidity: 7, uids: [1, 2, 3, 4, 5, 6] }, behaviours);
    await syncAccount(account, deps, "POLL").catch(() => undefined);
    expect(account.syncCursor).toBe("imap:v1:7:2");
    delete behaviours[3];
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(true);
    expect(account.syncCursor).toBe("imap:v1:7:6");
    expect([...stored.entries()].sort()).toEqual([1, 2, 3, 4, 5, 6].map((uid) => [`7:${uid}`, 1]));
  });

  it("a failure in the FIRST message: the cursor does not move at all", async () => {
    const account = imapAccount();
    const { deps } = harness(account, { uidValidity: 7, uids: [1, 2, 3] }, { 1: { delayMs: 50, fail: transient(1) } });
    await expect(syncAccount(account, deps, "POLL")).rejects.toBeInstanceOf(ProviderTransientError);
    expect(account.syncCursor).toBe("imap:v1:7:0");
  });

  it("7. run budget: no message is started after the soft limit; the cursor stops at the last finished prefix and a continuation is queued", async () => {
    const account = imapAccount();
    const uids = Array.from({ length: 20 }, (_, index) => index + 1);
    const behaviours = Object.fromEntries(uids.map((uid) => [uid, { delayMs: 100 }]));
    const { deps, stored, started } = harness(account, { uidValidity: 7, uids }, behaviours, { imapRunBudget: { softMs: 250, hardMs: 5_000 } });
    const result = await syncAccount(account, deps, "POLL");
    expect(result.hasMore).toBe(true);
    expect(deps.enqueueSync).toHaveBeenCalledWith(account, "CONTINUATION");
    expect(started.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(20);
    const lastStarted = Math.max(...started);
    expect(account.syncCursor).toBe(`imap:v1:7:${lastStarted}`);
    expect(stored.size).toBe(started.length);
    // The continuation (no budget pressure) processes the rest exactly once.
    const rest = await syncAccount(account, { ...deps, imapRunBudget: { softMs: 60_000, hardMs: 120_000 } }, "CONTINUATION");
    expect(rest.cursorAdvanced).toBe(true);
    expect(account.syncCursor).toBe("imap:v1:7:20");
    expect([...stored.values()].every((count) => count === 1) && stored.size === 20).toBe(true);
  });

  it("9. pause during the run (M1 kept): the run halts and the cursor does not move, even with a finished prefix", async () => {
    const account = imapAccount();
    const { deps, stored } = harness(account, { uidValidity: 7, uids: [1, 2, 3, 4, 5, 6] }, { 2: { delayMs: 30 } });
    const pausing = deps.processMessage!;
    let paused = false;
    deps.processMessage = vi.fn(async (job: EmailProcessingJob) => {
      const outcome = await pausing(job);
      // The user pauses once, right after message 2 (the resume below must not pause again).
      if (job.providerMessageId === "7:2" && !paused) {
        paused = true;
        account.status = "PAUSED";
      }
      return outcome;
    });
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(false);
    expect(account.syncCursor).toBe("imap:v1:7:0");
    expect(stored.size).toBeLessThan(6);
    // Resume: everything else is processed, nothing twice.
    account.status = "ACTIVE";
    await syncAccount(account, deps, "POLL");
    expect(account.syncCursor).toBe("imap:v1:7:6");
    expect([...stored.values()].every((count) => count === 1) && stored.size === 6).toBe(true);
  });

  it("10. disconnection during the run: halted, cursor unchanged, no account error written", async () => {
    const account = imapAccount();
    const { deps, accounts } = harness(account, { uidValidity: 7, uids: [1, 2, 3, 4] }, { 1: { delayMs: 30 } });
    const original = deps.processMessage!;
    deps.processMessage = vi.fn(async (job: EmailProcessingJob) => {
      const outcome = await original(job);
      account.status = "DISCONNECTED";
      account.syncCursor = null;
      return outcome;
    });
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(false);
    expect(account.status).toBe("DISCONNECTED");
    expect(account.syncCursor).toBeNull();
    expect(accounts.markError).not.toHaveBeenCalled();
  });

  it("a partial run reports only the out-of-window messages behind its cursor; the rest are reported once later", async () => {
    const account = imapAccount();
    const behaviours: Record<number, Behaviour> = { 4: { delayMs: 20, fail: transient(4) } };
    const { deps, audit, stored } = harness(account, { uidValidity: 7, uids: [2, 4, 6], outOfWindow: [1, 3, 5] }, behaviours);
    await syncAccount(account, deps, "POLL").catch(() => undefined);
    expect(account.syncCursor).toBe("imap:v1:7:3");
    expect(windowAudits(audit).map((entry) => entry.metadata.count)).toEqual([2]);
    delete behaviours[4];
    await syncAccount(account, deps, "POLL");
    expect(account.syncCursor).toBe("imap:v1:7:6");
    expect(windowAudits(audit).map((entry) => entry.metadata.count)).toEqual([2, 1]);
    expect([...stored.keys()].sort()).toEqual(["7:2", "7:4", "7:6"]);
  });

  it("14. UIDVALIDITY changed: a partial recovery moves the cursor into the NEW UIDVALIDITY before the pending message; the next run finishes", async () => {
    const account = imapAccount({ syncCursor: "imap:v1:7:5" });
    const box: Mailbox = { uidValidity: 9, uids: [10, 11, 12], recovery: { uidValidity: 9, uids: [10, 11, 12] } };
    const behaviours: Record<number, Behaviour> = { 11: { delayMs: 20, fail: transient(11) } };
    const { deps, stored } = harness(account, box, behaviours);
    await expect(syncAccount(account, deps, "POLL")).rejects.toBeInstanceOf(ProviderTransientError);
    expect(account.syncCursor).toBe("imap:v1:9:10");
    delete behaviours[11];
    await syncAccount(account, deps, "POLL");
    expect(account.syncCursor).toBe("imap:v1:9:12");
    expect([...stored.entries()].sort()).toEqual([["9:10", 1], ["9:11", 1], ["9:12", 1]]);
  });

  it("an account error (refused login) is still fatal: thrown at once, cursor unchanged", async () => {
    const account = imapAccount();
    const { deps } = harness(account, { uidValidity: 7, uids: [1, 2, 3] }, { 2: { fail: new ProviderAuthError("refused", "IMAP_AUTH_FAILED") } });
    await expect(syncAccount(account, deps, "POLL")).rejects.toBeInstanceOf(ProviderAuthError);
    expect(account.syncCursor).toBe("imap:v1:7:0");
  });

  it("Gmail is unchanged: a failed message keeps the cursor where it was, no IMAP budget or slot is involved", async () => {
    const account = makeAccount({ syncCursor: "100" });
    const accounts = makeAccountStore([account]);
    const slots = createImapSyncSlots(1);
    const gmail = makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["a", "b", "c"], nextCursor: "103" })) });
    const processMessage = vi.fn(async (job: EmailProcessingJob): Promise<ProcessEmailOutcome> => {
      if (job.providerMessageId === "b") throw new Error("boom");
      return { status: "processed", emailId: job.providerMessageId, matchedRuleIds: [] };
    });
    const deps: HandleEventDeps = {
      accounts,
      emails: { listIncompleteEmails: vi.fn(async () => []), updateProcessingState: vi.fn() },
      producer: makeProducer(),
      providers: { GMAIL: gmail, MICROSOFT: gmail, IMAP: gmail },
      createContext: (acc) => ({ account: acc, getAccessToken: async () => "t" }),
      enqueueSync: vi.fn(async () => undefined),
      processMessage,
      logger: silentLogger,
      imapSlots: slots,
      imapRunBudget: { softMs: 0, hardMs: 0 }
    };
    await expect(syncAccount(account, deps, "POLL")).rejects.toThrow("boom");
    expect(account.syncCursor).toBe("100");
    expect(processMessage).toHaveBeenCalledTimes(3); // no budget: every message attempted
    expect(slots.inUse()).toBe(0);
  });
});

describe("A2: IMAP slots in one process", () => {
  it("at most `max` IMAP runs at once: the next one throws ImapSlotsBusyError before touching anything; Gmail is never limited", async () => {
    const slots = createImapSyncSlots(1);
    const first = imapAccount({ id: "imap-a" });
    const second = imapAccount({ id: "imap-b" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = harness(first, { uidValidity: 7, uids: [1] }, {}, { imapSlots: slots });
    const original = a.deps.processMessage!;
    a.deps.processMessage = vi.fn(async (job: EmailProcessingJob) => {
      await gate;
      return original(job);
    });
    const running = syncAccount(first, a.deps, "POLL");
    await vi.waitFor(() => expect(slots.inUse()).toBe(1));

    const b = harness(second, { uidValidity: 7, uids: [1] }, {}, { imapSlots: slots });
    await expect(syncAccount(second, b.deps, "POLL")).rejects.toBeInstanceOf(ImapSlotsBusyError);
    expect(b.imap.listNewMessageIds).not.toHaveBeenCalled();
    expect(second.syncCursor).toBe("imap:v1:7:0");

    // Gmail is not limited by the IMAP slots.
    const gmailAccount = makeAccount({ id: "gmail-1" });
    const gmailDeps = { ...b.deps, accounts: makeAccountStore([gmailAccount]), processMessage: vi.fn(async () => ({ status: "processed", emailId: "x", matchedRuleIds: [] }) as ProcessEmailOutcome) };
    gmailDeps.providers = { ...b.deps.providers, GMAIL: makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["g1"], nextCursor: "101" })) }) };
    expect((await syncAccount(gmailAccount, gmailDeps, "POLL")).cursorAdvanced).toBe(true);

    release();
    await running;
    expect(slots.inUse()).toBe(0);
    expect((await syncAccount(second, b.deps, "POLL")).cursorAdvanced).toBe(true);
  });

  it("a slot is released when the run fails", async () => {
    const slots = createImapSyncSlots(1);
    const account = imapAccount();
    const { deps } = harness(account, { uidValidity: 7, uids: [1] }, { 1: { fail: transient(1) } }, { imapSlots: slots });
    await expect(syncAccount(account, deps, "POLL")).rejects.toBeInstanceOf(ProviderTransientError);
    expect(slots.inUse()).toBe(0);
  });

  it("slot count: the configured share, always leaving one events slot to Gmail / Microsoft", () => {
    expect(imapSyncSlotCount(5, 2)).toBe(2);
    expect(imapSyncSlotCount(5, 10)).toBe(4);
    expect(imapSyncSlotCount(2, 2)).toBe(1);
    expect(imapSyncSlotCount(1, 2)).toBe(1);
  });
});

describe("A2: job runner (events queue)", () => {
  function fakeJob(data: EmailEventJob) {
    return {
      id: "sync-imap-b",
      queueName: "email-events",
      name: data.type,
      data,
      attemptsMade: 0,
      opts: { attempts: 5 },
      moveToDelayed: vi.fn(async () => undefined)
    } as unknown as Job<EmailEventJob> & { moveToDelayed: ReturnType<typeof vi.fn> };
  }
  function processors(account: WorkerAccount, slots = createImapSyncSlots(0)) {
    const accounts = makeAccountStore([account]);
    const realtime = makeRealtime();
    const reportJobFailure = vi.fn();
    const box = harness(account, { uidValidity: 7, uids: [1] }, {}, { accounts });
    const runner = createJobProcessors({
      eventDeps: { ...box.deps, imapSlots: slots },
      processDeps: {} as never,
      accounts,
      realtime,
      logger: { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) } as never,
      reportJobFailure,
      jobType: () => "SYNC_ACCOUNT",
      random: () => 0.5
    });
    return { runner, accounts, realtime, reportJobFailure };
  }

  it("IMAP slots busy: the job is moved back to delayed with its token (no attempt used, nothing marked, nothing reported)", async () => {
    const account = imapAccount({ id: "imap-b" });
    const { runner, accounts, realtime, reportJobFailure } = processors(account);
    const job = fakeJob({ type: "SYNC_ACCOUNT", emailAccountId: "imap-b", organizationId: account.organizationId, requestedBy: null, reason: "POLL" });
    const before = Date.now();
    await expect(runner.events(job, "lock-token")).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = job.moveToDelayed.mock.calls[0]!;
    expect(token).toBe("lock-token");
    expect(timestamp).toBeGreaterThanOrEqual(before + IMAP_SLOT_RETRY_DELAY_MS);
    expect(timestamp).toBeLessThanOrEqual(Date.now() + IMAP_SLOT_RETRY_DELAY_MS + 5_000);
    expect(accounts.markError).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
    expect(reportJobFailure).not.toHaveBeenCalled();
    expect(job.attemptsMade).toBe(0);
  });

  it("other failures keep their mapping (an IMAP auth failure: account ERROR, UnrecoverableError, never delayed)", async () => {
    const account = imapAccount({ id: "imap-c" });
    const accounts = makeAccountStore([account]);
    const box = harness(account, { uidValidity: 7, uids: [1] }, {}, { accounts });
    box.imap.listNewMessageIds.mockRejectedValueOnce(new ProviderAuthError("refused", "IMAP_AUTH_FAILED"));
    const runner = createJobProcessors({
      eventDeps: { ...box.deps, imapSlots: createImapSyncSlots(1) },
      processDeps: {} as never,
      accounts,
      realtime: makeRealtime(),
      logger: { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) } as never,
      reportJobFailure: vi.fn(),
      jobType: () => "SYNC_ACCOUNT"
    });
    const job = fakeJob({ type: "SYNC_ACCOUNT", emailAccountId: "imap-c", organizationId: account.organizationId, requestedBy: null, reason: "POLL" });
    await expect(runner.events(job, "t")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(accounts.markError).toHaveBeenCalledWith("imap-c", expect.objectContaining({ code: "IMAP_AUTH_FAILED", status: "ERROR" }));
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
