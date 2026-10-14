import { randomBytes } from "node:crypto";
import type { EmailProcessingJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import { handleAccountFailure, NonRetryableError } from "../pipeline/failures.js";
import { handleEmailEvent, syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapAdapter, createImapSyncAdapter, imapSearchSince } from "../providers/imap/adapter.js";
import type { ImapClient } from "../providers/imap/connection.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { createProviderRegistry } from "../providers/registry.js";
import { ProviderNotImplementedError, ProviderSecurityError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, ORG, silentLogger } from "./fakes.js";

/*
 * IMAP E2 with the worker pipeline, using an IN-MEMORY fake IMAP server (mock).
 * Real server behaviour (TLS, STARTTLS, \Seen, UIDVALIDITY...) is covered by
 * imap-integration.test.ts against Dovecot.
 */

const crlf = (text: string) => Buffer.from(text.replace(/\r?\n/g, "\r\n"));
const message = (n: number, extra = "") =>
  crlf(`From: Streaming <info@account.streaming.example>
To: me@empresa-correo.com
Subject: =?UTF-8?Q?Tu_c=C3=B3digo_temporal_${n}?=
Message-ID: <msg-${n}@streaming.example>
Date: Tue, 14 Oct 2026 09:00:00 +0000

Tu codigo es 4821 ${extra}
`);

/** Minimal INBOX: UIDVALIDITY, UIDs, SEARCH semantics ("N:*" returns the last message when N is past it). */
class FakeImapServer {
  uidValidity = 7n;
  /** internalDate = the instant; offsetMinutes = the timezone the INTERNALDATE is expressed in (RFC 3501). */
  messages = new Map<number, { source: Buffer; internalDate: Date; offsetMinutes: number; flags: Set<string> }>();
  nextUid = 1;
  connections = 0;
  writes: string[] = [];
  /** SEARCH SINCE dates received, as ImapFlow would send them ("DD-Mon-YYYY" of the UTC date). */
  sinceDates: string[] = [];
  add(source: Buffer, date = new Date("2026-10-14T09:00:00Z"), offsetMinutes = 0) {
    this.messages.set(this.nextUid, { source, internalDate: date, offsetMinutes, flags: new Set() });
    this.nextUid += 1;
  }
  client(): ImapClient {
    this.connections += 1;
    const server = this;
    let mailbox: Record<string, unknown> | false = false;
    const client = {
      usable: true,
      get mailbox() {
        return mailbox;
      },
      async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
        if (path !== "INBOX") throw new Error("only INBOX");
        if (!options?.readOnly) server.writes.push("SELECT (read-write)");
        // Like ImapFlow: an INBOX that is already selected is NOT examined again (its UIDNEXT stays as it was).
        if (!mailbox) mailbox = { path, uidValidity: server.uidValidity, uidNext: server.nextUid, readOnly: options?.readOnly === true };
        return { path, release: () => undefined };
      },
      async mailboxClose() {
        if (mailbox && (mailbox as { readOnly?: boolean }).readOnly !== true) server.writes.push("CLOSE (read-write: would expunge)");
        mailbox = false;
        return true;
      },
      async search(query: { uid?: string; since?: Date }) {
        const uids = [...server.messages.keys()].sort((a, b) => a - b);
        if (query.uid) {
          const start = Number(query.uid.split(":")[0]);
          const found = uids.filter((uid) => uid >= start);
          return found.length > 0 ? found : uids.slice(-1);
        }
        if (query.since) {
          // ImapFlow sends the UTC calendar date; RFC 3501 SINCE compares only the DATE of each
          // INTERNALDATE in its own timezone ("disregarding time and timezone").
          const sinceDay = query.since.toISOString().slice(0, 10);
          server.sinceDates.push(sinceDay);
          return uids.filter((uid) => {
            const entry = server.messages.get(uid);
            if (!entry) return false;
            const localDay = new Date(entry.internalDate.getTime() + entry.offsetMinutes * 60_000).toISOString().slice(0, 10);
            return localDay >= sinceDay;
          });
        }
        return uids;
      },
      async *fetch(range: number[]) {
        for (const uid of range) {
          const entry = server.messages.get(uid);
          if (entry) yield { uid, internalDate: entry.internalDate };
        }
      },
      async fetchOne(uid: string, query: { source?: boolean }) {
        const entry = server.messages.get(Number(uid));
        if (!entry) return false;
        return { uid: Number(uid), size: entry.source.length, internalDate: entry.internalDate, envelope: { subject: "env" }, ...(query.source ? { source: entry.source } : {}) };
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
    providerMetadata: { imap: { host: "imap.hostinger.com", port: 993, security: "TLS", username: "me@empresa-correo.com" } },
    accessTokenEncrypted: "v2.stored",
    ...overrides
  });
}

const context = (account: WorkerAccount): ProviderContext => ({
  account,
  getAccessToken: () => Promise.reject(new Error("not OAuth")),
  getImapCredentials: async () => ({ username: "me@empresa-correo.com", password: "app-password" })
});

function adapterFor(server: FakeImapServer, options: { maxMessageBytes?: number } = {}) {
  const pool = new ImapConnectionPool<ImapClient>();
  const connect = vi.fn(async () => server.client());
  return { pool, connect, adapter: createImapSyncAdapter({ pool, connect, ...options }) };
}

describe("IMAP adapter (fake server)", () => {
  it("no cursor: records the newest UID and imports nothing", async () => {
    const server = new FakeImapServer();
    for (let n = 1; n <= 3; n++) server.add(message(n));
    const { adapter, pool } = adapterFor(server);
    const changes = await adapter.listNewMessageIds(context(imapAccount({ syncCursor: null })), { maxMessages: 200 });
    expect(changes).toEqual({ messageIds: [], nextCursor: "imap:v1:7:3" });
    const empty = new FakeImapServer();
    expect(await adapterFor(empty).adapter.listNewMessageIds(context(imapAccount({ syncCursor: null })))).toEqual({ messageIds: [], nextCursor: "imap:v1:7:0" });
    await pool.closeAll();
  });

  it("an unreadable (legacy) cursor is treated like no cursor", async () => {
    const server = new FakeImapServer();
    server.add(message(1));
    expect(await adapterFor(server).adapter.listNewMessageIds(context(imapAccount({ syncCursor: "1:2" })))).toEqual({ messageIds: [], nextCursor: "imap:v1:7:1" });
  });

  it("new messages after the cursor, oldest first, at most 200 per run with hasMore", async () => {
    const server = new FakeImapServer();
    for (let n = 1; n <= 250; n++) server.add(message(n));
    const { adapter } = adapterFor(server);
    const first = await adapter.listNewMessageIds(context(imapAccount({ syncCursor: "imap:v1:7:20" })), { maxMessages: 200 });
    expect(first.messageIds).toHaveLength(200);
    expect(first.messageIds[0]).toBe("7:21");
    expect(first.messageIds.at(-1)).toBe("7:220");
    expect(first).toMatchObject({ nextCursor: "imap:v1:7:220", hasMore: true });
    const second = await adapter.listNewMessageIds(context(imapAccount({ syncCursor: "imap:v1:7:220" })), { maxMessages: 200 });
    expect(second.messageIds).toHaveLength(30);
    expect(second).toMatchObject({ nextCursor: "imap:v1:7:250", hasMore: false });
  });

  it("nothing new: the cursor stays; the '*' quirk never returns an old message", async () => {
    const server = new FakeImapServer();
    for (let n = 1; n <= 5; n++) server.add(message(n));
    const { adapter } = adapterFor(server);
    expect(await adapter.listNewMessageIds(context(imapAccount({ syncCursor: "imap:v1:7:5" })))).toEqual({ messageIds: [], nextCursor: "imap:v1:7:5" });
  });

  it("another UIDVALIDITY: historyGap, then recovery lists only the recent messages under the new UIDVALIDITY", async () => {
    const server = new FakeImapServer();
    server.add(message(1), new Date("2026-10-01T00:00:00Z"));
    server.add(message(2), new Date("2026-10-14T08:00:00Z"));
    server.uidValidity = 99n;
    const { adapter } = adapterFor(server);
    const account = imapAccount({ syncCursor: "imap:v1:7:1" });
    expect(await adapter.listNewMessageIds(context(account))).toEqual({ messageIds: [], nextCursor: null, historyGap: true });
    const recovery = await adapter.recoverMessageIds?.(context(account), { since: new Date("2026-10-14T00:00:00Z"), maxMessages: 300 });
    expect(recovery).toEqual({ messageIds: ["99:2"], nextCursor: "imap:v1:99:2", truncated: false });
  });

  it("INBOX is always opened read-only (EXAMINE) and nothing is written", async () => {
    const server = new FakeImapServer();
    server.add(message(1));
    const { adapter } = adapterFor(server);
    await adapter.listNewMessageIds(context(imapAccount()));
    await adapter.fetchMessage(context(imapAccount()), "7:1");
    expect(server.writes).toEqual([]);
  });

  it("fetchMessage: normalized IMAP email; a stale UIDVALIDITY or a vanished message is a 404 (skipped)", async () => {
    const server = new FakeImapServer();
    server.add(message(1));
    const { adapter } = adapterFor(server);
    const email = await adapter.fetchMessage(context(imapAccount()), "7:1");
    expect(email).toMatchObject({ provider: "IMAP", providerMessageId: "7:1", subject: "Tu código temporal 1", internetMessageId: "<msg-1@streaming.example>" });
    await expect(adapter.fetchMessage(context(imapAccount()), "6:1")).rejects.toMatchObject({ status: 404 });
    await expect(adapter.fetchMessage(context(imapAccount()), "7:9")).rejects.toMatchObject({ status: 404 });
    await expect(adapter.fetchMessage(context(imapAccount()), "garbage")).rejects.toMatchObject({ status: 404 });
  });

  it("a message above the size limit keeps headers only (no full download), attachments not downloadable", async () => {
    const server = new FakeImapServer();
    server.add(message(1, "x".repeat(2_000)));
    const { adapter } = adapterFor(server, { maxMessageBytes: 1_000 });
    const email = await adapter.fetchMessage(context(imapAccount()), "7:1");
    expect(email.providerMessageId).toBe("7:1");
    expect(email.textBody).toBeNull();
    await expect(adapter.downloadAttachment(context(imapAccount()), "7:1", "part-0")).rejects.toMatchObject({ status: 404 });
  });

  it("invalid stored settings never open a connection", async () => {
    const server = new FakeImapServer();
    const { adapter, connect } = adapterFor(server);
    const legacy = imapAccount({ providerMetadata: { imap: { host: "imap.hostinger.com", port: 993, secure: true, username: "u" } } });
    await expect(adapter.listNewMessageIds(context(legacy))).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("a pooled connection sees messages that arrived after its previous operation (INBOX examined again)", async () => {
    const server = new FakeImapServer();
    server.add(message(1));
    const { adapter, connect, pool } = adapterFor(server);
    const account = imapAccount({ syncCursor: "imap:v1:7:1" });
    expect((await adapter.listNewMessageIds(context(account))).messageIds).toEqual([]);
    server.add(message(2));
    server.add(message(3));
    expect((await adapter.listNewMessageIds(context(account))).messageIds).toEqual(["7:2", "7:3"]);
    expect(connect).toHaveBeenCalledTimes(1); // same connection, refreshed
    expect(server.writes).toEqual([]);
    await pool.closeAll();
  });

  it("connections are pooled per mailbox and closed at shutdown", async () => {
    const server = new FakeImapServer();
    server.add(message(1));
    const { adapter, pool, connect } = adapterFor(server);
    await adapter.listNewMessageIds(context(imapAccount()));
    await adapter.fetchMessage(context(imapAccount()), "7:1");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(pool.stats().open).toBe(1);
    await pool.closeAll();
    expect(pool.stats().open).toBe(0);
  });
});

/* ---------------------------------------------------------------- *
 * Feature flag: IMAP is OFF in the worker
 * ---------------------------------------------------------------- */

function eventDeps(account: WorkerAccount, adapterOverrides = {}, extra: Partial<HandleEventDeps> = {}) {
  const imap = makeAdapter({ provider: "IMAP", ...adapterOverrides });
  const store = makeAccountStore([account]);
  const lock = { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) };
  const deps: HandleEventDeps = {
    accounts: store,
    emails: new MemoryEmailStore(),
    producer: makeProducer(),
    providers: { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: imap },
    createContext: (acc) => context(acc),
    enqueueSync: vi.fn(async () => undefined),
    processMessage: vi.fn(async () => ({ status: "processed" as const, emailId: "e", matchedRuleIds: [] })),
    lock,
    logger: silentLogger,
    ...extra
  };
  return { deps, imap, store, lock };
}

describe("IMAP synchronization disabled (fixed in the worker config)", () => {
  it("the worker config always says false, whatever the environment says", () => {
    const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };
    for (const name of ["IMAP_ACCOUNTS_ENABLED", "IMAP_SYNC_ENABLED", "WORKER_IMAP_SYNC_ENABLED", "WORKER_IMAP_ENABLED"]) {
      expect(loadWorkerConfig({ ...base, [name]: "true" }).imapSyncEnabled, name).toBe(false);
    }
  });

  it("the default registry holds the scaffold: no IMAP connection can be made", async () => {
    const registry = createProviderRegistry(vi.fn() as unknown as typeof fetch);
    await expect(registry.IMAP.listNewMessageIds(context(imapAccount()))).rejects.toBeInstanceOf(ProviderNotImplementedError);
    await expect(createImapAdapter().fetchMessage(context(imapAccount()), "7:1")).rejects.toBeInstanceOf(ProviderNotImplementedError);
  });

  it("syncAccount skips an ACTIVE IMAP account: no lock, no adapter call, cursor unchanged", async () => {
    const account = imapAccount();
    const { deps, imap, lock, store } = eventDeps(account);
    const result = await syncAccount(account, deps, "MANUAL");
    expect(result).toMatchObject({ found: 0, processed: 0, cursorAdvanced: false });
    expect(imap.listNewMessageIds).not.toHaveBeenCalled();
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(store.advanceSyncCursor).not.toHaveBeenCalled();
    expect(account.syncCursor).toBe("imap:v1:7:0");
  });

  it("a queued SYNC_ACCOUNT job for an IMAP account does nothing either", async () => {
    const account = imapAccount();
    const { deps, imap } = eventDeps(account);
    await handleEmailEvent({ type: "SYNC_ACCOUNT", emailAccountId: account.id, organizationId: ORG, requestedBy: null }, deps);
    expect(imap.listNewMessageIds).not.toHaveBeenCalled();
  });

  it("polling never lists IMAP accounts while disabled (even if the store could)", async () => {
    const account = imapAccount();
    const { deps } = eventDeps(account);
    const listActiveImapAccounts = vi.fn(async () => [{ id: account.id, organizationId: ORG }]);
    deps.accounts = { ...deps.accounts, listActiveImapAccounts };
    const outcome = await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(listActiveImapAccounts).not.toHaveBeenCalled();
    expect(deps.enqueueSync).not.toHaveBeenCalled();
    expect(outcome.accounts).toBe(0);
  });

  it("processEmail skips IMAP mail (recovery / leftover jobs): nothing fetched, stored or delivered", async () => {
    const account = imapAccount();
    const fetchMessage = vi.fn();
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow()];
    const deps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]),
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers: { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: makeAdapter({ provider: "IMAP", fetchMessage }) },
      createContext: (acc) => context(acc),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      logger: silentLogger
    };
    const job: EmailProcessingJob = { organizationId: ORG, emailAccountId: account.id, provider: "IMAP", providerMessageId: "7:1" };
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "imap_disabled" });
    expect(fetchMessage).not.toHaveBeenCalled();
    expect(emails.rows).toHaveLength(0);
  });

  it("PAUSED / DISCONNECTED / ERROR IMAP accounts are never synchronized, even when enabled", async () => {
    for (const status of ["PAUSED", "DISCONNECTED", "ERROR"] as const) {
      const account = imapAccount({ status });
      const { deps, imap } = eventDeps(account, {}, { imapSyncEnabled: true });
      await syncAccount(account, deps, "POLL");
      expect(imap.listNewMessageIds, status).not.toHaveBeenCalled();
    }
  });

  it("Gmail and Microsoft are not affected by the IMAP flag", async () => {
    for (const provider of ["GMAIL", "MICROSOFT"] as const) {
      const account = makeAccount({ provider });
      const { deps } = eventDeps(account);
      const adapter = makeAdapter({ provider, listNewMessageIds: vi.fn(async () => ({ messageIds: ["m1"], nextCursor: "101" })) });
      deps.providers = { GMAIL: adapter, MICROSOFT: adapter, IMAP: makeAdapter({ provider: "IMAP" }) };
      const result = await syncAccount(account, deps, "POLL");
      expect(result, provider).toMatchObject({ found: 1, cursorAdvanced: true });
    }
  });
});

/* ---------------------------------------------------------------- *
 * Enabled (test configuration only): the real adapter in the pipeline
 * ---------------------------------------------------------------- */

describe("enabled in a test configuration: real adapter + existing pipeline", () => {
  function pipeline(server: FakeImapServer, account: WorkerAccount) {
    const emails = new MemoryEmailStore();
    // Mirrors the database lookup by (email_account_id, internet_message_id).
    const withMessageIdLookup = Object.assign(emails, {
      findEmailIdByInternetMessageId: vi.fn(async (accountId: string, internetMessageId: string, receivedAt: string) => {
        const index = emails.rows.findIndex(
          (row) => row.email_account_id === accountId && row.internet_message_id === internetMessageId && row.received_at === receivedAt
        );
        return index >= 0 ? `email-${index + 1}` : null;
      })
    });
    emails.rules = [makeRuleRow({ id: "netflix", bot_id: "bot-netflix", bot: { status: "ACTIVE" } })];
    const routing = new MemoryRoutingStore(emails);
    routing.addBot("bot-netflix", { source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED" });
    routing.addCustomer("juan", { normalizedValue: "me@empresa-correo.com" }, { bots: ["bot-netflix"] });
    const { adapter, pool } = adapterFor(server);
    const accounts = makeAccountStore([account]);
    const providers = { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: adapter };
    const processDeps: ProcessEmailDeps = {
      accounts,
      emails: withMessageIdLookup,
      routing,
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers,
      createContext: (acc) => context(acc),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      logger: silentLogger,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true
    };
    const deps: HandleEventDeps = {
      accounts,
      emails,
      producer: makeProducer(),
      providers,
      createContext: (acc) => context(acc),
      enqueueSync: vi.fn(async () => undefined),
      processMessage: (job) => processEmail(job, processDeps),
      lock: { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) },
      logger: silentLogger,
      imapSyncEnabled: true
    };
    return { emails, routing, deps, pool };
  }

  it("rules, bot, customer and portal delivery through the IMAP sync path; a rerun duplicates nothing", async () => {
    const server = new FakeImapServer();
    const account = imapAccount({ syncCursor: "imap:v1:7:0" });
    server.add(message(1));
    server.add(message(2));
    const { emails, routing, deps, pool } = pipeline(server, account);

    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(2);
    expect(emails.rows[0]).toMatchObject({ provider_message_id: "7:1", bot_id: "bot-netflix", processing_status: "PROCESSED" });
    expect(routing.deliveries).toHaveLength(2);
    expect(account.syncCursor).toBe("imap:v1:7:2");

    // Retry / restart from the old cursor: everything is deduplicated.
    account.syncCursor = "imap:v1:7:0";
    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(2);
    expect(routing.deliveries).toHaveLength(2);
    await pool.closeAll();
  });

  it("after a UIDVALIDITY change the same messages (same Message-ID) are not stored again", async () => {
    const server = new FakeImapServer();
    const account = imapAccount({ syncCursor: "imap:v1:7:0", lastSyncedAt: "2026-10-14T08:30:00.000Z" });
    server.add(message(1));
    const { emails, routing, deps, pool } = pipeline(server, account);
    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(1);

    server.uidValidity = 99n; // mailbox renumbered: message 1 is now 99:1
    const result = await syncAccount(account, deps, "POLL");
    expect(result.historyGap).toBe(true);
    expect(emails.rows).toHaveLength(1);
    expect(routing.deliveries).toHaveLength(1);
    expect(account.syncCursor).toBe("imap:v1:99:1");
    await pool.closeAll();
  });

  it("M1: a UIDVALIDITY change right after a midnight-UTC sync recovers a UTC-5 message (INTERNALDATE on the previous day)", async () => {
    const server = new FakeImapServer();
    const account = imapAccount({ syncCursor: "imap:v1:7:1", lastSyncedAt: "2026-10-14T01:30:00.000Z" });
    server.add(message(1), new Date("2026-10-14T01:00:00Z")); // processed before (stored below by the first sync)
    const { emails, deps, pool } = pipeline(server, account);
    deps.now = () => Date.parse("2026-10-14T06:00:00Z");
    account.syncCursor = "imap:v1:7:0";
    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(1);

    server.uidValidity = 99n; // renumbered: message 1 is now 99:1
    account.lastSyncedAt = "2026-10-14T01:30:00.000Z"; // recovery starts at 00:30Z
    server.add(message(2), new Date("2026-10-14T03:00:00Z"), -300); // 22:00 on Oct 13 at UTC-5
    const result = await syncAccount(account, deps, "POLL");
    expect(result.historyGap).toBe(true);
    expect(server.sinceDates.at(-1)).toBe("2026-10-12"); // 2 days before 2026-10-14T00:30Z
    expect(emails.rows.map((row) => row.provider_message_id)).toEqual(["7:1", "99:2"]); // the UTC-5 message is NOT lost
    expect(account.syncCursor).toBe("imap:v1:99:2");
    await pool.closeAll();
  });

  it("M2: two different IMAP messages sharing a Message-ID are both stored (no Message-ID dedup outside recovery)", async () => {
    const server = new FakeImapServer();
    const account = imapAccount({ syncCursor: "imap:v1:7:0" });
    server.add(message(1), new Date("2026-10-14T09:00:00Z"));
    server.add(message(1), new Date("2026-10-14T09:05:00Z")); // same Message-ID reused by the sender, another code
    const { emails, routing, deps, pool } = pipeline(server, account);
    await syncAccount(account, deps, "POLL");
    expect(emails.rows.map((row) => [row.provider_message_id, row.received_at])).toEqual([
      ["7:1", "2026-10-14T09:00:00.000Z"],
      ["7:2", "2026-10-14T09:05:00.000Z"]
    ]);
    expect(routing.deliveries).toHaveLength(2);
    expect((emails as unknown as { findEmailIdByInternetMessageId: ReturnType<typeof vi.fn> }).findEmailIdByInternetMessageId).not.toHaveBeenCalled();
    await pool.closeAll();
  });

  it("M2: during recovery a message already processed (same Message-ID and INTERNALDATE) is skipped; same Message-ID with another INTERNALDATE is kept", async () => {
    const server = new FakeImapServer();
    const account = imapAccount({ syncCursor: "imap:v1:7:0", lastSyncedAt: "2026-10-14T08:30:00.000Z" });
    server.add(message(1), new Date("2026-10-14T09:00:00Z"));
    const { emails, deps, pool } = pipeline(server, account);
    deps.now = () => Date.parse("2026-10-14T12:00:00Z");
    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(1);

    server.uidValidity = 99n;
    account.lastSyncedAt = "2026-10-14T09:30:00.000Z";
    server.add(message(1), new Date("2026-10-14T10:00:00Z")); // reused Message-ID, a NEW message
    await syncAccount(account, deps, "POLL");
    expect(emails.rows.map((row) => [row.provider_message_id, row.received_at])).toEqual([
      ["7:1", "2026-10-14T09:00:00.000Z"],
      ["99:2", "2026-10-14T10:00:00.000Z"]
    ]);
    const lookup = (emails as unknown as { findEmailIdByInternetMessageId: ReturnType<typeof vi.fn> }).findEmailIdByInternetMessageId;
    expect(lookup).toHaveBeenCalledWith(account.id, "<msg-1@streaming.example>", "2026-10-14T09:00:00.000Z");
    await pool.closeAll();
  });

  it("polling includes active IMAP accounts only when enabled", async () => {
    const account = imapAccount();
    const { deps } = eventDeps(account, {}, { imapSyncEnabled: true });
    deps.accounts = { ...deps.accounts, listActiveImapAccounts: vi.fn(async () => [{ id: account.id, organizationId: ORG }]) };
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(deps.enqueueSync).toHaveBeenCalledWith({ id: account.id, organizationId: ORG }, "POLL");
  });
});

describe("M1: recovery after a UIDVALIDITY change (adapter, fake server with RFC 3501 SINCE semantics)", () => {
  const since = new Date("2026-10-14T00:30:00Z");

  it("the search starts 2 days earlier (inclusive date, UTC as ImapFlow sends it)", () => {
    expect(imapSearchSince(since).toISOString()).toBe("2026-10-12T00:30:00.000Z");
    expect(imapSearchSince(new Date("2026-03-01T23:59:59Z")).toISOString().slice(0, 10)).toBe("2026-02-27");
  });

  it("keeps messages received at or after `since` whatever their timezone; nothing received before is imported", async () => {
    const server = new FakeImapServer();
    server.uidValidity = 99n;
    server.add(message(1), new Date("2026-10-14T03:00:00Z"), -300); // after since, calendar date Oct 13 at UTC-5 -> kept
    server.add(message(2), new Date("2026-10-13T23:00:00Z")); // before since (history) -> not imported
    server.add(message(3), new Date("2026-10-14T00:30:00Z")); // exactly since (inclusive) -> kept
    server.add(message(4), new Date("2026-10-14T00:29:59Z")); // one second before -> not imported
    server.add(message(5), new Date("2026-10-12T10:00:00Z"), 840); // Oct 13 at UTC+14, but long before since -> not imported
    server.add(message(6), new Date("2026-10-14T23:30:00Z"), 600); // Oct 15 at UTC+10 -> kept
    const { adapter, pool } = adapterFor(server);
    const recovery = await adapter.recoverMessageIds?.(context(imapAccount({ syncCursor: "imap:v1:7:1" })), { since, maxMessages: 300 });
    expect(server.sinceDates).toEqual(["2026-10-12"]);
    expect(recovery).toEqual({ messageIds: ["99:1", "99:3", "99:6"], nextCursor: "imap:v1:99:6", truncated: false });
    await pool.closeAll();
  });

  it("is bounded to the 300 most recent messages (truncated is reported; older ones are NOT recovered)", async () => {
    const server = new FakeImapServer();
    server.uidValidity = 99n;
    for (let n = 1; n <= 350; n++) server.add(message(n), new Date(Date.parse("2026-10-14T01:00:00Z") + n * 1000));
    const { adapter, pool } = adapterFor(server);
    const recovery = await adapter.recoverMessageIds?.(context(imapAccount()), { since, maxMessages: 300 });
    expect(recovery?.messageIds).toHaveLength(300);
    expect(recovery?.messageIds[0]).toBe("99:51");
    expect(recovery?.truncated).toBe(true);
    await pool.closeAll();
  });

  it("a Gmail history gap is untouched: its jobs never carry the IMAP recovery flag", async () => {
    const account = makeAccount({ provider: "GMAIL", syncCursor: "100", lastSyncedAt: "2026-10-14T08:00:00.000Z" });
    const jobs: EmailProcessingJob[] = [];
    const gmail = makeAdapter({
      listNewMessageIds: vi.fn(async () => ({ messageIds: [], nextCursor: null, historyGap: true })),
      recoverMessageIds: vi.fn(async () => ({ messageIds: ["g1"], nextCursor: "200", truncated: false }))
    });
    const deps: HandleEventDeps = {
      accounts: makeAccountStore([account]),
      emails: new MemoryEmailStore(),
      producer: makeProducer(),
      providers: { GMAIL: gmail, MICROSOFT: gmail, IMAP: makeAdapter({ provider: "IMAP" }) },
      createContext: (acc) => context(acc),
      enqueueSync: vi.fn(async () => undefined),
      processMessage: async (job) => {
        jobs.push(job);
        return { status: "processed", emailId: "e", matchedRuleIds: [] };
      },
      logger: silentLogger,
      now: () => Date.parse("2026-10-14T12:00:00Z"),
      imapSyncEnabled: true
    };
    await syncAccount(account, deps, "POLL");
    expect(jobs).toEqual([{ organizationId: ORG, emailAccountId: account.id, provider: "GMAIL", providerMessageId: "g1" }]);
  });
});

describe("account failures", () => {
  it("a security failure marks the account ERROR with its code and is not retried", async () => {
    const accounts = makeAccountStore([]);
    const realtime = makeRealtime();
    await expect(
      handleAccountFailure(new ProviderSecurityError("The IMAP server's certificate or TLS connection could not be verified", "IMAP_TLS_FAILED"), { id: "a1", organizationId: ORG }, { accounts, realtime, logger: silentLogger })
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(accounts.markError).toHaveBeenCalledWith("a1", { code: "IMAP_TLS_FAILED", message: "The IMAP server's certificate or TLS connection could not be verified", status: "ERROR" });
    expect(realtime.events).toEqual([expect.objectContaining({ type: "email-account.status", status: "ERROR" })]);
  });
});
