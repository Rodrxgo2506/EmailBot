import { randomBytes } from "node:crypto";
import { EnvValidationError, type EmailProcessingJob } from "@emailbot/shared";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { assertImapWorkerConcurrency, IMAP_MIN_QUEUE_CONCURRENCY, loadWorkerConfig } from "../config/env.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import type { ProcessEmailDeps } from "../pipeline/process-email.js";
import type { ProviderAdapter, WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeEmail, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";

/*
 * IMAP A2.1: with IMAP synchronization enabled, both shared queues need a concurrency of 2 or more (with 1 the
 * IMAP slots would be the queue's only slot). imapSyncEnabled stays FIXED to false in the worker config (no
 * environment variable can turn it on, see imap-pipeline.test.ts), so the "enabled" cases call the very check
 * loadWorkerConfig applies to the config it returns (assertImapWorkerConcurrency) on a real loaded config with
 * the flag set in the test only: no activation path is added to the production code.
 */

const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };
const ones = { ...base, WORKER_EVENTS_CONCURRENCY: "1", WORKER_PROCESSING_CONCURRENCY: "1" };
const withImap = (env: Record<string, string>) => ({ ...loadWorkerConfig(env), imapSyncEnabled: true });

describe("A2.1: minimum queue concurrency while IMAP synchronization is enabled", () => {
  it("1. IMAP disabled (as fixed in the code) with both global concurrencies at 1: accepted, values unchanged", () => {
    const config = loadWorkerConfig(ones);
    expect(config.imapSyncEnabled).toBe(false);
    expect(config).toMatchObject({ eventsConcurrency: 1, processingConcurrency: 1 });
    expect(() => assertImapWorkerConcurrency(config)).not.toThrow();
  });

  it("2. IMAP enabled with WORKER_EVENTS_CONCURRENCY=1: rejected, naming the variable and the requirement", () => {
    const config = withImap({ ...base, WORKER_EVENTS_CONCURRENCY: "1" });
    expect(() => assertImapWorkerConcurrency(config)).toThrow(EnvValidationError);
    expect(() => assertImapWorkerConcurrency(config)).toThrow(/WORKER_EVENTS_CONCURRENCY: must be at least 2 while IMAP synchronization is enabled \(got 1\)/);
    expect(() => assertImapWorkerConcurrency(config)).not.toThrow(/WORKER_PROCESSING_CONCURRENCY/);
  });

  it("3. IMAP enabled with WORKER_PROCESSING_CONCURRENCY=1: rejected, naming the variable and the requirement", () => {
    const config = withImap({ ...base, WORKER_PROCESSING_CONCURRENCY: "1" });
    expect(() => assertImapWorkerConcurrency(config)).toThrow(/WORKER_PROCESSING_CONCURRENCY: must be at least 2 while IMAP synchronization is enabled \(got 1\)/);
    expect(() => assertImapWorkerConcurrency(config)).not.toThrow(/WORKER_EVENTS_CONCURRENCY/);
  });

  it("both at 1 with IMAP enabled: both variables are reported", () => {
    try {
      assertImapWorkerConcurrency(withImap(ones));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.map((issue) => issue.split(":")[0])).toEqual(["WORKER_EVENTS_CONCURRENCY", "WORKER_PROCESSING_CONCURRENCY"]);
    }
  });

  it("4. IMAP enabled with both concurrencies at 2 (and with the defaults): accepted, values unchanged", () => {
    const two = withImap({ ...base, WORKER_EVENTS_CONCURRENCY: "2", WORKER_PROCESSING_CONCURRENCY: "2" });
    expect(() => assertImapWorkerConcurrency(two)).not.toThrow();
    expect(two).toMatchObject({ eventsConcurrency: 2, processingConcurrency: 2 });
    const defaults = withImap(base);
    expect(() => assertImapWorkerConcurrency(defaults)).not.toThrow();
    expect(defaults).toMatchObject({ eventsConcurrency: 5, processingConcurrency: 10 }); // defaults untouched
    expect(IMAP_MIN_QUEUE_CONCURRENCY).toBe(2);
  });

  it("5. IMAP disabled, concurrencies at 1: Gmail / Microsoft jobs run through the unchanged path (no IMAP slots wired)", async () => {
    const config = loadWorkerConfig(ones);
    expect(config.imapSyncEnabled).toBe(false);
    // As index.ts wires it with IMAP disabled: no imapProcessingSlots, no IMAP budget.
    const accounts: WorkerAccount[] = [makeAccount({ id: "gmail-1", provider: "GMAIL" }), makeAccount({ id: "microsoft-1", provider: "MICROSOFT", emailAddress: "m@outlook.com" })];
    const store = makeAccountStore(accounts);
    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
    const fetchMessage = vi.fn(async (_context: unknown, id: string) => makeEmail({ providerMessageId: id, internetMessageId: `<${id}@x>` }));
    const processDeps: Omit<ProcessEmailDeps, "logger"> = {
      accounts: store,
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers: { GMAIL: makeAdapter({ provider: "GMAIL", fetchMessage }), MICROSOFT: makeAdapter({ provider: "MICROSOFT", fetchMessage }), IMAP: makeAdapter({ provider: "IMAP" }) } as unknown as Record<"IMAP" | "GMAIL" | "MICROSOFT", ProviderAdapter>,
      createContext: (account: WorkerAccount) => ({ account, getAccessToken: async () => "token" }),
      attachmentsBucket: config.attachmentsBucket,
      maxAttachmentBytes: config.maxAttachmentBytes,
      storageRetryDelayMs: 0,
      imapSyncEnabled: config.imapSyncEnabled
    };
    const runner = createJobProcessors({
      eventDeps: {} as never,
      processDeps,
      accounts: store,
      realtime: makeRealtime(),
      logger: { ...silentLogger, child: () => ({ ...silentLogger, child: () => silentLogger }) } as never,
      reportJobFailure: vi.fn(),
      jobType: () => "process-email"
    });
    for (const account of accounts) {
      const job = { id: `j-${account.id}`, queueName: "email-processing", data: { organizationId: account.organizationId, emailAccountId: account.id, provider: account.provider, providerMessageId: `${account.id}-m1` }, attemptsMade: 0, moveToDelayed: vi.fn() } as unknown as Job<EmailProcessingJob> & { moveToDelayed: ReturnType<typeof vi.fn> };
      await expect(runner.processing(job, "t")).resolves.toMatchObject({ status: "processed" });
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    }
    expect(fetchMessage).toHaveBeenCalledTimes(2);
    expect(emails.rows).toHaveLength(2);
  });
});
