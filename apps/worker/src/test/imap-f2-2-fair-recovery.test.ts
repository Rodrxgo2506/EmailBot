import type { EmailProcessingJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { createEmailStore } from "../infrastructure/supabase-stores.js";
import {
  handleEmailEvent,
  IMAP_RECOVERY_BATCH,
  IMAP_RECOVERY_MAX_EXCLUDED_ORGANIZATIONS,
  IMAP_RECOVERY_PAGE,
  IMAP_RECOVERY_SCAN_MAX,
  MAX_PROCESSING_ATTEMPTS,
  RECOVERY_BATCH,
  RECOVERY_STALE_MS
} from "../pipeline/handle-email-event.js";
import type { CommercialAccess } from "../pipeline/ports.js";
import { makeAccountStore, makeProducer, MemoryEmailStore, silentLogger } from "./fakes.js";

/*
 * F2.2: the IMAP recovery batch (selectImapRecovery) reads candidates in bounded pages, skips organizations that
 * cannot be processed (no commercial access, IMAP not in the plan) without touching their emails, and shares the 20
 * places round robin between organizations. The store query is checked at the end; a real PostgreSQL + PostgREST
 * run is in the F2.2 report. Gmail / Microsoft: their batch and query are exactly F2's.
 */

const NO_ACCESS: CommercialAccess = { allowed: false, access: "NONE", subscriptionStatus: "EXPIRED" };
const org = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();

interface Group {
  org: string;
  count: number;
  from: number;
  provider?: "IMAP" | "GMAIL" | "MICROSOFT";
  attempts?: number;
}

function seed(groups: Group[]) {
  const emails = new MemoryEmailStore();
  for (const group of groups) {
    const account = `${(group.provider ?? "IMAP").toLowerCase()}-${group.org.slice(-4)}`;
    emails.accountProviders.set(account, group.provider ?? "IMAP");
    for (let n = 0; n < group.count; n++)
      emails.rows.push({
        organization_id: group.org,
        email_account_id: account,
        provider_message_id: `${account}:${n}`,
        processing_status: "PROCESSING",
        processing_attempts: group.attempts ?? 1,
        processing_started_at: at(group.from + n)
      } as never);
  }
  return emails;
}

async function sweep(emails: MemoryEmailStore, options: { imapSyncEnabled?: boolean; noAccess?: string[]; noImap?: string[] } = {}) {
  const access = new Map<string, CommercialAccess>((options.noAccess ?? []).map((id) => [id, NO_ACCESS]));
  const accounts = makeAccountStore([], access, new Set(options.noImap ?? []));
  const producer = makeProducer();
  const lines: Array<Record<string, unknown>> = [];
  const logger = { ...silentLogger, info: (fields: unknown) => void lines.push(fields as Record<string, unknown>) };
  emails.listIncompleteEmails.mockClear();
  const outcome = await handleEmailEvent(
    { type: "RECOVER_INCOMPLETE" },
    { accounts, emails, producer, providers: {} as never, createContext: () => ({}) as never, enqueueSync: vi.fn(), logger, imapSyncEnabled: options.imapSyncEnabled ?? true }
  );
  const calls = producer.enqueueProcessing.mock.calls as unknown as Array<[EmailProcessingJob, { jobId: string }]>;
  const jobs = calls.map(([job, opts]) => ({ ...job, jobId: opts.jobId }));
  const imapJobs = jobs.filter((job) => job.provider === "IMAP");
  const perOrg = new Map<string, number>();
  for (const job of imapJobs) perOrg.set(job.organizationId, (perOrg.get(job.organizationId) ?? 0) + 1);
  const imapPages = emails.listIncompleteEmails.mock.calls.filter(([opts]) => opts.imap === "only");
  const scanned = (await Promise.all(emails.listIncompleteEmails.mock.results.map((result) => result.value as Promise<unknown[]>)))
    .filter((_, index) => emails.listIncompleteEmails.mock.calls[index]?.[0].imap === "only")
    .reduce((sum, page) => sum + page.length, 0);
  const selection = lines.find((line) => line.event === "imap.recovery.selected");
  return { outcome, jobs, imapJobs, perOrg, imapPages, scanned, selection, accounts };
}

const status = (emails: MemoryEmailStore, account: string) => emails.rows.filter((row) => row.email_account_id === account).map((row) => `${row.processing_status}/${row.processing_attempts}`);

describe("F2.2 A: organizations that cannot be processed no longer block the IMAP batch", () => {
  it("1. the 60 oldest candidates belong to an organization WITHOUT commercial access: the recoverable ones behind are recovered", async () => {
    const emails = seed([
      { org: org(1), count: 60, from: 0 },
      { org: org(2), count: 8, from: 1000 }
    ]);
    const run = await sweep(emails, { noAccess: [org(1)] });
    expect(run.imapJobs.map((job) => job.organizationId)).toEqual(Array.from({ length: 8 }, () => org(2)));
    expect(run.imapPages.length).toBe(2); // page 1 reveals the blocked organization; page 2 leaves it out
    expect(run.imapPages[1]?.[0].excludeOrganizations).toEqual([org(1)]);
    // 5. Its emails are untouched: not queued, not marked, no attempt consumed.
    expect(new Set(status(emails, "imap-0001"))).toEqual(new Set(["PROCESSING/1"]));
  });

  it("2. the oldest candidates belong to an organization whose plan no longer includes IMAP: skipped, the others recovered", async () => {
    const emails = seed([
      { org: org(1), count: 30, from: 0 },
      { org: org(2), count: 3, from: 1000 }
    ]);
    const run = await sweep(emails, { noImap: [org(1)] });
    expect(run.imapJobs.map((job) => job.providerMessageId)).toEqual(["imap-0002:0", "imap-0002:1", "imap-0002:2"]);
    expect(new Set(status(emails, "imap-0001"))).toEqual(new Set(["PROCESSING/1"]));
    expect(run.accounts.imapEntitled).toHaveBeenCalledWith(org(1));
  });

  it("5. skipped is not discarded: once the organization may be processed again its emails are recovered", async () => {
    const emails = seed([{ org: org(1), count: 3, from: 0 }]);
    expect((await sweep(emails, { noAccess: [org(1)] })).imapJobs).toHaveLength(0);
    expect((await sweep(emails, { noImap: [org(1)] })).imapJobs).toHaveLength(0);
    expect((await sweep(emails)).imapJobs.map((job) => job.providerMessageId)).toEqual(["imap-0001:0", "imap-0001:1", "imap-0001:2"]);
  });

  it("3. up to 20 recoverable candidates are gathered behind many blocked organizations, without exceeding the read limit", async () => {
    // 40 blocked organizations (10 emails each, the oldest), then 30 recoverable organizations (2 each).
    const groups: Group[] = [];
    for (let n = 1; n <= 40; n++) groups.push({ org: org(n), count: 10, from: n * 100 });
    for (let n = 41; n <= 70; n++) groups.push({ org: org(n), count: 2, from: 100_000 + n * 10 });
    const emails = seed(groups);
    const run = await sweep(emails, { noAccess: Array.from({ length: 40 }, (_, n) => org(n + 1)) });
    expect(run.imapJobs).toHaveLength(IMAP_RECOVERY_BATCH);
    expect(run.perOrg.size).toBe(IMAP_RECOVERY_BATCH); // one each of the 20 oldest recoverable organizations
    expect(run.scanned).toBeLessThanOrEqual(IMAP_RECOVERY_SCAN_MAX);
    expect(run.imapPages.every(([opts]) => opts.limit <= IMAP_RECOVERY_PAGE)).toBe(true);
  });

  it("3b. the read limit is reached before 20 candidates: the run ends safely and a later run continues", async () => {
    // 600 exhausted emails of an allowed organization (they become FAILED, outside the 20 places) before 1 recoverable.
    const emails = seed([
      { org: org(1), count: 600, from: 0, attempts: MAX_PROCESSING_ATTEMPTS },
      { org: org(2), count: 1, from: 10_000 }
    ]);
    const first = await sweep(emails);
    expect(first.scanned).toBe(IMAP_RECOVERY_SCAN_MAX);
    expect(first.imapPages).toHaveLength(IMAP_RECOVERY_SCAN_MAX / IMAP_RECOVERY_PAGE); // 10 pages, not one query more
    expect(first.imapPages.every(([opts]) => opts.limit > 0)).toBe(true);
    expect(first.selection).toMatchObject({ readLimitReached: true, selected: 0, exhausted: IMAP_RECOVERY_SCAN_MAX });
    expect(first.imapJobs).toHaveLength(0);
    expect(emails.rows.filter((row) => row.processing_status === "FAILED")).toHaveLength(IMAP_RECOVERY_SCAN_MAX);
    const second = await sweep(emails);
    expect(second.imapJobs.map((job) => job.providerMessageId)).toEqual(["imap-0002:0"]);
    expect(emails.rows.filter((row) => row.processing_status === "FAILED")).toHaveLength(600);
  });

  it("the excluded-organizations list is bounded: the scan stops once it would grow past the limit", async () => {
    // Pages of 50 emails from 50 different blocked organizations each.
    const groups: Group[] = [];
    for (let n = 1; n <= 200; n++) groups.push({ org: org(n), count: 1, from: n });
    groups.push({ org: org(999), count: 1, from: 10_000 });
    const run = await sweep(seed(groups), { noAccess: Array.from({ length: 200 }, (_, n) => org(n + 1)) });
    expect(run.imapPages.every(([opts]) => (opts.excludeOrganizations?.length ?? 0) <= IMAP_RECOVERY_MAX_EXCLUDED_ORGANIZATIONS)).toBe(true);
    expect(run.imapJobs).toHaveLength(0); // org 999 is read by a later run once those organizations change
  });

  it("9. emails that reached the attempt limit follow the current policy (FAILED), outside the 20 places; a blocked organization's stay as they are", async () => {
    const emails = seed([
      { org: org(1), count: 3, from: 0, attempts: MAX_PROCESSING_ATTEMPTS },
      { org: org(2), count: 2, from: 100, attempts: MAX_PROCESSING_ATTEMPTS },
      { org: org(3), count: 25, from: 1000 }
    ]);
    const run = await sweep(emails, { noAccess: [org(2)] });
    expect(new Set(status(emails, "imap-0001"))).toEqual(new Set([`FAILED/${MAX_PROCESSING_ATTEMPTS}`]));
    expect(new Set(status(emails, "imap-0002"))).toEqual(new Set([`PROCESSING/${MAX_PROCESSING_ATTEMPTS}`]));
    expect(run.imapJobs).toHaveLength(IMAP_RECOVERY_BATCH);
  });
});

describe("F2.2 B: organizations share the IMAP batch", () => {
  it("6. one organization with 300 stuck emails no longer fills the batch: 4 organizations get 5 places each, run after run", async () => {
    const emails = seed([
      { org: org(1), count: 300, from: 0 },
      { org: org(2), count: 10, from: 10_000 },
      { org: org(3), count: 10, from: 20_000 },
      { org: org(4), count: 10, from: 30_000 }
    ]);
    for (let n = 0; n < 3; n++) {
      const run = await sweep(emails);
      expect([...run.perOrg.entries()]).toEqual([org(1), org(2), org(3), org(4)].map((id) => [id, 5]));
      // Oldest first within each organization.
      expect(run.imapJobs.filter((job) => job.organizationId === org(2)).map((job) => job.providerMessageId)).toEqual(Array.from({ length: 5 }, (_, i) => `imap-0002:${i}`));
    }
  });

  it("round robin (max-min fair): never more than 5 each when 4+ organizations have 5+ candidates, no place left empty while candidates remain, shares differ by at most 1", async () => {
    const distributions = [[30, 30, 30, 30], [30, 30, 30, 30, 2], [100, 1, 1, 1], [3, 3, 3, 3, 3, 3], [40, 40, 40], [40, 3], [7, 7, 7, 7, 7], [1, 1, 1]];
    const observed: string[] = [];
    for (const counts of distributions) {
      const run = await sweep(seed(counts.map((count, n) => ({ org: org(n + 1), count, from: n * 1000 }))));
      const shares = counts.map((_, n) => run.perOrg.get(org(n + 1)) ?? 0);
      const label = `${JSON.stringify(counts)} -> ${JSON.stringify(shares)}`;
      observed.push(label);
      expect(shares.reduce((sum, value) => sum + value, 0), label).toBe(Math.min(IMAP_RECOVERY_BATCH, counts.reduce((sum, value) => sum + value, 0)));
      if (counts.filter((count) => count >= 5).length >= 4) expect(Math.max(...shares), label).toBeLessThanOrEqual(5);
      // Max-min fair: an organization left with candidates never has 2+ places fewer than another organization.
      for (let i = 0; i < counts.length; i++) {
        if (shares[i]! < counts[i]!) for (const other of shares) expect(other - shares[i]!, label).toBeLessThanOrEqual(1);
      }
    }
    // Places the others cannot use are not left empty: 3 organizations with 1 email each -> the 4th gets the other 17.
    expect(observed).toContain("[100,1,1,1] -> [17,1,1,1]");
    expect(observed).toContain("[30,30,30,30,2] -> [5,5,4,4,2]");
  });

  it("7. several organizations in one run, no duplicated job: 25 organizations -> the 20 with the oldest candidates, one each", async () => {
    const groups: Group[] = [];
    for (let n = 1; n <= 25; n++) groups.push({ org: org(n), count: 3, from: n * 100 });
    const run = await sweep(seed(groups));
    expect(run.imapJobs).toHaveLength(IMAP_RECOVERY_BATCH);
    expect([...run.perOrg.keys()]).toEqual(Array.from({ length: IMAP_RECOVERY_BATCH }, (_, n) => org(n + 1)));
    expect(new Set(run.jobs.map((job) => job.jobId)).size).toBe(run.jobs.length);
  });

  it("places nobody else needs are not wasted: a single organization still gets the 20 oldest (as in F2)", async () => {
    const run = await sweep(seed([{ org: org(1), count: 150, from: 0 }]));
    expect(run.imapJobs.map((job) => job.providerMessageId)).toEqual(Array.from({ length: 20 }, (_, n) => `imap-0001:${n}`));
  });

  it("an organization beyond the first page is reached (the page key moves on, settled organizations are left out)", async () => {
    // 120 emails of org 1 (oldest) fill the first pages; org 2 appears only after them.
    const run = await sweep(seed([
      { org: org(1), count: 120, from: 0 },
      { org: org(2), count: 2, from: 10_000 }
    ]));
    expect([...run.perOrg.entries()]).toEqual([[org(1), 18], [org(2), 2]]);
    expect(run.imapPages[1]?.[0]).toMatchObject({ excludeOrganizations: [org(1)], after: { id: "email-50" } });
  });

  it("8. order and limits are deterministic: equal start times are ordered by id; repeated runs give the same jobs", async () => {
    const emails = seed([
      { org: org(1), count: 30, from: 0 },
      { org: org(2), count: 30, from: 0 }
    ]);
    for (const row of emails.rows) row.processing_started_at = at(0); // every candidate ties on the start time
    const first = await sweep(emails);
    const second = await sweep(emails);
    expect(second.jobs.map((job) => job.jobId)).toEqual(first.jobs.map((job) => job.jobId));
    expect([...first.perOrg.values()]).toEqual([10, 10]);
  });
});

describe("F2.2: unchanged for Gmail / Microsoft and with IMAP disabled", () => {
  it("10. IMAP disabled: the IMAP query and the entitlement check never run", async () => {
    const emails = seed([
      { org: org(1), count: 50, from: 0 },
      { org: org(2), count: 2, from: 1000, provider: "GMAIL" }
    ]);
    const run = await sweep(emails, { imapSyncEnabled: false });
    expect(run.imapPages).toHaveLength(0);
    expect(run.accounts.imapEntitled).not.toHaveBeenCalled();
    expect(run.jobs.map((job) => job.providerMessageId)).toEqual(["gmail-0002:0", "gmail-0002:1"]);
  });

  it("11. Gmail / Microsoft: same call (limit 100, every provider but IMAP), same selection and deterministic ids", async () => {
    const groups: Group[] = [
      { org: org(1), count: 200, from: 0 },
      { org: org(2), count: 70, from: 10_000, provider: "GMAIL" },
      { org: org(3), count: 70, from: 20_000, provider: "MICROSOFT" }
    ];
    const run = await sweep(seed(groups));
    const others = run.jobs.filter((job) => job.provider !== "IMAP");
    expect(others).toHaveLength(RECOVERY_BATCH);
    expect(others.slice(0, 70).every((job) => job.provider === "GMAIL")).toBe(true);
    expect(others[0]).toMatchObject({ providerMessageId: "gmail-0002:0", jobId: "resume-email-201-1" });
    const call = (await (async () => {
      const emails = seed(groups);
      await sweep(emails);
      return emails.listIncompleteEmails.mock.calls[0]?.[0];
    })())!;
    expect(call).toEqual({ startedBefore: expect.any(String), limit: RECOVERY_BATCH, imap: "exclude" });
    expect(Date.now() - Date.parse(call.startedBefore)).toBeGreaterThanOrEqual(RECOVERY_STALE_MS);
  });

  it("12. the shared commercial-access rule is unchanged: a Gmail email of an organization without access is left as it is", async () => {
    const emails = seed([
      { org: org(1), count: 2, from: 0, provider: "GMAIL" },
      { org: org(2), count: 1, from: 100, provider: "MICROSOFT" }
    ]);
    const run = await sweep(emails, { noAccess: [org(1)] });
    expect(run.jobs.map((job) => job.providerMessageId)).toEqual(["microsoft-0002:0"]);
    expect(new Set(status(emails, "gmail-0001"))).toEqual(new Set(["PROCESSING/1"]));
  });
});

describe("F2.2: the IMAP page query (PostgREST)", () => {
  function recordingDb() {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "select", "in", "lt", "eq", "neq", "or", "not", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
    return { db: builder as never, calls };
  }

  it("4. same filters as before (status, age, mailbox ACTIVE, organization ACTIVE) plus the page key, the exclusions and a total order", async () => {
    const { db, calls } = recordingDb();
    await createEmailStore(db).listIncompleteEmails({
      startedBefore: "2026-10-15T00:00:00.000Z",
      limit: IMAP_RECOVERY_PAGE,
      imap: "only",
      after: { startedAt: "2026-01-01T00:00:00+00:00", id: "11111111-1111-4111-8111-111111111111" },
      excludeOrganizations: [org(1), org(2)]
    });
    expect(calls).toContainEqual(["in", ["processing_status", ["RECEIVED", "PROCESSING"]]]);
    expect(calls).toContainEqual(["lt", ["processing_started_at", "2026-10-15T00:00:00.000Z"]]);
    expect(calls).toContainEqual(["eq", ["email_accounts.status", "ACTIVE"]]);
    expect(calls).toContainEqual(["eq", ["organizations.status", "ACTIVE"]]);
    expect(calls).toContainEqual(["eq", ["email_accounts.provider", "IMAP"]]);
    expect(calls).toContainEqual([
      "or",
      ['processing_started_at.gt."2026-01-01T00:00:00+00:00",and(processing_started_at.eq."2026-01-01T00:00:00+00:00",id.gt.11111111-1111-4111-8111-111111111111)']
    ]);
    expect(calls).toContainEqual(["not", ["organization_id", "in", `(${org(1)},${org(2)})`]]);
    const orders = calls.filter(([method]) => method === "order").map(([, args]) => args[0]);
    expect(orders).toEqual(["processing_started_at", "id"]);
    expect(String(calls.find(([method]) => method === "select")?.[1][0])).toContain("processing_started_at");
  });

  it("the Gmail / Microsoft query is byte-for-byte F2's (no page key, no exclusions, no id order, same columns)", async () => {
    const { db, calls } = recordingDb();
    await createEmailStore(db).listIncompleteEmails({ startedBefore: "2026-10-15T00:00:00.000Z", limit: RECOVERY_BATCH, imap: "exclude" });
    expect(calls.map(([method]) => method)).toEqual(["from", "select", "in", "lt", "eq", "eq", "neq", "order", "limit"]);
    expect(calls[1]).toEqual([
      "select",
      ["id,organization_id,email_account_id,provider_message_id,processing_attempts,email_accounts!inner(provider,status),organizations!inner(status)"]
    ]);
  });
});
