import type { EmailProcessingJob, NotificationJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { accessDeniedReason, NO_ACCESS } from "../pipeline/commercial-access.js";
import { handleEmailEvent, syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { deliverNotification } from "../pipeline/notify.js";
import type { CommercialAccess, Logger } from "../pipeline/ports.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import type { WorkerAccount } from "../providers/types.js";
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
  SUBSCRIBED
} from "./fakes.js";

/*
 * Commercial V1.2: the worker processes nothing for an organization without
 * commercial access (ACTIVE subscription inside its period, or legacy), and
 * checks it again when a job runs (not only when it was queued).
 */

const none = (subscriptionStatus: CommercialAccess["subscriptionStatus"]): CommercialAccess => ({ allowed: false, access: "NONE", subscriptionStatus });
const LEGACY: CommercialAccess = { allowed: true, access: "LEGACY", subscriptionStatus: null };

function recordingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (object) => void lines.push(object),
    warn: (object) => void lines.push(object),
    error: (object) => void lines.push(object)
  };
  return { logger, denied: () => lines.filter((line) => line.event === "subscription.access_denied"), lines };
}

function processSetup(access: CommercialAccess, account: WorkerAccount = makeAccount()) {
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow()];
  const adapter = makeAdapter();
  const accessMap = new Map<string, CommercialAccess>([[account.organizationId, access]]);
  const accounts = makeAccountStore([account], accessMap);
  const { logger, denied } = recordingLogger();
  const realtime = makeRealtime();
  const deps: ProcessEmailDeps = {
    accounts,
    emails,
    routing: new MemoryRoutingStore(emails),
    audit: makeAudit(),
    storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
    realtime,
    producer: makeProducer(),
    providers: makeRegistry(adapter),
    createContext: (acc) => ({ account: acc, getAccessToken: async () => "token" }),
    attachmentsBucket: "email-attachments",
    maxAttachmentBytes: 1000,
    logger,
    storageRetryDelayMs: 0
  };
  const job: EmailProcessingJob = { organizationId: account.organizationId, emailAccountId: account.id, provider: account.provider, providerMessageId: "msg-1" };
  return { deps, job, emails, adapter, accessMap, accounts, denied, realtime };
}

describe("processing a message (EMAIL_PROCESSING jobs and every sync)", () => {
  it("case 1: ACTIVE subscription inside its period -> processed normally", async () => {
    const { deps, job, emails } = processSetup(SUBSCRIBED);
    expect(await processEmail(job, deps)).toMatchObject({ status: "processed" });
    expect(emails.rows).toHaveLength(1);
  });

  it.each([
    ["case 2: no subscription", none(null), "no_subscription"],
    ["case 3: PAST_DUE", none("PAST_DUE"), "subscription_past_due"],
    ["case 4: SUSPENDED", none("SUSPENDED"), "subscription_suspended"],
    ["case 5: CANCELED", none("CANCELED"), "subscription_canceled"],
    ["case 6: EXPIRED", none("EXPIRED"), "subscription_expired"],
    ["case 7: ACTIVE but the period ended (or has not started)", none("ACTIVE"), "period_not_current"]
  ])("%s -> skipped before fetching: no rules, bots, deliveries or notifications; logged", async (_label, access, reason) => {
    const { deps, job, emails, adapter, denied, realtime } = processSetup(access);
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "subscription_inactive" });
    expect(adapter.fetchMessage).not.toHaveBeenCalled();
    expect(emails.rows).toHaveLength(0);
    expect(emails.loadEnabledRules).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
    expect(denied()).toEqual([
      {
        event: "subscription.access_denied",
        organizationId: ORG,
        subscriptionStatus: access.subscriptionStatus,
        operation: "process_email",
        reason,
        emailAccountId: "account-1",
        provider: "GMAIL"
      }
    ]);
  });

  it("case 8: a job queued while ACTIVE but run after the subscription expired is skipped and completes (no retry)", async () => {
    const { deps, job, emails, accessMap } = processSetup(SUBSCRIBED);
    // Queued (the job payload exists)... then the period ends before the worker picks it up.
    accessMap.set(ORG, none("EXPIRED"));
    const outcome = await processEmail(job, deps);
    // A resolved "skipped" outcome: BullMQ marks the job completed, so it is never retried.
    expect(outcome).toEqual({ status: "skipped", reason: "subscription_inactive" });
    expect(emails.rows).toHaveLength(0);
  });

  it("case 9: LEGACY (pre-subscription organization) -> processed exactly as before", async () => {
    const { deps, job, emails } = processSetup(LEGACY);
    expect(await processEmail(job, deps)).toMatchObject({ status: "processed" });
    expect(emails.rows).toHaveLength(1);
  });

  it("fail closed: an organization the database did not answer for has no access", async () => {
    const { deps, job, accounts } = processSetup(SUBSCRIBED);
    vi.mocked(accounts.commercialAccess).mockResolvedValue(new Map());
    expect(await processEmail(job, deps)).toEqual({ status: "skipped", reason: "subscription_inactive" });
    expect(accessDeniedReason(NO_ACCESS)).toBe("no_subscription");
  });

  it("a database error while checking is thrown (the job is retried with backoff), never treated as access", async () => {
    const { deps, job, accounts, emails } = processSetup(SUBSCRIBED);
    vi.mocked(accounts.commercialAccess).mockRejectedValue(new Error("organizationAccess failed: timeout"));
    await expect(processEmail(job, deps)).rejects.toThrow(/organizationAccess failed/);
    expect(emails.rows).toHaveLength(0);
  });

  it("the log line carries no address, token or email content", async () => {
    const { deps, job, denied } = processSetup(none("SUSPENDED"), makeAccount({ accessTokenEncrypted: "enc-secret", emailAddress: "private@client.test" }));
    await processEmail(job, deps);
    expect(JSON.stringify(denied())).not.toMatch(/private@client|enc-secret|token/i);
  });
});

/* ------------------------------------------------------------------ sync, push, polling, watches */

function eventSetup(accounts: WorkerAccount[], access: Map<string, CommercialAccess>) {
  const store = makeAccountStore(accounts, access);
  const adapter = makeAdapter({
    listNewMessageIds: vi.fn(async () => ({ messageIds: ["m1"], nextCursor: "200" })),
    watch: vi.fn(async () => ({ expiresAt: "2026-10-12T00:00:00.000Z" }))
  });
  const emails = new MemoryEmailStore();
  const { logger, denied, lines } = recordingLogger();
  const processMessage = vi.fn(async () => ({ status: "processed" as const, emailId: "e1", matchedRuleIds: [] }));
  const lock = { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) };
  const enqueueSync = vi.fn(async (_account: { id: string; organizationId: string }, _reason?: string) => undefined);
  const enqueueWatch = vi.fn(async (_account: { id: string; organizationId: string }) => undefined);
  const producer = makeProducer();
  const expireDue = vi.fn(async () => 3);
  const deps: HandleEventDeps = {
    accounts: store,
    emails,
    producer,
    providers: makeRegistry(adapter),
    createContext: (account) => ({ account, getAccessToken: async () => "token" }),
    enqueueSync,
    enqueueWatch,
    processMessage,
    lock,
    watchTopic: "projects/p/topics/t",
    subscriptions: { expireDue },
    now: () => Date.parse("2026-10-06T12:00:00.000Z"),
    logger
  };
  return { deps, store, adapter, emails, processMessage, lock, enqueueSync, enqueueWatch, producer, expireDue, denied, lines };
}

const paying = makeAccount({ id: "paying", organizationId: ORG, emailAddress: "box@gmail.com" });
const unpaid = makeAccount({ id: "unpaid", organizationId: OTHER_ORG, emailAddress: "box@gmail.com" });
const accessByOrg = () => new Map<string, CommercialAccess>([[OTHER_ORG, none("EXPIRED")]]);

describe("sync and its triggers", () => {
  it("SYNC_ACCOUNT (manual, portal, polling, continuation) without access: nothing listed, cursor and lock untouched", async () => {
    const { deps, adapter, processMessage, lock, denied } = eventSetup([unpaid], accessByOrg());
    const result = await syncAccount(unpaid, deps, "PORTAL");
    expect(result).toMatchObject({ found: 0, processed: 0, cursorAdvanced: false });
    expect(adapter.listNewMessageIds).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(unpaid.syncCursor).toBe("100");
    expect(denied()[0]).toMatchObject({ operation: "sync", jobType: "PORTAL", reason: "subscription_expired", organizationId: OTHER_ORG });
  });

  it("SYNC_ACCOUNT with access syncs normally", async () => {
    const account = makeAccount({ id: "paying-sync" });
    const { deps, processMessage } = eventSetup([account], new Map());
    const result = await syncAccount(account, deps, "POLL");
    expect(result).toMatchObject({ found: 1, processed: 1, cursorAdvanced: true });
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("Gmail push: the same mailbox in a paying and an unpaid organization -> only the paying one syncs", async () => {
    const { deps, enqueueSync } = eventSetup([paying, unpaid], accessByOrg());
    const outcome = await handleEmailEvent({ type: "GMAIL_NOTIFICATION", emailAddress: "box@gmail.com", historyId: "9" }, deps);
    expect(outcome).toEqual({ accounts: 1, enqueued: 1 });
    expect(enqueueSync).toHaveBeenCalledWith(paying, "PUBSUB");
  });

  it("recovery polling skips unpaid organizations (one access query for the batch)", async () => {
    const { deps, enqueueSync, store } = eventSetup([paying, unpaid], accessByOrg());
    expect(await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps)).toEqual({ accounts: 1, enqueued: 1 });
    expect(enqueueSync.mock.calls.map(([account]) => account.id)).toEqual(["paying"]);
    expect(store.commercialAccess).toHaveBeenCalledTimes(1);
  });

  it("Microsoft push and lifecycle of an unpaid organization are ignored (no sync, no resubscription)", async () => {
    const microsoft = makeAccount({ id: "ms", provider: "MICROSOFT", organizationId: OTHER_ORG, providerMetadata: { subscriptionId: "11111111-2222-4333-8444-555555555555" } });
    const { deps, enqueueSync, enqueueWatch, denied } = eventSetup([microsoft], accessByOrg());
    const subscriptionId = "11111111-2222-4333-8444-555555555555";
    expect(await handleEmailEvent({ type: "MICROSOFT_NOTIFICATION", subscriptionId, resource: "r", messageId: "m" }, deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(await handleEmailEvent({ type: "MICROSOFT_LIFECYCLE", subscriptionId, lifecycleEvent: "subscriptionRemoved" }, deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(enqueueSync).not.toHaveBeenCalled();
    expect(enqueueWatch).not.toHaveBeenCalled();
    expect(denied().map((line) => line.jobType)).toEqual(["MICROSOFT_NOTIFICATION", "MICROSOFT_LIFECYCLE"]);
  });
});

describe("push subscriptions (watches): not created or renewed without access, never removed", () => {
  it("WATCH_ACCOUNT of an unpaid organization does not call the provider", async () => {
    const { deps, adapter, store } = eventSetup([unpaid], accessByOrg());
    expect(await handleEmailEvent({ type: "WATCH_ACCOUNT", emailAccountId: "unpaid", organizationId: OTHER_ORG }, deps)).toEqual({ accounts: 1, enqueued: 0 });
    expect(adapter.watch).not.toHaveBeenCalled();
    expect(store.saveWatchState).not.toHaveBeenCalled();
  });

  it("RENEW_WATCHES only queues paying organizations' accounts", async () => {
    const { deps, enqueueWatch } = eventSetup([paying, unpaid], accessByOrg());
    expect(await handleEmailEvent({ type: "RENEW_WATCHES" }, deps)).toEqual({ accounts: 1, enqueued: 1 });
    expect(enqueueWatch.mock.calls.map(([account]) => account.id)).toEqual(["paying"]);
  });
});

describe("recovery of incomplete emails", () => {
  it("emails of unpaid organizations are left as they are (no job, no attempt consumed)", async () => {
    const { deps, emails, producer } = eventSetup([paying, unpaid], accessByOrg());
    const incomplete = (id: string, organizationId: string) => ({
      id,
      organizationId,
      emailAccountId: organizationId === ORG ? "paying" : "unpaid",
      provider: "GMAIL" as const,
      providerMessageId: `msg-${id}`,
      processingAttempts: 1
    });
    emails.listIncompleteEmails.mockResolvedValue([incomplete("e-paid", ORG), incomplete("e-unpaid", OTHER_ORG)]);
    expect(await handleEmailEvent({ type: "RECOVER_INCOMPLETE" }, deps)).toEqual({ accounts: 1, enqueued: 1 });
    expect(producer.enqueueProcessing).toHaveBeenCalledTimes(1);
    expect(emails.updateProcessingState).not.toHaveBeenCalled();
  });
});

describe("scheduled expiration (EXPIRE_SUBSCRIPTIONS every 5 minutes)", () => {
  it("calls the database expiration and logs how many expired", async () => {
    const { deps, expireDue, lines } = eventSetup([], new Map());
    expect(await handleEmailEvent({ type: "EXPIRE_SUBSCRIPTIONS" }, deps)).toEqual({ accounts: 0, enqueued: 0, expired: 3 });
    expect(expireDue).toHaveBeenCalledTimes(1);
    expect(lines).toContainEqual({ event: "subscription.expired", count: 3 });
  });

  it("nothing due: no log line; without the maintenance port it is a no-op", async () => {
    const { deps, expireDue, lines } = eventSetup([], new Map());
    expireDue.mockResolvedValue(0);
    expect(await handleEmailEvent({ type: "EXPIRE_SUBSCRIPTIONS" }, deps)).toEqual({ accounts: 0, enqueued: 0, expired: 0 });
    expect(lines.filter((line) => line.event === "subscription.expired")).toEqual([]);
    const { subscriptions: _ignored, ...withoutPort } = deps;
    expect(await handleEmailEvent({ type: "EXPIRE_SUBSCRIPTIONS" }, withoutPort)).toEqual({ accounts: 0, enqueued: 0, expired: 0 });
  });
});

describe("rule notifications queued before the organization lost access", () => {
  it("are not delivered", async () => {
    const emails = new MemoryEmailStore();
    emails.settings = { ...emails.settings, notificationsEnabled: true };
    const realtime = makeRealtime();
    const job: NotificationJob = { organizationId: OTHER_ORG, emailId: "e1", ruleId: "r1", channel: "in_app", title: "t", body: "b" };
    const { logger } = recordingLogger();
    const accounts = makeAccountStore([], accessByOrg());
    expect(await deliverNotification(job, { emails, realtime, logger, accounts })).toBe("skipped_no_subscription");
    expect(realtime.publish).not.toHaveBeenCalled();
    expect(await deliverNotification({ ...job, organizationId: ORG }, { emails, realtime, logger, accounts })).toBe("delivered");
  });
});
