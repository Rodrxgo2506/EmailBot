import type { EmailProcessingJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { createAccountStore } from "../infrastructure/supabase-stores.js";
import { handleAccountFailure } from "../pipeline/failures.js";
import { IMAP_MAX_MESSAGES_PER_SYNC, RECOVERY_MAX_WINDOW_MS, syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import type { CommercialAccess } from "../pipeline/ports.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import type { ImapClient } from "../providers/imap/connection.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { ProviderAuthError, ProviderSecurityError, ProviderTransientError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, ORG, silentLogger } from "./fakes.js";

/*
 * IMAP M1 in the worker (IMAP synchronization enabled in the TEST deps only; production keeps
 * imapSyncEnabled = false). In-memory fake IMAP server (UIDs, INTERNALDATE, SEARCH UID / SINCE);
 * the real adapter, syncAccount and processEmail. Real TLS / Dovecot: imap-integration.test.ts.
 *   - D1: an IMAP run whose mailbox stops being processable (paused, disconnected, no access, IMAP
 *     left the plan) stops at once and keeps its cursor; a resume loses and duplicates nothing;
 *   - D2: markError never touches a DISCONNECTED IMAP row (query of the Supabase store);
 *   - decision A: losing IMAP in the plan stops synchronization without an ERROR;
 *   - decision B: 300 messages per run, continued from the last one; 7-day window, reported;
 *   - Gmail / Microsoft: unchanged (same options, no halt).
 */

const NOW = Date.parse("2026-10-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const crlf = (text: string) => Buffer.from(text.replace(/\r?\n/g, "\r\n"));
const message = (n: number) =>
  crlf(`From: Streaming <info@account.streaming.example>
To: me@empresa-correo.com
Subject: =?UTF-8?Q?Tu_c=C3=B3digo_temporal_${n}?=
Message-ID: <m1-${n}@streaming.example>
Date: Tue, 14 Oct 2026 09:00:00 +0000

Tu codigo es 4821
`);

/** INBOX with UIDVALIDITY 7: SEARCH "UID n:*" (with the RFC 3501 '*' quirk) and SINCE (UTC day), FETCH INTERNALDATE, BODY.PEEK[]. */
class FakeImapServer {
  uidValidity = 7n;
  messages = new Map<number, { source: Buffer; internalDate: Date }>();
  nextUid = 1;
  sourceFetches: number[] = [];
  dateFetches = 0;
  add(internalDate = new Date(NOW - 60_000), n = this.nextUid) {
    this.messages.set(this.nextUid, { source: message(n), internalDate });
    this.nextUid += 1;
  }
  client(): ImapClient {
    const server = this;
    let mailbox: Record<string, unknown> | false = false;
    const client = {
      usable: true,
      get mailbox() {
        return mailbox;
      },
      async getMailboxLock(_path: string, options?: { readOnly?: boolean }) {
        if (!options?.readOnly) throw new Error("read-write mailbox");
        mailbox = { path: "INBOX", uidValidity: server.uidValidity, uidNext: server.nextUid, readOnly: true };
        return { path: "INBOX", release: () => undefined };
      },
      async mailboxClose() {
        mailbox = false;
        return true;
      },
      async search(query: { uid?: string; since?: Date }) {
        let uids = [...server.messages.keys()].sort((a, b) => a - b);
        if (query.uid) {
          const start = Number(query.uid.split(":")[0]);
          const found = uids.filter((uid) => uid >= start);
          uids = found.length > 0 ? found : uids.slice(-1);
        }
        if (query.since) {
          const day = query.since.toISOString().slice(0, 10);
          uids = uids.filter((uid) => (server.messages.get(uid)?.internalDate.toISOString().slice(0, 10) ?? "") >= day);
        }
        return uids;
      },
      async *fetch(range: number[]) {
        server.dateFetches += range.length;
        for (const uid of range) {
          const entry = server.messages.get(uid);
          if (entry) yield { uid, internalDate: entry.internalDate };
        }
      },
      async fetchOne(uid: string, query: { source?: boolean }) {
        const entry = server.messages.get(Number(uid));
        if (!entry) return false;
        if (query.source) server.sourceFetches.push(Number(uid));
        return { uid: Number(uid), size: entry.source.length, internalDate: entry.internalDate, ...(query.source ? { source: entry.source } : {}) };
      },
      async download() {
        return { meta: {}, content: null };
      },
      async logout() {
        client.usable = false;
      },
      close() {
        client.usable = false;
      },
      on() {
        return client;
      }
    };
    return client as unknown as ImapClient;
  }
}

function imapAccount(overrides: Partial<WorkerAccount> = {}): WorkerAccount {
  return makeAccount({
    provider: "IMAP",
    emailAddress: "me@empresa-correo.com",
    syncCursor: "imap:v1:7:0",
    lastSyncedAt: new Date(NOW - 60_000).toISOString(),
    providerMetadata: { imap: { host: "imap.hostinger.com", port: 993, security: "TLS", username: "me@empresa-correo.com" } },
    accessTokenEncrypted: "v2.stored",
    ...overrides
  });
}

const contextOf = (account: WorkerAccount): ProviderContext => ({
  account,
  getAccessToken: () => Promise.reject(new Error("not OAuth")),
  getImapCredentials: async () => ({ username: "me@empresa-correo.com", password: "app-password" })
});

/**
 * The real pipeline for one IMAP account: syncAccount -> processEmail (inline) -> adapter -> fake server.
 * `afterMessage(n)` runs after the n-th processed message (to pause / revoke access mid-batch).
 */
function pipeline(server: FakeImapServer, account: WorkerAccount, options: { afterMessage?: (count: number) => void } = {}) {
  const access = new Map<string, CommercialAccess>();
  const notEntitled = new Set<string>();
  const accounts = makeAccountStore([account], access, notEntitled);
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow()];
  const pool = new ImapConnectionPool<ImapClient>();
  const adapter = createImapSyncAdapter({ pool, connect: vi.fn(async () => server.client()) });
  const audit = makeAudit();
  const providers = { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: adapter };
  const processDeps: ProcessEmailDeps = {
    accounts,
    emails,
    routing: new MemoryRoutingStore(emails),
    audit,
    storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
    realtime: makeRealtime(),
    producer: makeProducer(),
    providers,
    createContext: contextOf,
    attachmentsBucket: "email-attachments",
    maxAttachmentBytes: 1000,
    logger: silentLogger,
    storageRetryDelayMs: 0,
    imapSyncEnabled: true
  };
  let handled = 0;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: HandleEventDeps = {
    accounts,
    emails,
    producer: makeProducer(),
    providers,
    createContext: contextOf,
    enqueueSync: vi.fn(async () => undefined),
    processMessage: async (job: EmailProcessingJob) => {
      const outcome = await processEmail(job, processDeps);
      if (outcome.status !== "skipped" || outcome.reason === "duplicate") {
        handled += 1;
        options.afterMessage?.(handled);
      }
      return outcome;
    },
    lock: { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) },
    audit,
    logger,
    now: () => NOW,
    imapSyncEnabled: true
  };
  const storedUids = () => emails.rows.map((row) => String(row.provider_message_id)).sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
  return { accounts, emails, deps, access, notEntitled, pool, audit, logger, storedUids };
}

const uidsUpTo = (n: number) => Array.from({ length: n }, (_, index) => `7:${index + 1}`);

describe("D1: pausing during an IMAP batch", () => {
  it("the run stops at once, the cursor does not move; a resume imports the rest, nothing lost or duplicated", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 9; n += 1) server.add();
    const account = imapAccount();
    const { deps, storedUids, pool } = pipeline(server, account, { afterMessage: (count) => count === 2 && (account.status = "PAUSED") });

    const first = await syncAccount(account, deps, "POLL");
    expect(first.cursorAdvanced).toBe(false);
    expect(account.syncCursor).toBe("imap:v1:7:0");
    const partial = storedUids().length;
    expect(partial).toBeGreaterThanOrEqual(2);
    expect(partial).toBeLessThan(9);

    // While PAUSED nothing runs at all.
    expect(await syncAccount(account, deps, "POLL")).toMatchObject({ found: 0, cursorAdvanced: false });

    account.status = "ACTIVE";
    const second = await syncAccount(account, deps, "POLL");
    expect(second.cursorAdvanced).toBe(true);
    expect(account.syncCursor).toBe("imap:v1:7:9");
    expect(storedUids()).toEqual(uidsUpTo(9));
    await pool.closeAll();
  });

  it("paused right after the last message (before the cursor write): the status-checked compare-and-set refuses it", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 3; n += 1) server.add();
    const account = imapAccount();
    const { deps, accounts, pool } = pipeline(server, account, { afterMessage: (count) => count === 3 && (account.status = "PAUSED") });
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(false);
    expect(account.syncCursor).toBe("imap:v1:7:0");
    expect(accounts.advanceSyncCursor).toHaveBeenCalledWith(account.id, expect.objectContaining({ requireActive: true }));
    await pool.closeAll();
  });

  it("disconnected mid-batch: stops, cursor unchanged, no account error written", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 5; n += 1) server.add();
    const account = imapAccount();
    const { deps, accounts, pool } = pipeline(server, account, {
      afterMessage: (count) => {
        if (count === 1) Object.assign(account, { status: "DISCONNECTED", syncCursor: null, accessTokenEncrypted: null });
      }
    });
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(false);
    expect(accounts.markError).not.toHaveBeenCalled();
    expect(account.status).toBe("DISCONNECTED");
    await pool.closeAll();
  });
});

describe("decision A and access: losing IMAP in the plan or the commercial access", () => {
  it("IMAP no longer in the plan: nothing listed, cursor unchanged, NO ERROR; resumes when the plan allows it again", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 4; n += 1) server.add();
    const account = imapAccount();
    const { deps, notEntitled, accounts, storedUids, pool } = pipeline(server, account);
    notEntitled.add(ORG);
    expect(await syncAccount(account, deps, "POLL")).toMatchObject({ found: 0, cursorAdvanced: false });
    expect(server.sourceFetches).toEqual([]);
    expect(accounts.markError).not.toHaveBeenCalled();
    expect(account).toMatchObject({ status: "ACTIVE", syncCursor: "imap:v1:7:0" });

    notEntitled.delete(ORG);
    expect((await syncAccount(account, deps, "POLL")).cursorAdvanced).toBe(true);
    expect(storedUids()).toEqual(uidsUpTo(4));
    await pool.closeAll();
  });

  it.each([
    ["IMAP leaves the plan", "imap_not_entitled"],
    ["the commercial access ends", "subscription_inactive"]
  ])("%s mid-batch: the run stops (%s), the cursor stays, the rest is imported later", async (_label, reason) => {
    const server = new FakeImapServer();
    for (let n = 0; n < 8; n += 1) server.add();
    const account = imapAccount();
    let revoke = () => undefined as void;
    const context = pipeline(server, account, { afterMessage: (count) => count === 2 && revoke() });
    revoke = () => {
      if (reason === "imap_not_entitled") context.notEntitled.add(ORG);
      else context.access.set(ORG, { allowed: false, access: "NONE", subscriptionStatus: "CANCELED" });
    };
    const first = await syncAccount(account, context.deps, "POLL");
    expect(first.cursorAdvanced).toBe(false);
    expect(account.syncCursor).toBe("imap:v1:7:0");
    expect(context.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "imap.sync.halted", reason }), expect.any(String));
    expect(context.accounts.markError).not.toHaveBeenCalled();

    context.notEntitled.clear();
    context.access.clear();
    expect((await syncAccount(account, context.deps, "POLL")).cursorAdvanced).toBe(true);
    expect(context.storedUids()).toEqual(uidsUpTo(8));
    await context.pool.closeAll();
  });
});

describe("decision B: bounded catch-up (300 per run) and 7-day window", () => {
  it("350 pending: 300 in the first run (cursor at the 300th, continuation queued), the other 50 in the next; nothing skipped", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 350; n += 1) server.add();
    const account = imapAccount();
    const { deps, storedUids, pool } = pipeline(server, account);
    const first = await syncAccount(account, deps, "POLL");
    expect(IMAP_MAX_MESSAGES_PER_SYNC).toBe(300);
    expect(first).toMatchObject({ found: 300, hasMore: true, cursorAdvanced: true });
    expect(account.syncCursor).toBe("imap:v1:7:300");
    expect(deps.enqueueSync).toHaveBeenCalledWith(account, "CONTINUATION");
    const second = await syncAccount(account, deps, "CONTINUATION");
    expect(second).toMatchObject({ found: 50, hasMore: false, cursorAdvanced: true });
    expect(account.syncCursor).toBe("imap:v1:7:350");
    expect(storedUids()).toEqual(uidsUpTo(350));
    await pool.closeAll();
  });

  it("an incomplete (halted) catch-up resumes from the same cursor and still respects the 300 bound", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 320; n += 1) server.add();
    const account = imapAccount();
    const { deps, storedUids, pool } = pipeline(server, account, { afterMessage: (count) => count === 50 && (account.status = "PAUSED") });
    expect((await syncAccount(account, deps, "POLL")).cursorAdvanced).toBe(false);
    expect(account.syncCursor).toBe("imap:v1:7:0");
    account.status = "ACTIVE";
    expect(await syncAccount(account, deps, "POLL")).toMatchObject({ found: 300, hasMore: true, cursorAdvanced: true });
    expect(await syncAccount(account, deps, "CONTINUATION")).toMatchObject({ found: 20, hasMore: false, cursorAdvanced: true });
    expect(storedUids()).toEqual(uidsUpTo(320));
    await pool.closeAll();
  });

  it("messages older than 7 days are never fetched nor imported; they are counted, logged and audited; the boundary is inclusive", async () => {
    const server = new FakeImapServer();
    server.add(new Date(NOW - 10 * DAY)); // 1: old
    server.add(new Date(NOW - RECOVERY_MAX_WINDOW_MS)); // 2: exactly at the window start (kept)
    server.add(new Date(NOW - RECOVERY_MAX_WINDOW_MS - 1000)); // 3: just outside
    server.add(new Date(NOW - 2 * DAY)); // 4
    server.add(new Date(NOW - 30 * DAY)); // 5: old
    server.add(); // 6: now
    const account = imapAccount({ lastSyncedAt: new Date(NOW - 30 * DAY).toISOString() });
    const { deps, storedUids, audit, logger, pool } = pipeline(server, account);
    const result = await syncAccount(account, deps, "POLL");
    expect(result).toMatchObject({ found: 3, cursorAdvanced: true });
    expect(storedUids()).toEqual(["7:2", "7:4", "7:6"]);
    expect([...server.sourceFetches].sort((a, b) => a - b)).toEqual([2, 4, 6]);
    expect(account.syncCursor).toBe("imap:v1:7:6");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "imap.sync.outside_window", count: 3, windowDays: 7 }), expect.any(String));
    expect(JSON.stringify(audit.recordAccountEvent.mock.calls)).toContain('"count":3');
    await pool.closeAll();
  });

  it("out-of-window messages do not use the 300 budget, and INTERNALDATE is only read for in-window candidates", async () => {
    const server = new FakeImapServer();
    for (let n = 0; n < 40; n += 1) server.add(new Date(NOW - 20 * DAY));
    for (let n = 0; n < 5; n += 1) server.add();
    const account = imapAccount();
    const { deps, storedUids, pool } = pipeline(server, account);
    expect(await syncAccount(account, deps, "POLL")).toMatchObject({ found: 5, hasMore: false, cursorAdvanced: true });
    expect(storedUids()).toEqual(["7:41", "7:42", "7:43", "7:44", "7:45"]);
    expect(server.dateFetches).toBe(5);
    expect(account.syncCursor).toBe("imap:v1:7:45");
    await pool.closeAll();
  });

  it("UIDVALIDITY changes keep using the existing bounded recovery (300 / 7 days), unchanged", async () => {
    const server = new FakeImapServer();
    server.add();
    const account = imapAccount({ syncCursor: "imap:v1:6:10" });
    const { deps, pool } = pipeline(server, account);
    const result = await syncAccount(account, deps, "POLL");
    expect(result).toMatchObject({ historyGap: true, cursorAdvanced: true });
    expect(account.syncCursor).toBe("imap:v1:7:1");
    await pool.closeAll();
  });
});

describe("error classification and states (unchanged by M1)", () => {
  it("permanent errors still put an IMAP mailbox in ERROR (not retried); transient ones are retried", async () => {
    for (const [error, expected] of [
      [new ProviderAuthError("refused", "IMAP_AUTH_FAILED"), "NonRetryableError"],
      [new ProviderSecurityError("tls", "IMAP_TLS_FAILED"), "NonRetryableError"],
      [new ProviderTransientError("timeout", null), "ProviderTransientError"]
    ] as const) {
      const accounts = makeAccountStore([imapAccount()]);
      const outcome = await handleAccountFailure(error, { id: "account-1", organizationId: ORG }, { accounts, realtime: makeRealtime(), logger: silentLogger }).catch(
        (caught: Error) => caught
      );
      expect((outcome as Error).name).toBe(expected);
      expect(accounts.markError).toHaveBeenCalledTimes(expected === "NonRetryableError" ? 1 : 0);
    }
  });
});

describe("Gmail / Microsoft: zero behaviour change", () => {
  it("same listing options (200, no window) and skipped messages still advance the cursor as before", async () => {
    for (const provider of ["GMAIL", "MICROSOFT"] as const) {
      const account = makeAccount({ provider, syncCursor: "100" });
      const accounts = makeAccountStore([account]);
      const adapter = makeAdapter({ provider, listNewMessageIds: vi.fn(async () => ({ messageIds: ["a", "b", "c"], nextCursor: "103" })) });
      const deps: HandleEventDeps = {
        accounts,
        emails: new MemoryEmailStore(),
        producer: makeProducer(),
        providers: { GMAIL: adapter, MICROSOFT: adapter, IMAP: makeAdapter({ provider: "IMAP" }) },
        createContext: contextOf,
        enqueueSync: vi.fn(async () => undefined),
        // Every message skipped because the account became inactive: legacy behaviour (counted as skipped, cursor moves).
        processMessage: vi.fn(async () => ({ status: "skipped" as const, reason: "account_inactive" as const })),
        lock: { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) },
        logger: silentLogger,
        imapSyncEnabled: true
      };
      const result = await syncAccount(account, deps, "POLL");
      expect(adapter.listNewMessageIds, provider).toHaveBeenCalledWith(expect.anything(), { maxMessages: 200 });
      expect(result, provider).toMatchObject({ found: 3, skipped: 3, cursorAdvanced: true });
      expect(vi.mocked(accounts.advanceSyncCursor).mock.calls[0]?.[1], provider).not.toHaveProperty("requireActive");
      expect(accounts.imapEntitled, provider).not.toHaveBeenCalled();
    }
  });
});

describe("Supabase store (D1 / D2 queries)", () => {
  /** Records the PostgREST query built by the store; every update "matches" one row. */
  function recordingDb() {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "update", "eq", "is", "or", "select"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: [{ id: "x" }], error: null });
    builder.rpc = async (name: string, args: unknown) => {
      calls.push(["rpc", [name, args]]);
      return {
        data: [
          { key: "GMAIL", kind: "FEATURE", enabled: true, access: "SUBSCRIPTION", effective_plan: "BASIC" },
          { key: "IMAP", kind: "FEATURE", enabled: false, access: "SUBSCRIPTION", effective_plan: "BASIC" }
        ],
        error: null
      };
    };
    return { db: builder as never, calls };
  }

  it("D2: markError never matches a DISCONNECTED IMAP row (other providers always match)", async () => {
    const { db, calls } = recordingDb();
    await createAccountStore(db).markError("acc", { code: "IMAP_AUTH_FAILED", message: "x", status: "ERROR" });
    expect(calls).toContainEqual(["or", ["provider.neq.IMAP,status.neq.DISCONNECTED"]]);
  });

  it("D1: the cursor compare-and-set adds status = ACTIVE only when asked (IMAP)", async () => {
    const imap = recordingDb();
    await createAccountStore(imap.db).advanceSyncCursor("acc", { from: "imap:v1:7:0", to: "imap:v1:7:5", lastSyncedAt: "t", requireActive: true });
    expect(imap.calls).toContainEqual(["eq", ["status", "ACTIVE"]]);
    const gmail = recordingDb();
    await createAccountStore(gmail.db).advanceSyncCursor("acc", { from: "100", to: "103", lastSyncedAt: "t" });
    expect(gmail.calls.some(([method, args]) => method === "eq" && args[0] === "status")).toBe(false);
  });

  it("imapEntitled reads organization_entitlements: BASIC (IMAP disabled) is false", async () => {
    const { db, calls } = recordingDb();
    expect(await createAccountStore(db).imapEntitled(ORG)).toBe(false);
    expect(calls).toContainEqual(["rpc", ["organization_entitlements", { p_organization_id: ORG }]]);
  });
});
