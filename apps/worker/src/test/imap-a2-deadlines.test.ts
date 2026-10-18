import { afterEach, describe, expect, it } from "vitest";
import { handleAccountFailure } from "../pipeline/failures.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import {
  abortImapOperations,
  IMAP_OPERATION_DEADLINES,
  IMAP_RUN_BUDGET,
  ImapDeadlineError,
  resetImapAbortForTests,
  runningImapOperations,
  withImapRunBudget
} from "../providers/imap/deadline.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { ProviderAuthError, ProviderTransientError, type ProviderContext } from "../providers/types.js";
import { SYNC_LOCK_TTL_MS, syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import type { ProcessEmailOutcome } from "../pipeline/process-email.js";
import type { EmailProcessingJob } from "@emailbot/shared";
import { IMAP_TEST_ORGANIZATION_IDS, makeAccount, makeAccountStore, makeAdapter, makeProducer, makeRealtime, silentLogger } from "./fakes.js";
import { vi } from "vitest";
import { localImapOptions, SLOW_LOGIN, startSlowImapServer, type SlowServer, type SlowServerOptions } from "./slow-imap-server.js";

/*
 * IMAP A2: total deadlines with a REAL ImapFlow client (worker openImapClient, synchronization profile)
 * against a local server that keeps sending bytes every 100 ms (far below ImapFlow's 60 s socket inactivity
 * limit), so only the new total deadlines can stop it. Each test checks that the connection is really closed
 * on the server side (not only that a promise was rejected), that no drip keeps running and that the pool is
 * empty afterwards. Short deadlines here; the production values are checked at the end.
 */

const DEADLINES = { connectMs: 1_200, listMs: 1_500, fetchMs: 1_500 };
const SLACK_MS = 1_000;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetImapAbortForTests();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(options: SlowServerOptions = {}, poolOptions: ConstructorParameters<typeof ImapConnectionPool>[0] = {}) {
  const server = await startSlowImapServer(options);
  cleanup.push(() => server.stop());
  const pool = new ImapConnectionPool<ImapClient>(poolOptions);
  cleanup.push(() => pool.closeAll());
  const adapter = createImapSyncAdapter({
    pool,
    connect: (_endpoint, credentials) => openImapClient(localImapOptions(server.port), credentials),
    deadlines: DEADLINES
  });
  const account = makeAccount({
    id: "imap-a2",
    provider: "IMAP",
    emailAddress: SLOW_LOGIN.username,
    syncCursor: `imap:v1:${options.uidValidity ?? 7}:0`,
    accessTokenEncrypted: "v2.not-used-here",
    providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: SLOW_LOGIN.username } }
  });
  const context: ProviderContext = { account, getAccessToken: () => Promise.reject(new Error("not OAuth")), getImapCredentials: async () => SLOW_LOGIN };
  return { server, pool, adapter, account, context };
}

async function timed<T>(promise: Promise<T>): Promise<{ error: unknown; ms: number }> {
  const started = Date.now();
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  return { error, ms: Date.now() - started };
}

/** The connection really ended: server socket closed, no drip running, pool and guards empty. */
async function expectReleased(server: SlowServer, pool: ImapConnectionPool<ImapClient>) {
  await server.allClosed(SLACK_MS);
  expect(server.openSockets()).toBe(0);
  expect(server.activeDrips()).toBe(0);
  expect(pool.stats()).toMatchObject({ open: 0, busy: 0, opening: 0 });
  expect(runningImapOperations()).toBe(0);
}

function expectDeadline(error: unknown, kind: string, reason = "deadline") {
  expect(error).toBeInstanceOf(ImapDeadlineError);
  expect(error).toBeInstanceOf(ProviderTransientError); // retried with backoff, never an account ERROR
  expect(error).toMatchObject({ code: "IMAP_TIMEOUT", kind, reason });
}

describe("A2: total deadline of each IMAP operation (real ImapFlow, slow server)", () => {
  it("1. slow greeting (bytes every 100 ms, never finished): stopped at the connection deadline, socket closed", async () => {
    const { server, pool, adapter, context } = await setup({ greeting: "drip" });
    const { error, ms } = await timed(adapter.listNewMessageIds(context, { maxMessages: 10 }));
    expectDeadline(error, "connect");
    expect(ms).toBeGreaterThanOrEqual(DEADLINES.connectMs - 50);
    expect(ms).toBeLessThan(DEADLINES.connectMs + SLACK_MS);
    expect(server.dripBytes()).toBeGreaterThan(5); // the server kept talking: no inactivity limit could fire
    await expectReleased(server, pool);
  });

  it("2. slow login: stopped at the connection deadline, socket closed", async () => {
    const { server, pool, adapter, context } = await setup({ login: "drip" });
    const { error, ms } = await timed(adapter.listNewMessageIds(context, { maxMessages: 10 }));
    expectDeadline(error, "connect");
    expect(ms).toBeLessThan(DEADLINES.connectMs + SLACK_MS);
    expect(server.commands).toContain("LOGIN");
    await expectReleased(server, pool);
  });

  it("3. slow UID SEARCH (listing): stopped at the listing deadline, socket closed", async () => {
    const { server, pool, adapter, context } = await setup({ search: "drip" });
    const { error, ms } = await timed(adapter.listNewMessageIds(context, { maxMessages: 10 }));
    expectDeadline(error, "list");
    expect(ms).toBeGreaterThanOrEqual(DEADLINES.listMs - 50);
    expect(ms).toBeLessThan(DEADLINES.listMs + SLACK_MS);
    expect(server.commands.some((command) => /UID SEARCH/i.test(command))).toBe(true);
    await expectReleased(server, pool);
  });

  it("4+5. slow download (message source dripped byte by byte): stopped at the message deadline, socket closed", async () => {
    const { server, pool, adapter, context } = await setup({ dripSourceUids: [2] });
    const { error, ms } = await timed(adapter.fetchMessage(context, "7:2"));
    expectDeadline(error, "fetch");
    expect(ms).toBeLessThan(DEADLINES.fetchMs + SLACK_MS);
    expect(server.dripBytes()).toBeGreaterThan(5);
    await expectReleased(server, pool);
  });

  it("a REUSED pooled connection that turns slow is closed by the deadline too (not only new connections)", async () => {
    const { server, pool, adapter, context } = await setup({ dripSourceUids: [2] });
    await adapter.listNewMessageIds(context, { maxMessages: 10 }); // healthy: the connection stays idle in the pool
    expect(pool.stats()).toMatchObject({ open: 1, busy: 0 });
    const { error, ms } = await timed(adapter.fetchMessage(context, "7:2"));
    expectDeadline(error, "fetch");
    expect(ms).toBeLessThan(DEADLINES.fetchMs + SLACK_MS);
    expect(server.connections()).toBe(1); // the same, reused connection
    await expectReleased(server, pool);
  });

  it("an operation that expires while waiting for a pool slot never opens a connection afterwards", async () => {
    const { server, pool, context } = await setup({ dripSourceUids: [1] }, { maxPerKey: 1, acquireTimeoutMs: 5_000 });
    // The production connector resolves DNS and runs the E1 checks BEFORE ImapFlow exists: count its calls.
    let connectorCalls = 0;
    const adapter = createImapSyncAdapter({
      pool,
      connect: (_endpoint, credentials) => {
        connectorCalls += 1;
        return openImapClient(localImapOptions(server.port), credentials);
      },
      deadlines: { ...DEADLINES, fetchMs: 2_500, listMs: 600 }
    });
    const holder = timed(adapter.fetchMessage(context, "7:1")); // holds the only slot (slow), expires at 2.5 s
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waiter = await timed(adapter.listNewMessageIds(context, { maxMessages: 10 })); // waits for the slot, expires at 0.6 s
    expectDeadline(waiter.error, "list");
    expectDeadline((await holder).error, "fetch");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connectorCalls).toBe(1); // the expired waiter never ran the connector (no DNS, no E1 work) once the slot was free
    expect(server.connections()).toBe(1);
    await expectReleased(server, pool);
  });

  it("slow metadata FETCH of a message: stopped at the message deadline too", async () => {
    const { server, pool, adapter, context } = await setup({ dripMetaUids: [3] });
    const { error } = await timed(adapter.fetchMessage(context, "7:3"));
    expectDeadline(error, "fetch");
    await expectReleased(server, pool);
  });

  it("a normal server is unaffected: listing and messages work, the connection is reused, nothing leaks", async () => {
    const { server, pool, adapter, context } = await setup();
    const changes = await adapter.listNewMessageIds(context, { maxMessages: 10, since: new Date(Date.now() - 86_400_000) });
    expect(changes.messageIds).toEqual(["7:1", "7:2", "7:3"]);
    const email = await adapter.fetchMessage(context, "7:2");
    expect(email.subject).toBe("Codigo 2");
    expect(server.connections()).toBe(1);
    await pool.closeAll();
    await expectReleased(server, pool);
  });

  it("6. LOGOUT that never answers: disposing waits at most logoutTimeoutMs, then the socket is closed anyway", async () => {
    const { server, pool, adapter, context } = await setup({ logout: "hang" }, { logoutTimeoutMs: 300 });
    await adapter.listNewMessageIds(context, { maxMessages: 10 });
    expect(pool.stats().open).toBe(1); // idle in the pool
    const { ms } = await timed(pool.closeAll());
    expect(server.commands).toContain("LOGOUT");
    expect(ms).toBeLessThan(300 + SLACK_MS);
    await expectReleased(server, pool);
  });

  it("the run budget's hard limit cuts an operation in progress (reason run_budget), socket closed", async () => {
    const { server, pool, adapter, context } = await setup({ dripSourceUids: [1] });
    const slowAdapter = createImapSyncAdapter({
      pool,
      connect: (_endpoint, credentials) => openImapClient(localImapOptions(server.port), credentials),
      deadlines: { ...DEADLINES, fetchMs: 30_000 }
    });
    void adapter;
    const { error, ms } = await timed(withImapRunBudget({ softMs: 5_000, hardMs: 700 }, () => slowAdapter.fetchMessage(context, "7:1")));
    expectDeadline(error, "fetch", "run_budget");
    expect(ms).toBeLessThan(700 + SLACK_MS);
    await expectReleased(server, pool);
  });

  it("worker shutdown (abortImapOperations): a running operation is closed at once and new ones are refused", async () => {
    const { server, pool, adapter, context } = await setup({ dripSourceUids: [1] });
    const running = timed(adapter.fetchMessage(context, "7:1"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runningImapOperations()).toBe(1);
    abortImapOperations();
    const { error, ms } = await running;
    expectDeadline(error, "fetch", "shutdown");
    expect(ms).toBeLessThan(300 + SLACK_MS);
    const refused = await timed(adapter.listNewMessageIds(context, { maxMessages: 10 }));
    expectDeadline(refused.error, "list", "shutdown");
    await expectReleased(server, pool);
  });

  it("classification is kept: a refused login is still ProviderAuthError (account ERROR), never a timeout", async () => {
    const { server, pool, adapter, context } = await setup({ login: "refuse" });
    const { error } = await timed(adapter.listNewMessageIds(context, { maxMessages: 10 }));
    expect(error).toBeInstanceOf(ProviderAuthError);
    expect(error).not.toBeInstanceOf(ImapDeadlineError);
    await expectReleased(server, pool);
  });

  it("a timeout reaching the job runner is retried as transient: no markError, no realtime ERROR", async () => {
    const accounts = makeAccountStore([]);
    const realtime = makeRealtime();
    const timeout = new ImapDeadlineError("fetch", "deadline");
    await expect(handleAccountFailure(timeout, { id: "imap-a2", organizationId: "org" }, { accounts, realtime, logger: silentLogger })).rejects.toBe(timeout);
    expect(accounts.markError).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});

describe("A2: a deadline inside a real sync run (real ImapFlow)", () => {
  it("8+13. the message whose download is too slow is not stored; the cursor stops before it; the retry finishes it once", async () => {
    const { server, pool, adapter, account, context } = await setup({ uids: [1, 2, 3], dripSourceUids: [2] });
    const stored = new Map<string, number>();
    const processMessage = vi.fn(async (job: EmailProcessingJob): Promise<ProcessEmailOutcome> => {
      // What processEmail does with IMAP: fetch the whole message, then store it once (by provider message id).
      const email = await adapter.fetchMessage({ ...context, account }, job.providerMessageId);
      if (stored.has(email.providerMessageId)) return { status: "skipped", reason: "duplicate" };
      stored.set(email.providerMessageId, 1);
      return { status: "processed", emailId: email.providerMessageId, matchedRuleIds: [] };
    });
    const deps: HandleEventDeps = {
      accounts: makeAccountStore([account]),
      emails: { listIncompleteEmails: vi.fn(async () => []), updateProcessingState: vi.fn() },
      producer: makeProducer(),
      providers: { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: adapter },
      createContext: () => context,
      enqueueSync: vi.fn(async () => undefined),
      processMessage,
      logger: silentLogger,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };
    const { error } = await timed(syncAccount(account, deps, "POLL"));
    expectDeadline(error, "fetch");
    expect([...stored.keys()].sort()).toEqual(["7:1", "7:3"]);
    expect(account.syncCursor).toBe("imap:v1:7:1"); // 3 is stored but 2 is pending: never jumped
    expect(deps.accounts.markError).not.toHaveBeenCalled();
    await server.allClosed(DEADLINES.fetchMs + SLACK_MS).catch(() => undefined);
    expect(server.activeDrips()).toBe(0);

    // The server is healthy again: the retry resumes from the cursor, 2 is stored, 3 is not duplicated.
    server.options.dripSourceUids.delete(2);
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(true);
    expect(account.syncCursor).toBe("imap:v1:7:3");
    expect([...stored.entries()].sort()).toEqual([["7:1", 1], ["7:2", 1], ["7:3", 1]]);
    await pool.closeAll();
    await expectReleased(server, pool);
  });
});

describe("A2: production limits", () => {
  it("deadlines are coherent with ImapFlow's limits, A1 and the 15-minute sync lock", () => {
    // A new connection: DNS 5 s + TCP 15 s + greeting 10 s + STARTTLS + LOGIN fit in it.
    expect(IMAP_OPERATION_DEADLINES.connectMs).toBeGreaterThanOrEqual(5_000 + 15_000 + 10_000);
    // A whole operation includes a possible new connection.
    expect(IMAP_OPERATION_DEADLINES.listMs).toBeGreaterThan(IMAP_OPERATION_DEADLINES.connectMs);
    expect(IMAP_OPERATION_DEADLINES.fetchMs).toBeGreaterThan(IMAP_OPERATION_DEADLINES.listMs);
    // Every operation, and the hard budget plus the slowest operation started just before it, end before the lock.
    expect(IMAP_RUN_BUDGET.softMs).toBeLessThan(IMAP_RUN_BUDGET.hardMs);
    expect(IMAP_RUN_BUDGET.softMs + IMAP_OPERATION_DEADLINES.fetchMs).toBeLessThanOrEqual(IMAP_RUN_BUDGET.hardMs);
    expect(IMAP_RUN_BUDGET.hardMs).toBeLessThanOrEqual(SYNC_LOCK_TTL_MS - 4 * 60_000);
    expect(IMAP_OPERATION_DEADLINES.logoutMs).toBeLessThanOrEqual(5_000);
  });
});
