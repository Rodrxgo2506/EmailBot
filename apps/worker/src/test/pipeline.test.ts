import { describe, expect, it, vi } from "vitest";
import { handleAccountFailure, NonRetryableError } from "../pipeline/failures.js";
import { handleEmailEvent, MAX_PROCESSING_ATTEMPTS } from "../pipeline/handle-email-event.js";
import { deliverNotification } from "../pipeline/notify.js";
import { notificationJobId } from "@emailbot/shared";
import { AttachmentsPendingError, processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { ProviderAuthError, ProviderNotImplementedError, type WorkerAccount } from "../providers/types.js";
import {
  makeAccount,
  makeAccountStore,
  makeAdapter,
  makeEmail,
  makeProducer,
  makeRealtime,
  makeRegistry,
  makeRuleRow,
  MemoryEmailStore,
  ORG,
  OTHER_ORG,
  silentLogger
} from "./fakes.js";

function setup(options: { account?: WorkerAccount; adapter?: ReturnType<typeof makeAdapter> } = {}) {
  const account = options.account ?? makeAccount();
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow()];
  const adapter = options.adapter ?? makeAdapter();
  const producer = makeProducer();
  const realtime = makeRealtime();
  const objects = new Map<string, Uint8Array>();
  const storage = {
    objects,
    upload: vi.fn(async (_bucket: string, path: string, content: Uint8Array) => void objects.set(path, content)),
    exists: vi.fn(async (_bucket: string, path: string) => objects.has(path))
  };
  const accounts = makeAccountStore([account]);

  const deps: ProcessEmailDeps = {
    accounts,
    emails,
    storage,
    realtime,
    producer,
    providers: makeRegistry(adapter),
    createContext: (acc) => ({ account: acc, getAccessToken: async () => "token" }),
    attachmentsBucket: "email-attachments",
    maxAttachmentBytes: 1000,
    logger: silentLogger,
    storageRetryDelayMs: 0
  };
  const job = { organizationId: ORG, emailAccountId: account.id, provider: "GMAIL" as const, providerMessageId: "msg-1" };
  return { account, emails, adapter, producer, realtime, storage, accounts, deps, job };
}

const PDF = { providerAttachmentId: "a1", filename: "factura.pdf", contentType: "application/pdf", size: 3, contentId: null, isInline: false };
const withPdfAdapter = () => makeAdapter({ fetchMessage: vi.fn(async () => makeEmail({ attachments: [PDF] })) });

describe("processEmail", () => {
  it("stores a matching email with the rule outcome", async () => {
    const { deps, job, emails, realtime, producer } = setup();

    const outcome = await processEmail(job, deps);

    expect(outcome).toEqual({ status: "processed", emailId: "email-1", matchedRuleIds: ["rule-1"] });
    expect(emails.rows).toHaveLength(1);
    expect(emails.rows[0]).toMatchObject({
      organization_id: ORG,
      email_account_id: "account-1",
      provider_message_id: "msg-1",
      category_id: "category-codes",
      matched_rule_id: "rule-1",
      processing_status: "PROCESSED",
      is_important: true,
      extracted_data: { verification_code: "4821" },
      headers: { "message-id": "<m1@example.com>" }
    });
    expect(realtime.events[0]).toMatchObject({ type: "email.processed", organizationId: ORG, emailId: "email-1" });
    expect(producer.notifications).toHaveLength(1);
    expect(producer.notifications[0]?.body).toContain("verification_code: 4821");
  });

  it("is idempotent: the same message processed twice creates one row and fetches once", async () => {
    const { deps, job, emails, adapter } = setup();

    const first = await processEmail(job, deps);
    const second = await processEmail(job, deps);

    expect(first.status).toBe("processed");
    expect(second).toEqual({ status: "skipped", reason: "duplicate" });
    expect(emails.rows).toHaveLength(1);
    expect(adapter.fetchMessage).toHaveBeenCalledTimes(1);
  });

  it("handles a concurrent duplicate detected only by the unique index", async () => {
    const { deps, job, emails, realtime } = setup();
    // The pre-check misses the row (written and completed by a concurrent job in between).
    emails.findEmail.mockResolvedValueOnce(null);
    emails.rows.push({ organization_id: ORG, email_account_id: "account-1", provider_message_id: "msg-1", processing_status: "PROCESSED" });

    const outcome = await processEmail(job, deps);
    expect(outcome).toEqual({ status: "skipped", reason: "duplicate" });
    expect(emails.rows).toHaveLength(1);
    expect(realtime.events).toHaveLength(0);
  });

  it("does not store emails that match no rule", async () => {
    const adapter = makeAdapter({ fetchMessage: vi.fn(async () => makeEmail({ subject: "Newsletter" })) });
    const { deps, job, emails, realtime } = setup({ adapter });

    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "no_matching_rule" });
    expect(emails.rows).toHaveLength(0);
    expect(realtime.events).toHaveLength(0);
  });

  it("does not fetch anything when the organization has no enabled rules", async () => {
    const { deps, job, emails, adapter } = setup();
    emails.rules = [makeRuleRow({ enabled: false })];

    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "no_enabled_rules" });
    expect(adapter.fetchMessage).not.toHaveBeenCalled();
  });

  it("skips rules with invalid JSON instead of executing them", async () => {
    const { deps, job, emails } = setup();
    emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "nope" }] } })];
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "no_enabled_rules" });
  });

  it("respects stop_processing across rules", async () => {
    const { deps, job, emails } = setup();
    emails.rules = [
      makeRuleRow({ id: "first", priority: 1, stop_processing: true, category_id: "cat-first", actions: { actions: [] } }),
      makeRuleRow({ id: "second", priority: 2, category_id: "cat-second" })
    ];

    const outcome = await processEmail(job, deps);
    expect(outcome).toMatchObject({ status: "processed", matchedRuleIds: ["first"] });
    expect(emails.rows[0]).toMatchObject({ category_id: "cat-first", is_important: false });
  });

  it("refuses jobs whose organization does not own the account", async () => {
    const { deps, job, emails, adapter } = setup();
    const outcome = await processEmail({ ...job, organizationId: OTHER_ORG }, deps);

    expect(outcome).toEqual({ status: "skipped", reason: "account_not_found" });
    expect(adapter.fetchMessage).not.toHaveBeenCalled();
    expect(emails.rows).toHaveLength(0);
  });

  it("skips paused accounts and organizations with auto-processing disabled", async () => {
    const paused = setup({ account: makeAccount({ status: "PAUSED" }) });
    expect(await processEmail(paused.job, paused.deps)).toEqual({ status: "skipped", reason: "account_inactive" });

    const disabled = setup();
    disabled.emails.settings = { ...disabled.emails.settings, autoProcessingEnabled: false };
    expect(await processEmail(disabled.job, disabled.deps)).toEqual({
      status: "skipped",
      reason: "auto_processing_disabled"
    });
  });

  it("stores attachment metadata and uploads only eligible content", async () => {
    const adapter = makeAdapter({
      fetchMessage: vi.fn(async () =>
        makeEmail({
          attachments: [
            { providerAttachmentId: "a1", filename: "factura.pdf", contentType: "application/pdf", size: 10, contentId: null, isInline: false },
            { providerAttachmentId: "a2", filename: "logo.png", contentType: "image/png", size: 5, contentId: "x", isInline: true },
            { providerAttachmentId: "a3", filename: "huge.zip", contentType: "application/zip", size: 5000, contentId: null, isInline: false }
          ]
        })
      )
    });
    const { deps, job, emails, storage } = setup({ adapter });

    await processEmail(job, deps);

    expect(emails.attachments).toHaveLength(3);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.upload).toHaveBeenCalledWith(
      "email-attachments",
      `${ORG}/email-1/attachment-1/factura.pdf`,
      expect.any(Uint8Array),
      "application/pdf"
    );
    expect(emails.attachments[0]?.storage_path).toBe(`${ORG}/email-1/attachment-1/factura.pdf`);
  });

  it("uploads attachments with Unicode names under an ASCII key and keeps the original name (regression)", async () => {
    const names = ["Cotización.xlsx", "Factura ñ.pdf", "résumé.docx", "报告.pdf", "📎 informe.pdf"];
    const adapter = makeAdapter({
      fetchMessage: vi.fn(async () =>
        makeEmail({
          attachments: names.map((filename, index) => ({
            providerAttachmentId: `a${index}`,
            filename,
            contentType: "application/octet-stream",
            size: 3,
            contentId: null,
            isInline: false
          }))
        })
      )
    });
    const { deps, job, emails, storage } = setup({ adapter });

    expect((await processEmail(job, deps)).status).toBe("processed");
    // Same job again (retry / duplicate delivery): no second email, no second upload.
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "duplicate" });

    expect(emails.rows).toHaveLength(1);
    expect(emails.attachments.map((attachment) => attachment.filename)).toEqual(names);
    expect(storage.upload).toHaveBeenCalledTimes(names.length);
    const paths = storage.upload.mock.calls.map((call) => (call as unknown[])[1] as string);
    for (const [index, path] of paths.entries()) {
      expect(path).toMatch(new RegExp(`^${ORG}/email-1/attachment-${index + 1}/[A-Za-z0-9._-]+$`));
      expect(emails.attachments[index]?.storage_path).toBe(path);
    }
    expect(new Set(paths).size).toBe(names.length);
  });

  it("a retry resumes an email whose attachment rows failed: attachments, realtime and notifications are completed", async () => {
    const adapter = makeAdapter({ fetchMessage: vi.fn(async () => makeEmail({ attachments: [PDF] })) });
    const { deps, job, emails, producer, realtime, storage } = setup({ adapter });
    // Every in-job retry of the attachment insert fails (e.g. the database is unreachable).
    emails.insertAttachments
      .mockRejectedValueOnce(new Error("PostgREST 503"))
      .mockRejectedValueOnce(new Error("PostgREST 503"))
      .mockRejectedValueOnce(new Error("PostgREST 503"));

    await expect(processEmail(job, deps)).rejects.toThrow("PostgREST 503");
    expect(emails.rows).toHaveLength(1);
    expect(emails.attachments).toHaveLength(0);

    // BullMQ retries the job (attempt 2): the stored email is resumed, not skipped.
    const outcome = await processEmail(job, deps, { attempt: 2 });
    expect(outcome).toEqual({ status: "resumed", emailId: "email-1", insertedAttachments: 1 });
    expect(emails.rows).toHaveLength(1);
    expect(emails.attachments).toHaveLength(1);
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
    expect(storage.objects.size).toBe(1);
    expect(realtime.events.filter((event) => event.type === "email.processed")).toHaveLength(1);
    expect(producer.notifications).toHaveLength(1);
  });

  it("a new delivery of an already stored message is a duplicate and notifies nobody again", async () => {
    const { deps, job, producer, realtime } = setup();
    await processEmail(job, deps);
    expect(await processEmail(job, deps, { attempt: 1 })).toEqual({ status: "skipped", reason: "duplicate" });
    expect(realtime.events.filter((event) => event.type === "email.processed")).toHaveLength(1);
    expect(producer.notifications).toHaveLength(1);
  });

  it("does not enqueue notifications when the organization disabled them", async () => {
    const { deps, job, emails, producer } = setup();
    emails.settings = { ...emails.settings, notificationsEnabled: false };
    await processEmail(job, deps);
    expect(producer.notifications).toHaveLength(0);
  });

  it("sanitizes senders that violate the database constraint", async () => {
    const adapter = makeAdapter({
      fetchMessage: vi.fn(async () => makeEmail({ sender: { address: "MAILER-DAEMON", name: null } }))
    });
    const { deps, job, emails } = setup({ adapter });
    emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "subject", operator: "contains", value: "código" }] } })];

    await processEmail(job, deps);
    expect(emails.rows[0]).toMatchObject({
      sender_email: "unknown@invalid.invalid",
      provider_metadata: { originalSender: "MAILER-DAEMON" }
    });
  });
});

describe("attachment storage reliability", () => {
  const withPdf = () => makeAdapter({ fetchMessage: vi.fn(async () => makeEmail({ attachments: [PDF] })) });
  const failing = (times: number) => {
    let calls = 0;
    return async () => {
      calls += 1;
      if (calls <= times) throw new Error("Storage 503");
    };
  };

  it("uploads, then marks the row stored", async () => {
    const { deps, job, emails, storage } = setup({ adapter: withPdf() });
    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(emails.attachments[0]).toMatchObject({ storage_uploaded: true, storage_path: `${ORG}/email-1/attachment-1/factura.pdf` });
  });

  it("retries a failing upload inside the job", async () => {
    const { deps, job, emails, storage } = setup({ adapter: withPdf() });
    const upload = storage.upload.getMockImplementation()!;
    const fail = failing(2);
    storage.upload.mockImplementation(async (...args: Parameters<typeof upload>) => {
      await fail();
      return upload(...args);
    });
    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(storage.upload).toHaveBeenCalledTimes(3);
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
  });

  it("an upload that keeps failing fails the job (retryable) and the retry stores it without notifying twice", async () => {
    const { deps, job, emails, storage, producer, adapter } = setup({ adapter: withPdf() });
    const upload = storage.upload.getMockImplementation()!;
    const fail = failing(3);
    storage.upload.mockImplementation(async (...args: Parameters<typeof upload>) => {
      await fail();
      return upload(...args);
    });

    const first = processEmail(job, deps);
    await expect(first).rejects.toBeInstanceOf(AttachmentsPendingError);
    expect(emails.attachments[0]?.storage_uploaded).not.toBe(true);
    expect(producer.notifications).toHaveLength(1);

    expect(await processEmail(job, deps, { attempt: 2 })).toMatchObject({ status: "resumed", insertedAttachments: 0 });
    expect(emails.attachments).toHaveLength(1);
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
    expect(adapter.downloadAttachment).toHaveBeenCalledTimes(2);
    // Re-enqueued with the same deterministic job id: BullMQ keeps a single notification.
    expect(producer.notifications).toHaveLength(2);
    expect(new Set(producer.notifications.map(notificationJobId)).size).toBe(1);
  });

  it("an object uploaded by an attempt whose bookkeeping failed is reused, not downloaded again (orphan repair)", async () => {
    const { deps, job, emails, storage, adapter } = setup({ adapter: withPdf() });
    emails.markAttachmentStored
      .mockRejectedValueOnce(new Error("PostgREST 503"))
      .mockRejectedValueOnce(new Error("PostgREST 503"))
      .mockRejectedValueOnce(new Error("PostgREST 503"));

    await expect(processEmail(job, deps)).rejects.toBeInstanceOf(AttachmentsPendingError);
    expect(storage.objects.size).toBe(1); // orphan: object exists, row not marked
    expect(emails.attachments[0]?.storage_uploaded).not.toBe(true);

    await processEmail(job, deps, { attempt: 2 });
    expect(adapter.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
  });

  it("an object that already exists is not uploaded again", async () => {
    const { deps, job, emails, storage, adapter } = setup({ adapter: withPdf() });
    storage.objects.set(`${ORG}/email-1/attachment-1/factura.pdf`, new Uint8Array([1]));
    await processEmail(job, deps);
    expect(adapter.downloadAttachment).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
  });

  it("a new delivery resumes an email left incomplete by an exhausted job", async () => {
    const { deps, job, emails, storage, producer } = setup({ adapter: withPdf() });
    const upload = storage.upload.getMockImplementation()!;
    const fail = failing(3);
    storage.upload.mockImplementation(async (...args: Parameters<typeof upload>) => {
      await fail();
      return upload(...args);
    });
    await expect(processEmail(job, deps)).rejects.toBeInstanceOf(AttachmentsPendingError);

    expect(await processEmail(job, deps, { attempt: 1 })).toMatchObject({ status: "resumed", insertedAttachments: 0 });
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
    expect(emails.rows[0]?.processing_status).toBe("PROCESSED");
    // Re-enqueued with the same job id: a single notification in BullMQ.
    expect(new Set(producer.notifications.map(notificationJobId)).size).toBe(1);
  });

  it("an insert whose response was lost is not duplicated by the in-job retry", async () => {
    const { deps, job, emails } = setup({ adapter: withPdf() });
    const insert = emails.insertAttachments.getMockImplementation()!;
    emails.insertAttachments.mockImplementationOnce(async (rows) => {
      await insert(rows);
      throw new Error("socket hang up");
    });
    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(emails.attachments).toHaveLength(1);
  });

  it("two concurrent workers for the same message store one email and one attachment", async () => {
    const { deps, job, emails, storage } = setup({ adapter: withPdf() });
    const outcomes = await Promise.all([processEmail(job, deps), processEmail(job, deps)]);
    // The second worker finds the email still PROCESSING and completes it too (idempotently).
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["processed", "resumed"]);
    expect(emails.rows).toHaveLength(1);
    expect(emails.attachments).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
  });

  it("revoked credentials while downloading are not swallowed (account -> ERROR, no retry)", async () => {
    const adapter = makeAdapter({
      fetchMessage: vi.fn(async () => makeEmail({ attachments: [PDF] })),
      downloadAttachment: vi.fn(async () => {
        throw new ProviderAuthError("revoked", "AUTH_REVOKED");
      })
    });
    const { deps, job } = setup({ adapter });
    await expect(processEmail(job, deps)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("contents over the size limit are intentionally not stored and do not fail the job", async () => {
    const adapter = makeAdapter({ fetchMessage: vi.fn(async () => makeEmail({ attachments: [{ ...PDF, size: 5000 }] })) });
    const { deps, job, storage } = setup({ adapter });
    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe("processing completion (migration 9)", () => {
  const twoPdfs = () =>
    makeAdapter({
      fetchMessage: vi.fn(async () => makeEmail({ attachments: [PDF, { ...PDF, providerAttachmentId: "a2", filename: "anexo.pdf" }] }))
    });
  const once = <T extends (...args: never[]) => Promise<unknown>>(mock: { mockImplementationOnce(fn: T): unknown }, error: Error) =>
    mock.mockImplementationOnce((async () => {
      throw error;
    }) as unknown as T);
  const crash = () => new Error("worker crashed");
  const statusOf = (emails: MemoryEmailStore) => emails.rows[0]?.processing_status;

  it("1. a new email goes RECEIVED -> PROCESSING -> PROCESSED", async () => {
    const { deps, job, emails } = setup({ adapter: withPdfAdapter() });
    const insert = emails.insertEmail.getMockImplementation()!;
    let insertedRow: Record<string, unknown> = {};
    emails.insertEmail.mockImplementationOnce(async (row) => {
      insertedRow = { ...row };
      return insert(row);
    });
    await processEmail(job, deps);
    expect(insertedRow).toMatchObject({ processing_status: "RECEIVED", processed_at: null, processing_attempts: 1 });
    expect(emails.stateHistory.map((entry) => entry.status)).toEqual(["PROCESSING", "PROCESSED"]);
    expect(emails.rows[0]).toMatchObject({ processing_status: "PROCESSED", processing_error_code: null });
    expect(emails.rows[0]?.processed_at).toEqual(expect.any(String));
  });

  it("2. crash right after the email insert: the retry completes it", async () => {
    const { deps, job, emails, storage, producer } = setup({ adapter: withPdfAdapter() });
    once(emails.updateProcessingState, crash());
    await expect(processEmail(job, deps)).rejects.toThrow("worker crashed");
    expect(statusOf(emails)).toBe("RECEIVED");

    expect(await processEmail(job, deps, { attempt: 2 })).toMatchObject({ status: "resumed", insertedAttachments: 1 });
    expect(statusOf(emails)).toBe("PROCESSED");
    expect(emails.rows[0]?.processing_attempts).toBe(2);
    expect(storage.objects.size).toBe(1);
    expect(producer.notifications).toHaveLength(1);
  });

  it("3. crash after the attachment rows: the retry does not duplicate them", async () => {
    const { deps, job, emails, storage } = setup({ adapter: twoPdfs() });
    storage.exists.mockRejectedValueOnce(crash()).mockRejectedValueOnce(crash()).mockRejectedValueOnce(crash());
    await expect(processEmail(job, deps)).rejects.toBeInstanceOf(AttachmentsPendingError);
    expect(emails.attachments).toHaveLength(2);
    expect(emails.rows[0]?.processing_error_code).toBe("ATTACHMENTS_PENDING");

    await processEmail(job, deps);
    expect(emails.attachments).toHaveLength(2);
    expect(emails.attachments.every((attachment) => attachment.storage_uploaded)).toBe(true);
    expect(statusOf(emails)).toBe("PROCESSED");
    expect(emails.rows[0]?.processing_error_code).toBeNull();
  });

  it("4. crash after the Storage upload: the retry reuses the object", async () => {
    const { deps, job, emails, storage, adapter } = setup({ adapter: withPdfAdapter() });
    emails.markAttachmentStored.mockRejectedValueOnce(crash()).mockRejectedValueOnce(crash()).mockRejectedValueOnce(crash());
    await expect(processEmail(job, deps)).rejects.toBeInstanceOf(AttachmentsPendingError);
    await processEmail(job, deps);
    expect(adapter.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
    expect(statusOf(emails)).toBe("PROCESSED");
  });

  it("5 + 6. crash after markAttachmentStored, before realtime: the retry publishes the event, nothing is re-uploaded", async () => {
    const { deps, job, emails, storage, realtime } = setup({ adapter: withPdfAdapter() });
    once(realtime.publish, crash());
    await expect(processEmail(job, deps)).rejects.toThrow("worker crashed");
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
    expect(statusOf(emails)).toBe("PROCESSING");
    expect(realtime.events).toHaveLength(0);

    await processEmail(job, deps);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(realtime.events.filter((event) => event.type === "email.processed")).toHaveLength(1);
    expect(statusOf(emails)).toBe("PROCESSED");
  });

  it("7. crash before the notification: the retry enqueues it with the same job id", async () => {
    const { deps, job, emails, producer } = setup({ adapter: withPdfAdapter() });
    once(producer.enqueueNotification, crash());
    await expect(processEmail(job, deps)).rejects.toThrow("worker crashed");
    expect(statusOf(emails)).toBe("PROCESSING");

    await processEmail(job, deps);
    expect(producer.notifications).toHaveLength(1);
    expect(notificationJobId(producer.notifications[0]!)).toBe(`notify-email-1-rule-1-in_app`);
    expect(statusOf(emails)).toBe("PROCESSED");
  });

  it("8. a job that exhausted its retries is resumed by the recovery sweep", async () => {
    const { deps, job, emails, storage } = setup({ adapter: withPdfAdapter() });
    const upload = storage.upload.getMockImplementation()!;
    storage.upload.mockImplementation(async () => {
      throw new Error("Storage down");
    });
    await expect(processEmail(job, deps)).rejects.toBeInstanceOf(AttachmentsPendingError);
    // BullMQ gave up; 20 minutes later the sweep runs.
    emails.rows[0]!.processing_started_at = new Date(Date.now() - 20 * 60_000).toISOString();
    storage.upload.mockImplementation(upload);

    const producer = makeProducer();
    const sweep = await handleEmailEvent(
      { type: "RECOVER_INCOMPLETE" },
      { accounts: makeAccountStore([]), emails, producer, providers: makeRegistry(makeAdapter()), createContext: deps.createContext, enqueueSync: vi.fn(), logger: silentLogger }
    );
    expect(sweep).toEqual({ accounts: 1, enqueued: 1 });
    expect(producer.enqueueProcessing).toHaveBeenCalledWith(job, { jobId: "resume-email-1-1" });

    expect(await processEmail(producer.processing[0]!, deps)).toMatchObject({ status: "resumed" });
    expect(statusOf(emails)).toBe("PROCESSED");
    expect(emails.attachments[0]?.storage_uploaded).toBe(true);
  });

  it("8b. the sweep ignores fresh incomplete emails and gives up after MAX_PROCESSING_ATTEMPTS", async () => {
    const emails = new MemoryEmailStore();
    emails.rows.push(
      { organization_id: ORG, email_account_id: "account-1", provider_message_id: "fresh", processing_status: "PROCESSING", processing_attempts: 1, processing_started_at: new Date().toISOString() },
      { organization_id: ORG, email_account_id: "account-1", provider_message_id: "stuck", processing_status: "PROCESSING", processing_attempts: MAX_PROCESSING_ATTEMPTS, processing_started_at: "2026-01-01T00:00:00.000Z" },
      { organization_id: ORG, email_account_id: "account-1", provider_message_id: "done", processing_status: "PROCESSED", processing_attempts: 1, processing_started_at: "2026-01-01T00:00:00.000Z" }
    );
    const producer = makeProducer();
    const outcome = await handleEmailEvent(
      { type: "RECOVER_INCOMPLETE" },
      { accounts: makeAccountStore([]), emails, producer, providers: makeRegistry(makeAdapter()), createContext: () => ({}) as never, enqueueSync: vi.fn(), logger: silentLogger }
    );
    expect(outcome).toEqual({ accounts: 1, enqueued: 0 });
    expect(emails.rows[1]).toMatchObject({ processing_status: "FAILED", processing_error_code: "RECOVERY_EXHAUSTED" });
    expect(emails.rows[0]?.processing_status).toBe("PROCESSING");
  });

  it("8c. a stalled job restarted with attempt 1 resumes (state decides, not BullMQ counters)", async () => {
    const { deps, job, emails } = setup({ adapter: withPdfAdapter() });
    once(emails.updateProcessingState, crash());
    await expect(processEmail(job, deps)).rejects.toThrow();
    expect(await processEmail(job, deps, { attempt: 1 })).toMatchObject({ status: "resumed" });
  });

  it("8d. a FAILED (abandoned) email is not resumed", async () => {
    const { deps, job, emails, adapter } = setup({ adapter: withPdfAdapter() });
    emails.rows.push({ organization_id: ORG, email_account_id: "account-1", provider_message_id: "msg-1", processing_status: "FAILED" });
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "duplicate" });
    expect(adapter.fetchMessage).not.toHaveBeenCalled();
  });

  it("9. two concurrent workers: exactly one attachment row per provider attachment id", async () => {
    const { deps, job, emails } = setup({ adapter: twoPdfs() });
    await Promise.all([processEmail(job, deps), processEmail(job, deps), processEmail(job, deps)]);
    expect(emails.rows).toHaveLength(1);
    expect(emails.attachments.map((attachment) => attachment.provider_attachment_id).sort()).toEqual(["a1", "a2"]);
    expect(statusOf(emails)).toBe("PROCESSED");
  });

  it("10. attachments without provider id do not conflict and are not duplicated on resume", async () => {
    const adapter = makeAdapter({
      fetchMessage: vi.fn(async () =>
        makeEmail({
          attachments: [
            { ...PDF, providerAttachmentId: null, filename: "uno.pdf" },
            { ...PDF, providerAttachmentId: null, filename: "dos.pdf" }
          ]
        })
      )
    });
    const { deps, job, emails } = setup({ adapter });
    once(deps.realtime.publish as never, crash());
    await expect(processEmail(job, deps)).rejects.toThrow();
    await processEmail(job, deps);
    expect(emails.attachments.map((attachment) => attachment.filename).sort()).toEqual(["dos.pdf", "uno.pdf"]);
  });

  it("11. two different attachments of the same email are both kept", async () => {
    const { deps, job, emails, storage } = setup({ adapter: twoPdfs() });
    await processEmail(job, deps);
    expect(emails.attachments).toHaveLength(2);
    expect(storage.objects.size).toBe(2);
  });

  it("12. two consecutive resumes duplicate nothing", async () => {
    const { deps, job, emails, producer, realtime, storage } = setup({ adapter: twoPdfs() });
    once(emails.updateProcessingState, crash());
    await expect(processEmail(job, deps)).rejects.toThrow();
    // First resume dies right before marking PROCESSED; the second completes.
    emails.updateProcessingState.mockImplementation(async (emailId, state) => {
      if (state.status === "PROCESSED" && emails.updateProcessingState.mock.calls.filter((call) => call[1].status === "PROCESSED").length === 1) {
        throw crash();
      }
      const row = emails.row(emailId);
      row.processing_status = state.status;
      if (state.attempts !== undefined) row.processing_attempts = state.attempts;
      if (state.processedAt !== undefined) row.processed_at = state.processedAt;
    });
    await expect(processEmail(job, deps)).rejects.toThrow();
    expect(await processEmail(job, deps)).toMatchObject({ status: "resumed", insertedAttachments: 0 });

    expect(emails.rows).toHaveLength(1);
    expect(emails.attachments).toHaveLength(2);
    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(new Set(producer.notifications.map(notificationJobId)).size).toBe(1);
    expect(new Set(realtime.events.map((event) => (event as { emailId: string }).emailId)).size).toBe(1);
    expect(statusOf(emails)).toBe("PROCESSED");
  });

  it("notifications are not re-sent when resuming after the de-duplication window", async () => {
    const { deps, job, emails, producer } = setup({ adapter: withPdfAdapter() });
    emails.rows.push({
      organization_id: ORG,
      email_account_id: "account-1",
      provider_message_id: "msg-1",
      processing_status: "PROCESSING",
      processing_attempts: 3,
      processing_started_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString()
    });
    expect(await processEmail(job, deps)).toMatchObject({ status: "resumed" });
    expect(producer.notifications).toHaveLength(0);
    expect(statusOf(emails)).toBe("PROCESSED");
  });
});

function eventSetup(accounts: WorkerAccount[], adapter = makeAdapter()) {
  const store = makeAccountStore(accounts);
  const producer = makeProducer();
  const enqueueSync = vi.fn(async () => undefined);
  return {
    store,
    producer,
    adapter,
    enqueueSync,
    deps: {
      accounts: store,
      emails: new MemoryEmailStore(),
      producer,
      providers: makeRegistry(adapter),
      createContext: (account: WorkerAccount) => ({ account, getAccessToken: async () => "t" }),
      enqueueSync,
      logger: silentLogger
    }
  };
}

describe("handleEmailEvent", () => {
  it("Gmail notification syncs every active account with that address (one per organization)", async () => {
    const adapter = makeAdapter({ listNewMessageIds: vi.fn(async () => ({ messageIds: ["m1", "m2"], nextCursor: "200" })) });
    const { deps, producer, store } = eventSetup(
      [
        makeAccount({ id: "acc-a", organizationId: ORG }),
        makeAccount({ id: "acc-b", organizationId: OTHER_ORG }),
        makeAccount({ id: "acc-paused", status: "PAUSED" })
      ],
      adapter
    );

    const outcome = await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "me@gmail.com", historyId: "200" }, deps);

    expect(outcome).toEqual({ accounts: 2, enqueued: 4 });
    expect(producer.processing.map((job) => `${job.organizationId}/${job.emailAccountId}/${job.providerMessageId}`)).toEqual([
      `${ORG}/acc-a/m1`,
      `${ORG}/acc-a/m2`,
      `${OTHER_ORG}/acc-b/m1`,
      `${OTHER_ORG}/acc-b/m2`
    ]);
    expect(store.updateSyncState).toHaveBeenCalledWith("acc-a", expect.objectContaining({ syncCursor: "200" }));
  });

  it("SYNC_ACCOUNT ignores accounts of another organization", async () => {
    const { deps, adapter } = eventSetup([makeAccount({ id: "acc-a", organizationId: ORG })]);
    const outcome = await handleEmailEvent(
      { type: "SYNC_ACCOUNT", emailAccountId: "acc-a", organizationId: OTHER_ORG, requestedBy: null },
      deps
    );
    expect(outcome).toEqual({ accounts: 0, enqueued: 0 });
    expect(adapter.listNewMessageIds).not.toHaveBeenCalled();
  });

  it("Microsoft notification with a message id enqueues it directly", async () => {
    const { deps, producer } = eventSetup([
      makeAccount({ id: "acc-ms", provider: "MICROSOFT", providerMetadata: { subscriptionId: "sub-1" } })
    ]);
    await handleEmailEvent({ type: "MICROSOFT_NOTIFICATION", subscriptionId: "sub-1", resource: "x", messageId: "m9" }, deps);
    expect(producer.processing).toEqual([
      { organizationId: ORG, emailAccountId: "acc-ms", provider: "MICROSOFT", providerMessageId: "m9" }
    ]);
  });

  it("POLL_ACCOUNTS schedules a sync per active OAuth account", async () => {
    const { deps, enqueueSync } = eventSetup([
      makeAccount({ id: "a1" }),
      makeAccount({ id: "a2", provider: "IMAP" }),
      makeAccount({ id: "a3", status: "ERROR" })
    ]);
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(enqueueSync).toHaveBeenCalledTimes(1);
    expect(enqueueSync).toHaveBeenCalledWith({ id: "a1", organizationId: ORG });
  });
});

describe("failure handling", () => {
  const deps = () => ({ accounts: makeAccountStore([]), realtime: makeRealtime(), logger: silentLogger });

  it("revoked credentials put the account in ERROR and stop retries", async () => {
    const d = deps();
    await expect(
      handleAccountFailure(new ProviderAuthError("revoked", "AUTH_REVOKED"), { id: "acc", organizationId: ORG }, d)
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(d.accounts.markError).toHaveBeenCalledWith("acc", expect.objectContaining({ code: "AUTH_REVOKED", status: "ERROR" }));
    expect(d.realtime.events[0]).toMatchObject({ type: "email-account.status", status: "ERROR" });
  });

  it("not-implemented integrations are not retried", async () => {
    await expect(
      handleAccountFailure(new ProviderNotImplementedError("IMAP", "sync"), { id: "acc", organizationId: ORG }, deps())
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("other errors are rethrown for retry", async () => {
    const error = new Error("timeout");
    await expect(handleAccountFailure(error, { id: "acc", organizationId: ORG }, deps())).rejects.toBe(error);
  });
});

describe("notifications", () => {
  it("delivers in-app notifications in real time and does not fake email delivery", async () => {
    const emails = new MemoryEmailStore();
    const realtime = makeRealtime();
    const base = { organizationId: ORG, emailId: "e1", ruleId: "r1", title: "T", body: "B" };

    expect(await deliverNotification({ ...base, channel: "in_app" }, { emails, realtime, logger: silentLogger })).toBe("delivered");
    expect(realtime.events).toEqual([{ type: "notification", organizationId: ORG, emailId: "e1", title: "T", body: "B" }]);
    expect(await deliverNotification({ ...base, channel: "email" }, { emails, realtime, logger: silentLogger })).toBe(
      "skipped_not_implemented"
    );
  });
});

describe("EmailBot V2 phase 1: bots and organization status", () => {
  const NETFLIX = "bot-netflix";
  const YAPE = "bot-yape";
  const botRule = (id: string, botId: string, overrides: Parameters<typeof makeRuleRow>[0] = {}) =>
    makeRuleRow({ id, bot_id: botId, bot: { status: "ACTIVE" }, ...overrides });

  it("stores the bot selected by the highest-priority bot rule (and announces it)", async () => {
    const { deps, job, emails, realtime } = setup();
    emails.rules = [botRule("netflix", NETFLIX, { priority: 5 }), botRule("yape", YAPE, { priority: 50 })];

    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(emails.rows[0]).toMatchObject({ bot_id: NETFLIX, matched_rule_id: "netflix" });
    expect(emails.rows[0]?.provider_metadata).not.toHaveProperty("botSelection");
    expect(realtime.events[0]).toMatchObject({ type: "email.processed", botId: NETFLIX });
  });

  it("a general rule (bot_id null) still stores the email without a bot", async () => {
    const { deps, job, emails } = setup();
    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(emails.rows[0]).toMatchObject({ bot_id: null });
  });

  it("an ambiguous tie between bots stores the email without a bot and records the candidates", async () => {
    const { deps, job, emails } = setup();
    const warn = vi.fn();
    deps.logger = { ...silentLogger, warn };
    emails.rules = [botRule("netflix", NETFLIX, { priority: 10 }), botRule("yape", YAPE, { priority: 10 })];

    expect((await processEmail(job, deps)).status).toBe("processed");
    expect(emails.rows[0]).toMatchObject({
      bot_id: null,
      provider_metadata: expect.objectContaining({ botSelection: "AMBIGUOUS", botCandidateIds: [NETFLIX, YAPE] })
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "bot.selection.ambiguous", organizationId: ORG, botCandidateIds: [NETFLIX, YAPE] }),
      expect.any(String)
    );
  });

  it("rules of a PAUSED bot are ignored: the email is not stored", async () => {
    const { deps, job, emails } = setup();
    emails.rules = [botRule("netflix", NETFLIX, { bot: { status: "PAUSED" } })];

    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "no_matching_rule" });
    expect(emails.rows).toHaveLength(0);
  });

  it("a bot rule whose bot status is unknown is treated as paused (fail closed)", async () => {
    const { deps, job, emails } = setup();
    emails.rules = [botRule("netflix", NETFLIX, { bot: null })];
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "no_matching_rule" });
  });

  it.each(["SUSPENDED", "CANCELLED"] as const)("a %s organization gets nothing processed and nothing fetched", async (status) => {
    const { deps, job, emails, adapter, realtime } = setup({ account: makeAccount({ organizationStatus: status }) });
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "organization_inactive" });
    expect(adapter.fetchMessage).not.toHaveBeenCalled();
    expect(emails.rows).toHaveLength(0);
    expect(realtime.events).toHaveLength(0);
  });

  it("an incomplete email of a suspended organization is left untouched (history kept, not retried)", async () => {
    const { deps, job, emails } = setup({ account: makeAccount({ organizationStatus: "SUSPENDED" }) });
    emails.rows.push({
      organization_id: ORG,
      email_account_id: "account-1",
      provider_message_id: "msg-1",
      processing_status: "PROCESSING",
      processing_attempts: 1
    });
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "organization_inactive" });
    expect(emails.rows[0]).toMatchObject({ processing_status: "PROCESSING", processing_attempts: 1 });
    expect(emails.updateProcessingState).not.toHaveBeenCalled();
  });

  it("SYNC_ACCOUNT of a suspended organization lists nothing and keeps the cursor", async () => {
    const { deps, adapter, store } = eventSetup([makeAccount({ id: "acc-s", organizationStatus: "SUSPENDED" })]);
    const outcome = await handleEmailEvent({ type: "SYNC_ACCOUNT", emailAccountId: "acc-s", organizationId: ORG, requestedBy: null }, deps);
    expect(outcome).toEqual({ accounts: 1, enqueued: 0 });
    expect(adapter.listNewMessageIds).not.toHaveBeenCalled();
    expect(store.updateSyncState).not.toHaveBeenCalled();
  });

  it("POLL_ACCOUNTS skips accounts of suspended organizations", async () => {
    const { deps, enqueueSync } = eventSetup([makeAccount({ id: "ok" }), makeAccount({ id: "suspended", organizationStatus: "SUSPENDED" })]);
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(enqueueSync).toHaveBeenCalledTimes(1);
    expect(enqueueSync).toHaveBeenCalledWith(expect.objectContaining({ id: "ok" }));
  });
});
