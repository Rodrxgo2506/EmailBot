import type { EmailProcessingJob } from "@emailbot/shared";
import type { Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createImapSyncSlots } from "../infrastructure/imap-slots.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import type { ProcessEmailDeps } from "../pipeline/process-email.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { ImapDeadlineError, resetImapAbortForTests, runningImapOperations } from "../providers/imap/deadline.js";
import { imapMessageScopeStats, withImapMessageScope } from "../providers/imap/message-scope.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import type { ProviderAdapter, ProviderContext } from "../providers/types.js";
import { IMAP_TEST_ORGANIZATION_IDS, makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";
import { localImapOptions, SLOW_LOGIN, startSlowImapServer, type SlowServerOptions } from "./slow-imap-server.js";

/*
 * IMAP A2.1 final audit - regression tests for LATE results of the adapter (message-scope.ts, adapter.ts,
 * deadline.ts), with a real ImapFlow against the local slow server: a read that answers after its deadline, a
 * read still in flight when its job's scope ends, concurrent jobs sharing the pool (same mailbox, different
 * UIDs) or using different accounts with the same UID, and a download cut half-way. Nothing here changes the
 * production code; it pins the guarantees: nothing late is kept, nothing crosses accounts / UIDs, nothing partial
 * is stored.
 */

const DEADLINES = { connectMs: 1_000, listMs: 1_500, fetchMs: 1_000 };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  resetImapAbortForTests();
  for (const step of cleanup.splice(0).reverse()) await step();
});
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeAll(() => void process.on("unhandledRejection", onUnhandled));
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
const released = () => expect(imapMessageScopeStats()).toEqual({ open: 0, bytes: 0 });

async function mailbox(serverOptions: SlowServerOptions, accountId: string, pool = new ImapConnectionPool<ImapClient>()) {
  const server = await startSlowImapServer({ attachments: 3, ...serverOptions });
  cleanup.push(() => server.stop());
  cleanup.push(() => pool.closeAll());
  const imap = createImapSyncAdapter({ pool, connect: (_endpoint, credentials) => openImapClient(localImapOptions(server.port), credentials), deadlines: DEADLINES });
  const account = makeAccount({
    id: accountId,
    provider: "IMAP",
    emailAddress: `${accountId}@empresa-correo.com`,
    syncCursor: "imap:v1:7:3",
    accessTokenEncrypted: "v2.not-used-here",
    providerMetadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: `${accountId}@empresa-correo.com` } }
  });
  const context: ProviderContext = { account, getAccessToken: async () => "", getImapCredentials: async () => SLOW_LOGIN };
  return { server, pool, imap, account, context };
}

describe("A2.1 audit: late results of the IMAP adapter", () => {
  it("a read answered AFTER its deadline is never kept: socket closed, the next download goes to the server", async () => {
    const box = await mailbox({ sourceDelayMs: DEADLINES.fetchMs + 300 }, "imap-late");
    await withImapMessageScope(async () => {
      await expect(box.imap.fetchMessage(box.context, "7:1")).rejects.toBeInstanceOf(ImapDeadlineError);
      await box.server.allClosed(1_000); // the delayed answer can never arrive: the socket is gone
      expect(box.server.pendingDelays()).toBe(0);
      await sleep(500); // past the moment the answer would have come
      expect(imapMessageScopeStats()).toEqual({ open: 1, bytes: 0 }); // nothing remembered
      box.server.options.sourceDelayMs = 0;
      expect(text(await box.imap.downloadAttachment(box.context, "7:1", "part-0"))).toBe("%PDF-1.4 factura 0 del mensaje 1");
      expect(box.server.sourceFetches()).toBe(2); // read again from the server, not from memory
    });
    released();
    expect(runningImapOperations()).toBe(0);
  });

  it("a read still in flight when its job's scope ends never lands in that (closed) scope", async () => {
    const box = await mailbox({ sourceDelayMs: 600 }, "imap-closed");
    let inFlight: Promise<unknown> | undefined;
    await withImapMessageScope(async () => {
      inFlight = box.imap.fetchMessage(box.context, "7:1"); // the job ends without waiting for it
    });
    released(); // the scope is closed and empty...
    await expect(inFlight).resolves.toMatchObject({ providerMessageId: "7:1" }); // ...the read succeeds later...
    released(); // ...and is not kept anywhere
  });

  it("two jobs in parallel on the SAME mailbox and pooled connection, different UIDs: each gets only its own message's bytes", async () => {
    const box = await mailbox({ sourceDelayMs: 150 }, "imap-shared", new ImapConnectionPool<ImapClient>({ maxPerKey: 1 }));
    const job = (uid: number) =>
      withImapMessageScope(async () => {
        await box.imap.fetchMessage(box.context, `7:${uid}`);
        const parts = [];
        for (let n = 0; n < 3; n++) parts.push(text(await box.imap.downloadAttachment(box.context, `7:${uid}`, `part-${n}`)));
        return parts;
      });
    const [one, two] = await Promise.all([job(1), job(2)]);
    expect(one).toEqual([0, 1, 2].map((n) => `%PDF-1.4 factura ${n} del mensaje 1`));
    expect(two).toEqual([0, 1, 2].map((n) => `%PDF-1.4 factura ${n} del mensaje 2`));
    expect(box.server.sourceFetches()).toBe(2); // one read per job
    expect(box.server.connections()).toBe(1); // the same pooled connection served both jobs
    released();
  });

  it("two jobs in parallel, two accounts with the same UIDVALIDITY and UID: never the other account's bytes", async () => {
    const a = await mailbox({ label: "buzon-A", sourceDelayMs: 100 }, "imap-a");
    const b = await mailbox({ label: "buzon-B", sourceDelayMs: 50 }, "imap-b");
    const job = (box: typeof a) =>
      withImapMessageScope(async () => {
        await box.imap.fetchMessage(box.context, "7:1");
        return Promise.all([0, 1, 2].map(async (n) => text(await box.imap.downloadAttachment(box.context, "7:1", `part-${n}`))));
      });
    const [fromA, fromB] = await Promise.all([job(a), job(b)]);
    expect(fromA.every((value) => value.endsWith("buzon-A"))).toBe(true);
    expect(fromB.every((value) => value.endsWith("buzon-B"))).toBe(true);
    expect(a.server.sourceFetches()).toBe(1);
    expect(b.server.sourceFetches()).toBe(1);
    released();
  });

  it("a download cut half-way (bytes already received) is never stored nor remembered; the next attachment is read again", async () => {
    // Production processor + processEmail (completed email with 3 contents missing): the first download drips
    // (partial bytes) until its deadline; then the server recovers.
    const box = await mailbox({ dripSourceFrom: 1 }, "imap-partial");
    const accounts = makeAccountStore([box.account]);
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow()];
    emails.rows.push({ organization_id: box.account.organizationId, email_account_id: box.account.id, provider_message_id: "7:1", processing_status: "FAILED", processing_attempts: 25, processing_started_at: new Date(0).toISOString(), bot_id: null, provider_metadata: {}, extracted_data: {} } as never);
    for (let n = 0; n < 3; n++) {
      emails.attachments.push({ id: `attachment-${n + 1}`, email_id: "email-1", organization_id: box.account.organizationId, provider_attachment_id: `part-${n}`, filename: `factura-${n}.pdf`, content_type: "application/pdf", file_size: 40, content_id: null, is_inline: false } as never);
    }
    const stored = new Map<string, Uint8Array>();
    const scopeBytesAfterCut: number[] = [];
    const download = box.imap.downloadAttachment.bind(box.imap);
    let calls = 0;
    box.imap.downloadAttachment = async (...args) => {
      calls += 1;
      if (calls === 2) {
        scopeBytesAfterCut.push(imapMessageScopeStats().bytes); // after the cut download, before the next one
        box.server.options.dripSourceFrom = 0;
      }
      return download(...args);
    };
    const processDeps: Omit<ProcessEmailDeps, "logger"> = {
      accounts,
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: { exists: vi.fn(async (_b: string, path: string) => stored.has(path)), upload: vi.fn(async (_b: string, path: string, content: Uint8Array) => void stored.set(path, content)) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers: { IMAP: box.imap, GMAIL: makeAdapter({ provider: "GMAIL" }), MICROSOFT: makeAdapter({ provider: "MICROSOFT" }) } as unknown as Record<"IMAP" | "GMAIL" | "MICROSOFT", ProviderAdapter>,
      createContext: () => box.context,
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1_000_000,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };
    const runner = createJobProcessors({
      eventDeps: {} as never,
      processDeps,
      accounts,
      realtime: makeRealtime(),
      logger: { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) } as never,
      reportJobFailure: vi.fn(),
      jobType: () => "process-email",
      imapProcessingSlots: createImapSyncSlots(1),
      imapProcessingBudget: { softMs: 10_000, startMs: 10_000, hardMs: 10_000 }
    });
    const job = { id: "j", queueName: "email-processing", data: { organizationId: box.account.organizationId, emailAccountId: box.account.id, provider: "IMAP", providerMessageId: "7:1" }, attemptsMade: 0, moveToDelayed: vi.fn() } as unknown as Job<EmailProcessingJob>;
    await runner.processing(job, "t");

    expect(box.server.dripBytes()).toBeGreaterThan(0); // the cut download had received partial bytes
    expect(scopeBytesAfterCut).toEqual([0]); // nothing of the cut read was remembered
    expect(box.server.sourceFetches()).toBe(2); // the cut read + one good read for attachments 1 and 2
    const rows = emails.attachments.map((row) => ({ part: row.provider_attachment_id, uploaded: row.storage_uploaded === true }));
    expect(rows).toEqual([
      { part: "part-0", uploaded: false }, // the cut one stays pending, nothing partial stored
      { part: "part-1", uploaded: true },
      { part: "part-2", uploaded: true }
    ]);
    expect(stored.size).toBe(2);
    expect([...stored.values()].map(text).sort()).toEqual(["%PDF-1.4 factura 1 del mensaje 1", "%PDF-1.4 factura 2 del mensaje 1"]);
    await box.pool.closeAll();
    await box.server.allClosed(1_000);
    released();
  });
});
