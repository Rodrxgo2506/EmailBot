import { addCoalescedSync, type EmailEventJob, type EmailProcessingJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { createRedisSyncLock, type LockRedis } from "../infrastructure/sync-lock.js";
import {
  ensureWatch,
  handleEmailEvent,
  MAX_MESSAGES_PER_SYNC,
  recoverySince,
  RECOVERY_MAX_WINDOW_MS,
  SyncBusyError,
  syncAccount,
  type HandleEventDeps
} from "../pipeline/handle-email-event.js";
import { handleAccountFailure } from "../pipeline/failures.js";
import { AttachmentsPendingError, processEmail, type ProcessEmailDeps, type ProcessEmailOutcome } from "../pipeline/process-email.js";
import { createGmailAdapter } from "../providers/gmail/adapter.js";
import { ProviderHttpError } from "../providers/http.js";
import { ProviderAuthError, ProviderTransientError, type ProviderAdapter, type WorkerAccount } from "../providers/types.js";
import {
  makeAccount,
  makeAccountStore,
  makeAdapter,
  makeAudit,
  makeProducer,
  makeRealtime,
  makeRegistry,
  makeRuleRow,
  MemoryEmailStore,
  MemoryRoutingStore,
  ORG,
  OTHER_ORG,
  silentLogger
} from "./fakes.js";

/*
 * EmailBot V2 phase 5.6: event-driven Gmail ingestion + recovery polling +
 * manual sync, all ending in syncAccount() and the existing pipeline.
 */

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const TOPIC = "projects/emailbot-test/topics/gmail-push";

/** In-memory lock with the Redis semantics (one holder per account). */
function memoryLock() {
  const held = new Map<string, string>();
  let counter = 0;
  return {
    held,
    acquire: vi.fn(async (id: string) => {
      if (held.has(id)) return null;
      const token = `t${++counter}`;
      held.set(id, token);
      return token;
    }),
    release: vi.fn(async (id: string, token: string) => {
      if (held.get(id) === token) held.delete(id);
    })
  };
}

function setup(options: { accounts?: WorkerAccount[]; adapter?: ProviderAdapter & Record<string, ReturnType<typeof vi.fn>>; processMessage?: HandleEventDeps["processMessage"] } = {}) {
  const accounts = options.accounts ?? [makeAccount({ syncCursor: "100", lastSyncedAt: "2026-10-05T11:00:00.000Z" })];
  const store = makeAccountStore(accounts);
  const adapter = options.adapter ?? makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["m1", "m2"], nextCursor: "120" })) });
  const calls: string[] = [];
  const processMessage = vi.fn(
    options.processMessage ??
      (async (job: EmailProcessingJob): Promise<ProcessEmailOutcome> => {
        calls.push(`process:${job.providerMessageId}`);
        return { status: "processed", emailId: `email-${job.providerMessageId}`, matchedRuleIds: [] };
      })
  );
  (store.advanceSyncCursor as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, state: { from: string | null; to: string | null; lastSyncedAt: string }) => {
    calls.push(`cursor:${state.to}`);
    const account = accounts.find((candidate) => candidate.id === id);
    if (!account || account.syncCursor !== state.from) return false;
    account.syncCursor = state.to;
    account.lastSyncedAt = state.lastSyncedAt;
    return true;
  });
  const lock = memoryLock();
  const audit = makeAudit();
  const enqueueSync = vi.fn(async (_account: { id: string; organizationId: string }, _reason?: string) => undefined);
  const enqueueWatch = vi.fn(async (_account: { id: string; organizationId: string }) => undefined);
  const deps: HandleEventDeps = {
    accounts: store,
    emails: new MemoryEmailStore(),
    producer: makeProducer(),
    providers: makeRegistry(adapter),
    createContext: (account) => ({ account, getAccessToken: async () => "access-token-secret" }),
    enqueueSync,
    enqueueWatch,
    processMessage,
    lock,
    audit,
    watchTopic: TOPIC,
    now: () => NOW,
    logger: silentLogger
  };
  return { accounts, store, adapter, processMessage, lock, audit, enqueueSync, enqueueWatch, deps, calls };
}

describe("sync: one pipeline for every ingestion source", () => {
  it.each(["PUBSUB", "POLL", "MANUAL", "PORTAL"] as const)("%s: messages go through processMessage, then the cursor moves", async (reason) => {
    const { deps, accounts, processMessage, calls } = setup();
    const result = await syncAccount(accounts[0] as WorkerAccount, deps, reason);
    expect(processMessage.mock.calls.map(([job]) => job)).toEqual([
      { organizationId: ORG, emailAccountId: "account-1", provider: "GMAIL", providerMessageId: "m1" },
      { organizationId: ORG, emailAccountId: "account-1", provider: "GMAIL", providerMessageId: "m2" }
    ]);
    expect(calls.at(-1)).toBe("cursor:120"); // after every message
    expect(result).toMatchObject({ found: 2, processed: 2, cursorAdvanced: true, historyGap: false });
    expect(accounts[0]?.syncCursor).toBe("120");
  });

  it("the real pipeline (processEmail): rules, bot, customer resolution and deliveries via the Gmail sync path", async () => {
    const account = makeAccount({ syncCursor: "100" });
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow({ id: "netflix", bot_id: "bot-netflix", bot: { status: "ACTIVE" } })];
    const routing = new MemoryRoutingStore(emails);
    routing.addBot("bot-netflix", { source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED" });
    routing.addCustomer("juan", { normalizedValue: "me@gmail.com" }, { bots: ["bot-netflix"] });
    const adapter = makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["msg-1"], nextCursor: "130" })) });
    const processDeps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]),
      emails,
      routing,
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers: makeRegistry(adapter),
      createContext: (acc) => ({ account: acc, getAccessToken: async () => "token" }),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      logger: silentLogger,
      storageRetryDelayMs: 0
    };
    const { deps } = setup({ accounts: [account], adapter, processMessage: (job) => processEmail(job, processDeps) });

    await syncAccount(account, deps, "PUBSUB");
    expect(emails.rows).toHaveLength(1);
    expect(emails.rows[0]).toMatchObject({ bot_id: "bot-netflix", processing_status: "PROCESSED", extracted_data: { verification_code: "4821" } });
    expect(routing.deliveries).toEqual([expect.objectContaining({ customer_id: "juan", resolution: "AUTOMATIC" })]);

    // The same event again (Pub/Sub at-least-once / recovery polling): nothing is duplicated.
    account.syncCursor = "100";
    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(1);
    expect(routing.deliveries).toHaveLength(1);
  });

  it("cursor never advances when a message fails (transient); the retry processes again and then advances", async () => {
    let failOnce = true;
    const { deps, accounts, store } = setup({
      processMessage: async (job) => {
        if (job.providerMessageId === "m2" && failOnce) {
          failOnce = false;
          throw new ProviderTransientError("Provider returned HTTP 503", 503);
        }
        return { status: "processed", emailId: "e", matchedRuleIds: [] };
      }
    });
    await expect(syncAccount(accounts[0] as WorkerAccount, deps)).rejects.toBeInstanceOf(ProviderTransientError);
    expect(store.advanceSyncCursor).not.toHaveBeenCalled();
    expect(accounts[0]?.syncCursor).toBe("100");
    await syncAccount(accounts[0] as WorkerAccount, deps);
    expect(accounts[0]?.syncCursor).toBe("120");
  });

  it("Gmail 429 / 5xx while listing history: cursor unchanged, error rethrown for BullMQ backoff", async () => {
    const adapter = makeAdapter({ listNewMessageIds: vi.fn(async () => Promise.reject(new ProviderTransientError("Provider returned HTTP 429", 429))) });
    const { deps, accounts, store, lock } = setup({ adapter });
    await expect(syncAccount(accounts[0] as WorkerAccount, deps)).rejects.toBeInstanceOf(ProviderTransientError);
    expect(store.advanceSyncCursor).not.toHaveBeenCalled();
    expect(lock.held.size).toBe(0); // the lease is released even on failure (a restarted worker is not blocked)
  });

  it("revoked credentials stop the run (account marked by the job runner), cursor unchanged", async () => {
    const { deps, accounts, store } = setup({
      processMessage: async () => {
        throw new ProviderAuthError("The refresh token was revoked or expired", "AUTH_REVOKED");
      }
    });
    await expect(syncAccount(accounts[0] as WorkerAccount, deps)).rejects.toBeInstanceOf(ProviderAuthError);
    expect(store.advanceSyncCursor).not.toHaveBeenCalled();
  });

  it("durable outcomes: duplicates / no matching rule (skipped), attachments pending (stored), message deleted (404)", async () => {
    const adapter = makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["dup", "pending", "gone", "nomatch"], nextCursor: "150" })) });
    const { deps, accounts } = setup({
      adapter,
      processMessage: async (job) => {
        if (job.providerMessageId === "dup") return { status: "skipped", reason: "duplicate" };
        if (job.providerMessageId === "nomatch") return { status: "skipped", reason: "no_matching_rule" };
        if (job.providerMessageId === "pending") throw new AttachmentsPendingError(1);
        throw new ProviderHttpError("Provider returned HTTP 404", 404);
      }
    });
    const result = await syncAccount(accounts[0] as WorkerAccount, deps);
    expect(result).toMatchObject({ processed: 1, skipped: 3, cursorAdvanced: true });
    expect(accounts[0]?.syncCursor).toBe("150");
  });

  it("a bounded run (hasMore) advances to the last record included and queues a continuation", async () => {
    const adapter = makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["m1"], nextCursor: "110", hasMore: true })) });
    const { deps, accounts, enqueueSync } = setup({ adapter });
    await syncAccount(accounts[0] as WorkerAccount, deps);
    expect(accounts[0]?.syncCursor).toBe("110");
    expect(enqueueSync).toHaveBeenCalledWith(accounts[0], "CONTINUATION");
    expect(adapter.listNewMessageIds).toHaveBeenCalledWith(expect.anything(), { maxMessages: MAX_MESSAGES_PER_SYNC });
  });
});

describe("history gap and controlled resync", () => {
  it("detects the gap, audits it, recovers recent messages through the pipeline and rebuilds the cursor", async () => {
    const adapter = makeAdapter({
      listNewMessageIds: vi.fn(async () => ({ messageIds: [], nextCursor: "100", historyGap: true })),
      recoverMessageIds: vi.fn(async () => ({ messageIds: ["r1", "r2"], nextCursor: "900", truncated: false }))
    });
    const { deps, accounts, processMessage, audit } = setup({ adapter });
    const result = await syncAccount(accounts[0] as WorkerAccount, deps);
    expect(adapter.recoverMessageIds).toHaveBeenCalledWith(expect.anything(), {
      since: new Date(Date.parse("2026-10-05T11:00:00.000Z") - 60 * 60 * 1000),
      maxMessages: 300
    });
    expect(processMessage.mock.calls.map(([job]) => job.providerMessageId)).toEqual(["r1", "r2"]);
    expect(result).toMatchObject({ historyGap: true, processed: 2, cursorAdvanced: true });
    expect(accounts[0]?.syncCursor).toBe("900");
    expect(audit.accountEntries).toEqual([expect.objectContaining({ event: "gmail.sync.history_gap", emailAccountId: "account-1" })]);
  });

  it("a failing recovery keeps the old cursor (no jump, retried later)", async () => {
    const adapter = makeAdapter({
      listNewMessageIds: vi.fn(async () => ({ messageIds: [], nextCursor: "100", historyGap: true })),
      recoverMessageIds: vi.fn(async () => Promise.reject(new ProviderTransientError("timeout", null)))
    });
    const { deps, accounts, store } = setup({ adapter });
    await expect(syncAccount(accounts[0] as WorkerAccount, deps)).rejects.toBeInstanceOf(ProviderTransientError);
    expect(store.advanceSyncCursor).not.toHaveBeenCalled();
    expect(accounts[0]?.syncCursor).toBe("100");
  });

  it("recovery window: since the last sync minus a margin, never more than 7 days, 1 day without history", () => {
    expect(recoverySince("2026-10-05T11:00:00.000Z", NOW).toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(recoverySince("2026-01-01T00:00:00.000Z", NOW).getTime()).toBe(NOW - RECOVERY_MAX_WINDOW_MS);
    expect(recoverySince(null, NOW).toISOString()).toBe("2026-10-04T12:00:00.000Z");
  });
});

describe("concurrency, duplicates and out-of-order notifications", () => {
  it("a second sync of the SAME account is refused while one runs (retried); other accounts run in parallel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const accounts = [makeAccount({ id: "acc-x", syncCursor: "100" }), makeAccount({ id: "acc-y", syncCursor: "500" })];
    const { deps } = setup({
      accounts,
      processMessage: async (job) => {
        if (job.emailAccountId === "acc-x") await gate;
        return { status: "processed", emailId: "e", matchedRuleIds: [] };
      }
    });
    const first = syncAccount(accounts[0] as WorkerAccount, deps);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(syncAccount(accounts[0] as WorkerAccount, deps)).rejects.toBeInstanceOf(SyncBusyError);
    await expect(syncAccount(accounts[1] as WorkerAccount, deps)).resolves.toMatchObject({ cursorAdvanced: true });
    release();
    await expect(first).resolves.toMatchObject({ cursorAdvanced: true });
  });

  it("a sync that started from a stale cursor never overwrites a newer one (compare-and-set)", async () => {
    const { deps, accounts } = setup();
    const stale = { ...(accounts[0] as WorkerAccount) };
    (accounts[0] as WorkerAccount).syncCursor = "300"; // another run advanced it meanwhile
    const result = await syncAccount(stale, deps);
    expect(result.cursorAdvanced).toBe(false);
    expect(accounts[0]?.syncCursor).toBe("300");
  });

  it("duplicated and out-of-order notifications only trigger syncs; the stored cursor decides", async () => {
    const { deps, enqueueSync } = setup();
    for (const historyId of ["200", "200", "205", "180"]) {
      await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "me@gmail.com", historyId }, deps);
    }
    expect(enqueueSync).toHaveBeenCalledTimes(4);
    expect(enqueueSync.mock.calls.every(([, reason]) => reason === "PUBSUB")).toBe(true);
    expect(deps.processMessage).not.toHaveBeenCalled();
  });

  it("unknown or inactive mailboxes trigger nothing", async () => {
    const { deps, enqueueSync } = setup({ accounts: [makeAccount({ status: "ERROR" })] });
    expect(await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "me@gmail.com", historyId: "1" }, deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "other@gmail.com", historyId: "1" }, deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(enqueueSync).not.toHaveBeenCalled();
  });
});

describe("two Gmail mailboxes of one organization (sales@ / support@)", () => {
  /** Each mailbox has its own (encrypted) tokens and its own history cursor. */
  function twoMailboxes(adapter?: ProviderAdapter & Record<string, ReturnType<typeof vi.fn>>) {
    const sales = makeAccount({ id: "acc-sales", emailAddress: "sales@example.com", syncCursor: "100", accessTokenEncrypted: "v1.sales", refreshTokenEncrypted: "v1.sales-rt" });
    const support = makeAccount({ id: "acc-support", emailAddress: "support@example.com", syncCursor: "900", accessTokenEncrypted: "v1.support", refreshTokenEncrypted: "v1.support-rt" });
    const context = setup({ accounts: [sales, support], ...(adapter ? { adapter } : {}) });
    // The real createContext decrypts the account's own token; here the token names its account.
    const createContext = vi.fn((account: WorkerAccount) => ({ account, getAccessToken: async () => `token-of-${account.accessTokenEncrypted}` }));
    context.deps.createContext = createContext;
    return { ...context, sales, support, createContext };
  }

  it("a push for sales@ queues only sales@, a push for support@ only support@", async () => {
    const { deps, enqueueSync } = twoMailboxes();
    expect(await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "sales@example.com", historyId: "150" }, deps)).toEqual({ accounts: 1, enqueued: 1 });
    expect(enqueueSync.mock.calls).toEqual([[expect.objectContaining({ id: "acc-sales" }), "PUBSUB"]]);
    enqueueSync.mockClear();
    expect(await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "support@example.com", historyId: "950" }, deps)).toEqual({ accounts: 1, enqueued: 1 });
    expect(enqueueSync.mock.calls).toEqual([[expect.objectContaining({ id: "acc-support" }), "PUBSUB"]]);
  });

  it("syncing sales@ uses only sales@'s token and cursor; support@'s cursor does not move", async () => {
    const seen: Array<{ id: string; cursor: string | null; token: string }> = [];
    const adapter = makeAdapter({
      listNewMessageIds: vi.fn(async (context: { account: WorkerAccount; getAccessToken(): Promise<string> }) => {
        seen.push({ id: context.account.id, cursor: context.account.syncCursor, token: await context.getAccessToken() });
        return { messageIds: ["m1"], nextCursor: "120" };
      })
    });
    const { deps, sales, support, processMessage, createContext } = twoMailboxes(adapter);
    await syncAccount(sales, deps);

    expect(createContext.mock.calls.map(([account]) => account.id)).toEqual(["acc-sales"]);
    expect(seen).toEqual([{ id: "acc-sales", cursor: "100", token: "token-of-v1.sales" }]);
    expect(processMessage.mock.calls.map(([job]) => job.emailAccountId)).toEqual(["acc-sales"]);
    expect(sales.syncCursor).toBe("120");
    expect(support.syncCursor).toBe("900");
  });

  it("the watch of sales@ is created with sales@'s context and recorded on sales@ only", async () => {
    const watch = vi.fn(async (_context: { account: WorkerAccount }, _topic: string) => ({ expiresAt: new Date(NOW + 7 * 86_400_000).toISOString() }));
    const { deps, store, support } = twoMailboxes(makeAdapter({ watch }));
    expect(await ensureWatch("acc-sales", ORG, deps)).toBe(true);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0]?.[0].account.id).toBe("acc-sales");
    expect(vi.mocked(store.saveWatchState).mock.calls.map(([id]) => id)).toEqual(["acc-sales"]);
    expect(support.watchExpiresAt).toBeUndefined();
  });

  it("revoked credentials on sales@ put only sales@ in ERROR; support@ keeps receiving its pushes", async () => {
    const { deps, store, enqueueSync, sales } = twoMailboxes();
    await expect(
      handleAccountFailure(new ProviderAuthError("revoked", "AUTH_REVOKED"), sales, { accounts: store, realtime: makeRealtime(), logger: silentLogger })
    ).rejects.toThrow();
    expect(vi.mocked(store.markError).mock.calls.map(([id]) => id)).toEqual(["acc-sales"]);

    await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "support@example.com", historyId: "950" }, deps);
    expect(enqueueSync.mock.calls).toEqual([[expect.objectContaining({ id: "acc-support" }), "PUBSUB"]]);
  });

  it("re-authorized from ERROR with its kept cursor: the sync resumes from it, and an expired one is recovered (history gap)", async () => {
    const listedFrom: Array<string | null> = [];
    const adapter = makeAdapter({
      listNewMessageIds: vi.fn(async (context: { account: WorkerAccount }) => {
        listedFrom.push(context.account.syncCursor);
        return { messageIds: [], nextCursor: "12345", historyGap: true };
      }),
      recoverMessageIds: vi.fn(async () => ({ messageIds: ["missed-1", "missed-2"], nextCursor: "20000", truncated: false }))
    });
    const { deps, processMessage } = twoMailboxes(adapter);
    const reconnected = makeAccount({ id: "acc-reconnected", emailAddress: "sales@example.com", syncCursor: "12345", lastSyncedAt: "2026-10-05T08:00:00.000Z" });
    (deps.accounts as unknown as { advanceSyncCursor: ReturnType<typeof vi.fn> }).advanceSyncCursor.mockImplementation(
      async (_id: string, state: { from: string | null; to: string | null }) => {
        if (reconnected.syncCursor !== state.from) return false;
        reconnected.syncCursor = state.to;
        return true;
      }
    );

    const result = await syncAccount(reconnected, deps);
    expect(listedFrom).toEqual(["12345"]);
    expect(result).toMatchObject({ historyGap: true, processed: 2, cursorAdvanced: true });
    expect(processMessage.mock.calls.map(([job]) => job.providerMessageId)).toEqual(["missed-1", "missed-2"]);
    expect(reconnected.syncCursor).toBe("20000");
  });
});

describe("Gmail watch (users.watch) creation and renewal", () => {
  const expiring = (ms: number) => new Date(NOW + ms).toISOString();

  it("creates a watch on the configured topic and records it", async () => {
    const adapter = makeAdapter({ watch: vi.fn(async () => ({ expiresAt: expiring(7 * 86_400_000) })) });
    const { deps, store, audit } = setup({ adapter });
    expect(await ensureWatch("account-1", ORG, deps)).toBe(true);
    expect(adapter.watch).toHaveBeenCalledWith(expect.anything(), TOPIC);
    expect(store.saveWatchState).toHaveBeenCalledWith("account-1", expect.objectContaining({ expiresAt: expiring(7 * 86_400_000), errorCode: null }));
    expect(audit.accountEntries).toEqual([expect.objectContaining({ event: "gmail.watch.created", action: "UPDATE" })]);
  });

  it("a valid watch is not recreated; one expiring within a day is renewed", async () => {
    const valid = makeAccount({ id: "valid", watchExpiresAt: expiring(3 * 86_400_000) });
    const soon = makeAccount({ id: "soon", watchExpiresAt: expiring(2 * 3_600_000) });
    const adapter = makeAdapter({ watch: vi.fn(async () => ({ expiresAt: expiring(7 * 86_400_000) })) });
    const { deps, audit } = setup({ accounts: [valid, soon], adapter });
    expect(await ensureWatch("valid", ORG, deps)).toBe(false);
    expect(await ensureWatch("soon", ORG, deps)).toBe(true);
    expect(adapter.watch).toHaveBeenCalledTimes(1);
    expect(audit.accountEntries.map((entry) => entry.event)).toEqual(["gmail.watch.renewed"]);
  });

  it("a rejected watch (e.g. topic permissions) is recorded and does not throw: polling continues", async () => {
    const adapter = makeAdapter({ watch: vi.fn(async () => Promise.reject(new ProviderHttpError("Provider returned HTTP 403", 403))) });
    const { deps, store, audit } = setup({ adapter });
    expect(await ensureWatch("account-1", ORG, deps)).toBe(false);
    expect(store.saveWatchState).toHaveBeenCalledWith("account-1", expect.objectContaining({ errorCode: "HTTP_403" }));
    expect(audit.accountEntries).toEqual([expect.objectContaining({ event: "gmail.watch.failed", action: "FAIL", metadata: { errorCode: "HTTP_403" } })]);
  });

  it("credentials and transient failures are rethrown (account marked / retried by the job runner)", async () => {
    for (const error of [new ProviderAuthError("revoked", "AUTH_REVOKED"), new ProviderTransientError("HTTP 503", 503)]) {
      const adapter = makeAdapter({ watch: vi.fn(async () => Promise.reject(error)) });
      const { deps } = setup({ adapter });
      await expect(ensureWatch("account-1", ORG, deps)).rejects.toBe(error);
    }
  });

  it("no topic configured, another organization, non-Gmail or inactive accounts: nothing", async () => {
    const adapter = makeAdapter({ watch: vi.fn(async () => ({ expiresAt: expiring(7 * 86_400_000) })) });
    const accounts = [makeAccount({ id: "ms", provider: "MICROSOFT" }), makeAccount({ id: "off", status: "ERROR" }), makeAccount({ id: "susp", organizationStatus: "SUSPENDED" })];
    const { deps } = setup({ accounts: [...accounts, makeAccount()], adapter });
    for (const id of ["ms", "off", "susp"]) expect(await ensureWatch(id, ORG, deps)).toBe(false);
    expect(await ensureWatch("account-1", OTHER_ORG, deps)).toBe(false);
    expect(await ensureWatch("account-1", ORG, { ...deps, watchTopic: null })).toBe(false);
    expect(adapter.watch).not.toHaveBeenCalled();
  });

  it("RENEW_WATCHES queues only due Gmail accounts; disabled without a topic", async () => {
    const due = makeAccount({ id: "due", watchExpiresAt: expiring(3_600_000) });
    const fresh = makeAccount({ id: "fresh", watchExpiresAt: expiring(5 * 86_400_000) });
    const none = makeAccount({ id: "none" });
    const { deps, enqueueWatch } = setup({ accounts: [due, fresh, none] });
    expect(await handleEmailEvent({ type: "RENEW_WATCHES" }, deps)).toEqual({ accounts: 2, enqueued: 2 });
    expect(enqueueWatch.mock.calls.map(([account]) => account.id).sort()).toEqual(["due", "none"]);
    expect(await handleEmailEvent({ type: "RENEW_WATCHES" }, { ...deps, watchTopic: null })).toEqual({ accounts: 0, enqueued: 0 });
  });
});

describe("Gmail adapter: history pagination, bounded runs, recovery listing, watch", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const context = (account = makeAccount({ syncCursor: "100" })) => ({ account, getAccessToken: vi.fn(async () => "access") });

  it("follows every page and ends at the mailbox history id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ history: [{ id: "101", messagesAdded: [{ message: { id: "a" } }] }], historyId: "150", nextPageToken: "p2" }))
      .mockResolvedValueOnce(json({ history: [{ id: "120", messagesAdded: [{ message: { id: "b" } }] }], historyId: "150", nextPageToken: "p3" }))
      .mockResolvedValueOnce(json({ history: [{ id: "140", messagesAdded: [{ message: { id: "c" } }] }], historyId: "160" }));
    const changes = await createGmailAdapter(fetchMock as unknown as typeof fetch).listNewMessageIds(context());
    expect(changes).toEqual({ messageIds: ["a", "b", "c"], nextCursor: "160" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("pageToken=p3");
  });

  it("a bounded run stops at a record boundary: cursor = last record included, never the latest id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json({
        history: [
          { id: "101", messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] },
          { id: "102", messagesAdded: [{ message: { id: "c" } }, { message: { id: "d" } }] }
        ],
        historyId: "999"
      })
    );
    const changes = await createGmailAdapter(fetchMock as unknown as typeof fetch).listNewMessageIds(context(), { maxMessages: 3 });
    expect(changes).toEqual({ messageIds: ["a", "b"], nextCursor: "101", hasMore: true });
  });

  it("recovery lists recent INBOX mail after `since` (bounded) and takes the mailbox position first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ historyId: "900" }))
      .mockResolvedValueOnce(json({ messages: [{ id: "n2" }, { id: "n1" }], nextPageToken: "x" }))
      .mockResolvedValueOnce(json({ messages: [{ id: "n0" }] }));
    const since = new Date("2026-10-05T10:00:00.000Z");
    const recovery = await createGmailAdapter(fetchMock as unknown as typeof fetch).recoverMessageIds?.(context(), { since, maxMessages: 10 });
    expect(recovery).toEqual({ messageIds: ["n0", "n1", "n2"], nextCursor: "900", truncated: false });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/profile");
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))).toContain(`q=after:${since.getTime() / 1000}`);
  });

  it("watch: POST users/me/watch on the topic (INBOX), refreshing the token once on 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ historyId: "77", expiration: String(NOW + 7 * 86_400_000) }));
    const ctx = context();
    const result = await createGmailAdapter(fetchMock as unknown as typeof fetch).watch?.(ctx, TOPIC);
    expect(result).toEqual({ expiresAt: new Date(NOW + 7 * 86_400_000).toISOString() });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/watch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" });
    expect(ctx.getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
  });
});

describe("queues and lock infrastructure", () => {
  function fakeQueue(existing: Record<string, string> = {}) {
    const jobs = new Map(Object.entries(existing));
    const added: Array<{ id: string; data: EmailEventJob }> = [];
    const queue = {
      getJob: vi.fn(async (id: string) =>
        jobs.has(id) ? { getState: async () => jobs.get(id), remove: vi.fn(async () => void jobs.delete(id)) } : undefined
      ),
      add: vi.fn(async (_name: string, data: EmailEventJob, options: { jobId: string }) => {
        if (!jobs.has(options.jobId)) {
          jobs.set(options.jobId, "waiting");
          added.push({ id: options.jobId, data });
        }
      })
    };
    return { queue, added };
  }
  const account = { id: "acc-1", organizationId: ORG };

  it("coalesces: one waiting sync per account, one follow-up while it runs, nothing more", async () => {
    const empty = fakeQueue();
    expect(await addCoalescedSync(empty.queue as never, account, "PUBSUB")).toBe(true);
    expect(await addCoalescedSync(empty.queue as never, account, "PORTAL")).toBe(false); // already waiting
    expect(empty.added.map((job) => job.id)).toEqual(["sync-acc-1"]);

    const running = fakeQueue({ "sync-acc-1": "active" });
    expect(await addCoalescedSync(running.queue as never, account, "PUBSUB")).toBe(true);
    expect(await addCoalescedSync(running.queue as never, account, "PUBSUB")).toBe(false);
    expect(running.added.map((job) => job.id)).toEqual(["sync-acc-1-next"]);

    const finished = fakeQueue({ "sync-acc-1": "completed" });
    expect(await addCoalescedSync(finished.queue as never, account, "POLL")).toBe(true);
  });

  it("job payloads carry ids and a reason only (never tokens or credentials)", async () => {
    const { queue, added } = fakeQueue();
    await addCoalescedSync(queue as never, account, "PORTAL");
    expect(Object.keys(added[0]?.data ?? {}).sort()).toEqual(["emailAccountId", "organizationId", "reason", "requestedBy", "type"]);
    expect(JSON.stringify(added)).not.toMatch(/token|secret|password|credential/i);
  });

  it("Redis lock: SET NX PX to acquire; only the holder releases (compare-and-delete)", async () => {
    const store = new Map<string, string>();
    const redis: LockRedis = {
      set: vi.fn(async (key: string, value: string) => {
        if (store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      eval: vi.fn(async (_script: string, _keys: number, key: string | number, token: string | number) => {
        if (store.get(String(key)) === String(token)) store.delete(String(key));
        return 1;
      })
    };
    const lock = createRedisSyncLock(redis);
    const token = await lock.acquire("acc-1", 1000);
    expect(token).toEqual(expect.any(String));
    expect(await lock.acquire("acc-1", 1000)).toBeNull();
    expect(await lock.acquire("acc-2", 1000)).toEqual(expect.any(String)); // other accounts are independent
    await lock.release("acc-1", "not-mine");
    expect(store.has("emailbot-sync-lock:acc-1")).toBe(true);
    await lock.release("acc-1", token as string);
    expect(store.has("emailbot-sync-lock:acc-1")).toBe(false);
    expect(redis.set).toHaveBeenCalledWith("emailbot-sync-lock:acc-1", expect.any(String), "PX", 1000, "NX");
  });
});

