import { COALESCED_JOB_OPTIONS, QUEUE_NAMES, watchAccountJobId, type EmailEventJob } from "@emailbot/shared";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * F9 fix: WATCH_ACCOUNT job retention. The API queues WATCH_ACCOUNT (id
 * watch-<account>) when a mailbox is connected; the worker queues WATCH_ACCOUNT
 * with the SAME id for renewals (RENEW_WATCHES) and Graph lifecycle events
 * (queues.enqueueWatch: COALESCED_JOB_OPTIONS + watchAccountJobId). BullMQ
 * ignores an add whose job id still exists, in any state, so a completed API
 * job kept for 24 h (DEFAULT_JOB_OPTIONS) silently dropped those worker jobs.
 *
 * The real createBullJobQueue runs against an in-memory Queue with BullMQ's
 * id semantics: an existing id (waiting / active / completed / failed and
 * retained) makes `add` a no-op; on completion the job is removed only with
 * removeOnComplete: true (a { age } setting keeps it). The same interaction
 * was checked against a real Valkey with BullMQ (F9 audit).
 */

type FakeJob = { id: string; name: string; data: EmailEventJob; opts: Record<string, unknown>; state: "waiting" | "completed" | "failed" };
const queues = vi.hoisted(() => new Map<string, Map<string, unknown>>());

vi.mock("bullmq", () => {
  class Queue {
    readonly jobs: Map<string, FakeJob>;
    private counter = 0;
    constructor(readonly name: string) {
      if (!queues.has(name)) queues.set(name, new Map());
      this.jobs = queues.get(name) as Map<string, FakeJob>;
    }
    async add(name: string, data: EmailEventJob, opts: Record<string, unknown> = {}) {
      const id = typeof opts.jobId === "string" ? opts.jobId : `auto-${++this.counter}`;
      const existing = this.jobs.get(id);
      if (existing) return existing; // BullMQ: duplicated job id -> not added
      const job: FakeJob = { id, name, data, opts, state: "waiting" };
      this.jobs.set(id, job);
      return job;
    }
    async getJob(id: string) {
      const job = this.jobs.get(id);
      return job ? { ...job, getState: async () => job.state, remove: async () => void this.jobs.delete(id) } : undefined;
    }
    async close() {}
  }
  return { Queue };
});

const { createBullJobQueue } = await import("../infrastructure/queue.js");

/** A worker processing every waiting job: completed, then removed or retained per removeOnComplete. */
function processWaiting(): string[] {
  const ran: string[] = [];
  const jobs = queues.get(QUEUE_NAMES.emailEvents) as Map<string, FakeJob>;
  for (const job of [...jobs.values()]) {
    if (job.state !== "waiting") continue;
    ran.push(`${job.name}:${job.id}`);
    job.state = "completed";
    if (job.opts.removeOnComplete === true) jobs.delete(job.id);
  }
  return ran;
}

/** Exactly what the worker does in apps/worker/src/infrastructure/queues.ts (enqueueWatch). */
async function workerEnqueueWatch(account: { id: string; organizationId: string }) {
  const { Queue } = await import("bullmq");
  await new Queue(QUEUE_NAMES.emailEvents, { connection: {} as never }).add(
    "WATCH_ACCOUNT",
    { type: "WATCH_ACCOUNT", emailAccountId: account.id, organizationId: account.organizationId },
    { ...COALESCED_JOB_OPTIONS, jobId: watchAccountJobId(account.id) }
  );
}

const ACCOUNT = { id: "acc-1", organizationId: "org-1" };
const watchJob: EmailEventJob = { type: "WATCH_ACCOUNT", emailAccountId: ACCOUNT.id, organizationId: ACCOUNT.organizationId };

beforeEach(() => queues.clear());

describe("WATCH_ACCOUNT job retention (API -> worker, same job id)", () => {
  it("a completed API WATCH_ACCOUNT is not retained, so the worker's WATCH_ACCOUNT (renewal / lifecycle) still runs", async () => {
    const api = createBullJobQueue({} as Redis);

    // 1. Mailbox connected: the API queues WATCH_ACCOUNT, the worker runs it.
    await api.enqueueEmailEvent(watchJob, { jobId: watchAccountJobId(ACCOUNT.id) });
    expect(processWaiting()).toEqual(["WATCH_ACCOUNT:watch-acc-1"]);
    // 2. Completed and released (before the fix it stayed "completed" for 24 h).
    expect(queues.get(QUEUE_NAMES.emailEvents)?.has("watch-acc-1")).toBe(false);

    // 3. Later, within those 24 h: renewal or reauthorizationRequired / subscriptionRemoved.
    await workerEnqueueWatch(ACCOUNT);
    // 4. Not dropped: it runs.
    expect(processWaiting()).toEqual(["WATCH_ACCOUNT:watch-acc-1"]);
  });

  it("still deduplicated while pending: two connections before the worker runs make one job", async () => {
    const api = createBullJobQueue({} as Redis);
    await api.enqueueEmailEvent(watchJob, { jobId: watchAccountJobId(ACCOUNT.id) });
    await workerEnqueueWatch(ACCOUNT);
    await api.enqueueEmailEvent(watchJob, { jobId: watchAccountJobId(ACCOUNT.id) });
    expect(processWaiting()).toEqual(["WATCH_ACCOUNT:watch-acc-1"]);
  });

  it("the cause: a retained completed job with the same id makes BullMQ drop the next add", async () => {
    const { Queue } = await import("bullmq");
    const queue = new Queue(QUEUE_NAMES.emailEvents, { connection: {} as never });
    // DEFAULT_JOB_OPTIONS retention (what the API used for WATCH_ACCOUNT before the fix).
    await queue.add("WATCH_ACCOUNT", watchJob, { removeOnComplete: { age: 24 * 3600, count: 10_000 }, jobId: watchAccountJobId(ACCOUNT.id) });
    expect(processWaiting()).toHaveLength(1);
    await workerEnqueueWatch(ACCOUNT);
    expect(processWaiting()).toEqual([]);
  });

  it("other jobs keep their behavior: SYNC_ACCOUNT released, notifications retained (redelivery dedupe)", async () => {
    const api = createBullJobQueue({} as Redis);
    await api.enqueueEmailEvent({ type: "SYNC_ACCOUNT", emailAccountId: "acc-1", organizationId: "org-1", requestedBy: null }, { jobId: "sync-acc-1" });
    await api.enqueueEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "box@example.test", historyId: "1" }, { jobId: "gmail-x-1" });
    await api.enqueueEmailEvent({ type: "MICROSOFT_NOTIFICATION", subscriptionId: "s", resource: "r", messageId: "m" }, { jobId: "graph-x" });
    processWaiting();
    const jobs = queues.get(QUEUE_NAMES.emailEvents);
    expect(jobs?.has("sync-acc-1")).toBe(false);
    expect(jobs?.has("gmail-x-1")).toBe(true);
    expect(jobs?.has("graph-x")).toBe(true);
    // A redelivered push is still the same (retained) job: not processed twice.
    await api.enqueueEmailEvent({ type: "MICROSOFT_NOTIFICATION", subscriptionId: "s", resource: "r", messageId: "m" }, { jobId: "graph-x" });
    expect(processWaiting()).toEqual([]);
  });
});
