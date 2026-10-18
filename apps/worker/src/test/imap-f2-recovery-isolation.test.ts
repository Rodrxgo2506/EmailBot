import type { EmailProcessingJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { createEmailStore } from "../infrastructure/supabase-stores.js";
import { handleEmailEvent, IMAP_RECOVERY_BATCH, MAX_PROCESSING_ATTEMPTS, RECOVERY_BATCH, RECOVERY_STALE_MS } from "../pipeline/handle-email-event.js";
import type { CommercialAccess } from "../pipeline/ports.js";
import { IMAP_TEST_ORGANIZATION_IDS, makeAccountStore, makeAdapter, makeProducer, MemoryEmailStore, ORG, silentLogger } from "./fakes.js";

/*
 * F2: the recovery of incomplete emails (RECOVER_INCOMPLETE, every 10 minutes) used ONE global batch of the 100
 * oldest incomplete emails of every provider. processing_started_at never changes on resume, so stuck IMAP emails
 * stayed at the head of that batch run after run and could fill it: incomplete Gmail / Microsoft emails behind them
 * were never even queued. Now every provider but IMAP keeps the whole batch (same query, same order, same limit)
 * and IMAP mailboxes get a batch of their own (IMAP_RECOVERY_BATCH), only while IMAP synchronization is enabled.
 * The store query itself is checked below (PostgREST filters) and against a real local stack in the F2 report.
 */

const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const old = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(); // stuck long ago, in order
const recent = new Date(Date.UTC(2026, 1, 1)).toISOString(); // stale too, but younger than every IMAP one

interface Seed {
  imap?: number;
  gmail?: number;
  microsoft?: number;
}

/** Incomplete emails: IMAP ones the OLDEST (they would come first in a global batch), then Gmail, then Microsoft. */
function seed({ imap = 150, gmail = 1, microsoft = 1 }: Seed = {}) {
  const emails = new MemoryEmailStore();
  emails.accountProviders.set("imap-1", "IMAP");
  emails.accountProviders.set("gmail-1", "GMAIL");
  emails.accountProviders.set("microsoft-1", "MICROSOFT");
  const push = (account: string, id: string, startedAt: string, extra: Record<string, unknown> = {}) =>
    emails.rows.push({ organization_id: ORG, email_account_id: account, provider_message_id: id, processing_status: "PROCESSING", processing_attempts: 1, processing_started_at: startedAt, ...extra } as never);
  for (let n = 0; n < imap; n++) push("imap-1", `7:${n + 1}`, old(n));
  for (let n = 0; n < gmail; n++) push("gmail-1", `gmail-${n + 1}`, recent);
  for (let n = 0; n < microsoft; n++) push("microsoft-1", `microsoft-${n + 1}`, recent);
  return emails;
}

async function sweep(emails: MemoryEmailStore, options: { imapSyncEnabled: boolean; imapOrganizationIds?: readonly string[]; access?: Map<string, CommercialAccess> }) {
  const producer = makeProducer();
  const outcome = await handleEmailEvent(
    { type: "RECOVER_INCOMPLETE" },
    {
      accounts: makeAccountStore([], options.access),
      emails,
      producer,
      providers: { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: makeAdapter({ provider: "IMAP" }) } as never,
      createContext: () => ({}) as never,
      enqueueSync: vi.fn(),
      logger: silentLogger,
      imapSyncEnabled: options.imapSyncEnabled,
      ...(options.imapOrganizationIds ? { imapOrganizationIds: options.imapOrganizationIds } : {})
    }
  );
  const calls = producer.enqueueProcessing.mock.calls as unknown as Array<[EmailProcessingJob, { jobId: string }]>;
  const jobs = calls.map(([job, opts]) => ({ ...job, jobId: opts.jobId }));
  return { outcome, jobs, byProvider: (provider: string) => jobs.filter((job) => job.provider === provider) };
}

describe("F2: incomplete IMAP emails can no longer fill the global recovery batch", () => {
  it("the original failure: one global batch of the 100 oldest is all IMAP; the Gmail / Microsoft emails are not in it", async () => {
    const emails = seed();
    // The pre-F2 selection (every provider, oldest first, RECOVERY_BATCH): what the sweep used to queue.
    const before = await emails.listIncompleteEmails({ startedBefore: new Date().toISOString(), limit: RECOVERY_BATCH });
    expect(before).toHaveLength(RECOVERY_BATCH);
    expect(before.every((email) => email.provider === "IMAP")).toBe(true);
    expect(before.some((email) => email.provider !== "IMAP")).toBe(false);
  });

  it("1 + 2 + 3. with more IMAP emails than the global batch, Gmail AND Microsoft are recovered", async () => {
    const { jobs, byProvider, outcome } = await sweep(seed({ imap: 150 }), { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS });
    expect(byProvider("GMAIL").map((job) => job.providerMessageId)).toEqual(["gmail-1"]);
    expect(byProvider("MICROSOFT").map((job) => job.providerMessageId)).toEqual(["microsoft-1"]);
    expect(outcome).toEqual({ accounts: 2 + IMAP_RECOVERY_BATCH, enqueued: 2 + IMAP_RECOVERY_BATCH });
    expect(jobs).toHaveLength(2 + IMAP_RECOVERY_BATCH);
  });

  it("4. IMAP is still recovered, within its own limit, oldest first", async () => {
    const { byProvider } = await sweep(seed({ imap: 150 }), { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS });
    expect(IMAP_RECOVERY_BATCH).toBe(20);
    expect(byProvider("IMAP").map((job) => job.providerMessageId)).toEqual(Array.from({ length: IMAP_RECOVERY_BATCH }, (_, n) => `7:${n + 1}`));
  });

  it("Gmail / Microsoft keep their whole batch even when they alone exceed it (100, as before) and IMAP still gets its 20", async () => {
    const { byProvider } = await sweep(seed({ imap: 150, gmail: 80, microsoft: 80 }), { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS });
    expect(byProvider("GMAIL").length + byProvider("MICROSOFT").length).toBe(RECOVERY_BATCH);
    expect(byProvider("IMAP")).toHaveLength(IMAP_RECOVERY_BATCH);
  });

  it("5. no job is duplicated and no email is skipped: same ids on a repeated sweep, the IMAP batch moves on as emails finish", async () => {
    const emails = seed({ imap: 45 });
    const first = await sweep(emails, { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS });
    const ids = first.jobs.map((job) => job.jobId);
    expect(new Set(ids).size).toBe(ids.length); // one job per email
    const again = await sweep(emails, { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS });
    expect(again.jobs.map((job) => job.jobId)).toEqual(ids); // same deterministic ids: BullMQ keeps one job each
    // Nothing was marked or dropped: every IMAP email is still incomplete and will be selected later.
    expect(emails.rows.filter((row) => row.email_account_id === "imap-1" && row.processing_status === "PROCESSING")).toHaveLength(45);
    // The first 20 finish: the next sweep takes the next 20, then the last 5 (none skipped).
    const finish = (from: number, to: number) => {
      for (let n = from; n < to; n++) emails.rows[n]!.processing_status = "PROCESSED";
    };
    finish(0, 20);
    expect((await sweep(emails, { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS })).byProvider("IMAP").map((job) => job.providerMessageId)).toEqual(Array.from({ length: 20 }, (_, n) => `7:${n + 21}`));
    finish(20, 40);
    expect((await sweep(emails, { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS })).byProvider("IMAP").map((job) => job.providerMessageId)).toEqual(["7:41", "7:42", "7:43", "7:44", "7:45"]);
  });

  it("6. eligibility is unchanged: fresh or finished emails are not taken; exhausted ones become FAILED in both batches", async () => {
    const emails = seed({ imap: 2, gmail: 1, microsoft: 0 });
    const push = (account: string, id: string, extra: Record<string, unknown>) =>
      emails.rows.push({ organization_id: ORG, email_account_id: account, provider_message_id: id, processing_status: "PROCESSING", processing_attempts: 1, processing_started_at: recent, ...extra } as never);
    push("gmail-1", "gmail-fresh", { processing_started_at: new Date().toISOString() });
    push("imap-1", "7:900", { processing_started_at: new Date(Date.now() - RECOVERY_STALE_MS / 2).toISOString() });
    push("gmail-1", "gmail-done", { processing_status: "PROCESSED" });
    push("imap-1", "7:901", { processing_status: "FAILED" });
    push("gmail-1", "gmail-exhausted", { processing_attempts: MAX_PROCESSING_ATTEMPTS });
    push("imap-1", "7:902", { processing_attempts: MAX_PROCESSING_ATTEMPTS });
    const { jobs } = await sweep(emails, { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS });
    expect(jobs.map((job) => job.providerMessageId).sort()).toEqual(["7:1", "7:2", "gmail-1"]);
    const status = (id: string) => emails.rows.find((row) => row.provider_message_id === id)?.processing_status;
    expect(status("gmail-exhausted")).toBe("FAILED");
    expect(status("7:902")).toBe("FAILED");
    expect(status("gmail-fresh")).toBe("PROCESSING");
    expect(status("7:900")).toBe("PROCESSING");
  });

  it("6b. the commercial-access filter still applies to both batches (no job, no attempt for an organization without access)", async () => {
    const emails = seed({ imap: 2, gmail: 1, microsoft: 1 });
    for (const row of emails.rows) if (row.email_account_id !== "microsoft-1") row.organization_id = OTHER_ORG;
    const access = new Map<string, CommercialAccess>([[OTHER_ORG, { allowed: false, access: "NONE", subscriptionStatus: "EXPIRED" }]]);
    const { jobs } = await sweep(emails, { imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS, access });
    expect(jobs.map((job) => job.providerMessageId)).toEqual(["microsoft-1"]);
    expect(emails.updateProcessingState).not.toHaveBeenCalled();
  });

  it("7. IMAP disabled (as today): Gmail / Microsoft are recovered exactly as before; IMAP is not even queried", async () => {
    // Without IMAP rows, the selection is exactly the pre-F2 one (same rows, same order, same limit).
    const plain = seed({ imap: 0, gmail: 70, microsoft: 70 });
    const legacy = await plain.listIncompleteEmails({ startedBefore: new Date(Date.now() - RECOVERY_STALE_MS).toISOString(), limit: RECOVERY_BATCH });
    plain.listIncompleteEmails.mockClear();
    const { jobs } = await sweep(plain, { imapSyncEnabled: false });
    expect(jobs.map((job) => job.providerMessageId)).toEqual(legacy.map((email) => email.providerMessageId));
    expect(plain.listIncompleteEmails).toHaveBeenCalledTimes(1);
    expect(plain.listIncompleteEmails).toHaveBeenCalledWith(expect.objectContaining({ limit: RECOVERY_BATCH, imap: "exclude" }));
    // With stuck IMAP emails while IMAP is disabled (e.g. after rolling an activation back): still not starved.
    const withImap = seed({ imap: 150 });
    const disabled = await sweep(withImap, { imapSyncEnabled: false });
    expect(disabled.jobs.map((job) => job.providerMessageId)).toEqual(["gmail-1", "microsoft-1"]);
    expect(withImap.listIncompleteEmails.mock.calls.map(([options]) => options.imap)).toEqual(["exclude"]);
  });
});

describe("F2: the store query (PostgREST filters)", () => {
  function recordingDb() {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "select", "in", "lt", "eq", "neq", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
    return { db: builder as never, calls };
  }
  const common: Array<[string, unknown[]]> = [
    ["from", ["emails"]],
    ["in", ["processing_status", ["RECEIVED", "PROCESSING"]]],
    ["lt", ["processing_started_at", "2026-10-15T00:00:00.000Z"]],
    ["eq", ["email_accounts.status", "ACTIVE"]],
    ["eq", ["organizations.status", "ACTIVE"]],
    ["order", ["processing_started_at", { ascending: true }]]
  ];

  it("exclude: the same filters, order and limit as before plus provider <> IMAP on the joined mailbox", async () => {
    const { db, calls } = recordingDb();
    await createEmailStore(db).listIncompleteEmails({ startedBefore: "2026-10-15T00:00:00.000Z", limit: RECOVERY_BATCH, imap: "exclude" });
    for (const call of common) expect(calls).toContainEqual(call);
    expect(calls).toContainEqual(["neq", ["email_accounts.provider", "IMAP"]]);
    expect(calls).toContainEqual(["limit", [RECOVERY_BATCH]]);
    expect(calls.some(([method, args]) => method === "eq" && args[0] === "email_accounts.provider")).toBe(false);
    expect(String(calls.find(([method]) => method === "select")?.[1][0])).toContain("email_accounts!inner(provider,status)");
  });

  it("only: the same filters plus provider = IMAP, with the IMAP limit", async () => {
    const { db, calls } = recordingDb();
    await createEmailStore(db).listIncompleteEmails({ startedBefore: "2026-10-15T00:00:00.000Z", limit: IMAP_RECOVERY_BATCH, imap: "only" });
    for (const call of common) expect(calls).toContainEqual(call);
    expect(calls).toContainEqual(["eq", ["email_accounts.provider", "IMAP"]]);
    expect(calls).toContainEqual(["limit", [IMAP_RECOVERY_BATCH]]);
    expect(calls.some(([method]) => method === "neq")).toBe(false);
  });

  it("no scope: exactly the pre-F2 query (no provider filter)", async () => {
    const { db, calls } = recordingDb();
    await createEmailStore(db).listIncompleteEmails({ startedBefore: "2026-10-15T00:00:00.000Z", limit: RECOVERY_BATCH });
    for (const call of common) expect(calls).toContainEqual(call);
    expect(calls.some(([, args]) => String(args[0]).startsWith("email_accounts.provider"))).toBe(false);
  });
});
