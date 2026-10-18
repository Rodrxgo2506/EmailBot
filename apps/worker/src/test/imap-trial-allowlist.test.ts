import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { IMAP_TRIAL_ORGANIZATION_IDS, type EmailProcessingJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import { handleEmailEvent, syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import type { ProviderContext, WorkerAccount } from "../providers/types.js";
import {
  makeAccount,
  makeAccountStore,
  makeAdapter,
  makeAudit,
  makeProducer,
  makeRealtime,
  makeRuleRow,
  MemoryEmailStore,
  MemoryRoutingStore,
  ORG,
  OTHER_ORG,
  silentLogger
} from "./fakes.js";

/*
 * IMAP trial allowlist (worker side). imapSyncEnabled stays FIXED to false in the worker config; when a reviewed
 * change turns it on, only IMAP accounts of the organizations in IMAP_TRIAL_ORGANIZATION_IDS (@emailbot/shared,
 * fixed in code, empty today) are polled, synchronized, processed or recovered. Gmail / Microsoft never look at it.
 * Here the switch and the list are injected into the dependencies, as index.ts does from the config.
 */

const imapAccount = (overrides: Partial<WorkerAccount> = {}) =>
  makeAccount({
    id: "imap-1",
    provider: "IMAP",
    emailAddress: "me@empresa-correo.com",
    syncCursor: "imap:v1:7:0",
    providerMetadata: { imap: { host: "imap.hostinger.com", port: 993, security: "TLS", username: "me@empresa-correo.com" } },
    accessTokenEncrypted: "v2.stored",
    ...overrides
  });

const context = (account: WorkerAccount): ProviderContext => ({
  account,
  getAccessToken: () => Promise.reject(new Error("not OAuth")),
  getImapCredentials: async () => ({ username: "me@empresa-correo.com", password: "app-password" })
});

function eventDeps(accounts: WorkerAccount[], extra: Partial<HandleEventDeps> = {}) {
  const imap = makeAdapter({ provider: "IMAP", listNewMessageIds: vi.fn(async () => ({ messageIds: [], nextCursor: "imap:v1:7:0" })) });
  const oauth = makeAdapter({ provider: "GMAIL", listNewMessageIds: vi.fn(async () => ({ messageIds: [], nextCursor: "100" })) });
  const createContext = vi.fn((account: WorkerAccount) => context(account));
  const lock = { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) };
  const deps: HandleEventDeps = {
    accounts: makeAccountStore(accounts),
    emails: new MemoryEmailStore(),
    producer: makeProducer(),
    providers: { GMAIL: oauth, MICROSOFT: oauth, IMAP: imap },
    createContext,
    enqueueSync: vi.fn(async () => undefined),
    processMessage: vi.fn(async () => ({ status: "processed" as const, emailId: "e", matchedRuleIds: [] })),
    lock,
    logger: silentLogger,
    ...extra
  };
  return { deps, imap, oauth, createContext, lock };
}

function processDeps(accounts: WorkerAccount[], extra: Partial<ProcessEmailDeps> = {}) {
  const imapFetch = vi.fn(async () => {
    throw new Error("fetch reached (test stops here)");
  });
  const oauthFetch = vi.fn(async () => {
    throw new Error("fetch reached (test stops here)");
  });
  const emails = new MemoryEmailStore();
  // An enabled rule, so processing goes as far as the fetch when it is allowed to.
  emails.rules = [makeRuleRow()];
  const deps: ProcessEmailDeps = {
    accounts: makeAccountStore(accounts),
    emails,
    routing: new MemoryRoutingStore(emails),
    audit: makeAudit(),
    storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
    realtime: makeRealtime(),
    producer: makeProducer(),
    providers: { GMAIL: makeAdapter({ fetchMessage: oauthFetch }), MICROSOFT: makeAdapter({ fetchMessage: oauthFetch }), IMAP: makeAdapter({ provider: "IMAP", fetchMessage: imapFetch }) },
    createContext: (account) => context(account),
    attachmentsBucket: "email-attachments",
    maxAttachmentBytes: 1000,
    logger: silentLogger,
    ...extra
  };
  return { deps, imapFetch, oauthFetch, emails };
}

const on = (ids: readonly string[]) => ({ imapSyncEnabled: true, imapOrganizationIds: ids });

describe("worker config: the trial allowlist lives in code only", () => {
  const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };

  it("empty today and frozen; IMAP itself stays off", () => {
    expect(IMAP_TRIAL_ORGANIZATION_IDS).toEqual([]);
    const config = loadWorkerConfig(base);
    expect(config.imapSyncEnabled).toBe(false);
    expect(config.imapOrganizationIds).toEqual([]);
    expect(Object.isFrozen(config.imapOrganizationIds)).toBe(true);
  });

  it("no environment variable adds an organization or turns IMAP on", () => {
    for (const name of ["IMAP_TRIAL_ORGANIZATION_IDS", "IMAP_ORGANIZATION_IDS", "IMAP_ALLOWED_ORGANIZATIONS", "WORKER_IMAP_ORGANIZATION_IDS", "IMAP_SYNC_ENABLED"]) {
      const config = loadWorkerConfig({ ...base, [name]: ORG });
      expect(config.imapOrganizationIds, name).toEqual([]);
      expect(config.imapSyncEnabled, name).toBe(false);
    }
  });

  it("index.ts gives the configured allowlist to both the event and the processing dependencies", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source.match(/imapOrganizationIds: config\.imapOrganizationIds/g)).toHaveLength(2);
    expect(source).not.toMatch(/imapOrganizationIds:(?!\s*config\.imapOrganizationIds\b)/);
  });
});

describe("syncAccount", () => {
  it("allowed organization with IMAP on: the IMAP account is synchronized", async () => {
    const account = imapAccount();
    const { deps, imap, createContext } = eventDeps([account], on([ORG]));
    await syncAccount(account, deps, "MANUAL");
    expect(imap.listNewMessageIds).toHaveBeenCalledTimes(1);
    expect(createContext).toHaveBeenCalled();
  });

  it("another organization: skipped before the lock, the credentials and the adapter; cursor unchanged", async () => {
    const account = imapAccount({ organizationId: OTHER_ORG });
    const { deps, imap, createContext, lock } = eventDeps([account], on([ORG]));
    expect(await syncAccount(account, deps, "MANUAL")).toMatchObject({ found: 0, processed: 0, cursorAdvanced: false });
    expect(imap.listNewMessageIds).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(deps.accounts.advanceSyncCursor).not.toHaveBeenCalled();
  });

  it("empty or missing allowlist, IMAP on: nobody is synchronized (fail closed)", async () => {
    for (const extra of [on([]), { imapSyncEnabled: true }]) {
      const account = imapAccount();
      const { deps, imap } = eventDeps([account], extra);
      await syncAccount(account, deps, "POLL");
      expect(imap.listNewMessageIds).not.toHaveBeenCalled();
    }
  });

  it("listed organization but IMAP off (the production switch): not synchronized", async () => {
    for (const extra of [{ imapSyncEnabled: false, imapOrganizationIds: [ORG] }, { imapOrganizationIds: [ORG] }]) {
      const account = imapAccount();
      const { deps, imap } = eventDeps([account], extra);
      await syncAccount(account, deps, "POLL");
      expect(imap.listNewMessageIds).not.toHaveBeenCalled();
    }
  });

  it("a queued SYNC_ACCOUNT job for another organization's IMAP account does nothing", async () => {
    const account = imapAccount({ organizationId: OTHER_ORG });
    const { deps, imap } = eventDeps([account], on([ORG]));
    await handleEmailEvent({ type: "SYNC_ACCOUNT", emailAccountId: account.id, organizationId: OTHER_ORG, requestedBy: null }, deps);
    expect(imap.listNewMessageIds).not.toHaveBeenCalled();
  });

  it("a SYNC_ACCOUNT job for an account that does not exist reaches no adapter", async () => {
    const { deps, imap, oauth } = eventDeps([], on([ORG]));
    await handleEmailEvent({ type: "SYNC_ACCOUNT", emailAccountId: "missing", organizationId: ORG, requestedBy: null }, deps).catch(() => undefined);
    expect(imap.listNewMessageIds).not.toHaveBeenCalled();
    expect(oauth.listNewMessageIds).not.toHaveBeenCalled();
  });

  it("Gmail and Microsoft ignore the allowlist (any organization, IMAP on or off)", async () => {
    for (const extra of [on([ORG]), on([]), {}]) {
      for (const provider of ["GMAIL", "MICROSOFT"] as const) {
        const account = makeAccount({ provider, organizationId: OTHER_ORG });
        const { deps, oauth } = eventDeps([account], extra);
        await syncAccount(account, deps, "MANUAL");
        expect(oauth.listNewMessageIds, provider).toHaveBeenCalledTimes(1);
      }
    }
  });
});

describe("POLL_ACCOUNTS", () => {
  function polling(extra: Partial<HandleEventDeps>) {
    const { deps } = eventDeps([], extra);
    const listActiveImapAccounts = vi.fn(async () => [
      { id: "imap-allowed", organizationId: ORG },
      { id: "imap-other", organizationId: OTHER_ORG }
    ]);
    const listActiveOAuthAccounts = vi.fn(async () => [{ id: "gmail-other", organizationId: OTHER_ORG }]);
    deps.accounts = { ...deps.accounts, listActiveImapAccounts, listActiveOAuthAccounts };
    return deps;
  }
  const enqueued = (deps: HandleEventDeps) => (deps.enqueueSync as ReturnType<typeof vi.fn>).mock.calls.map(([account]) => (account as { id: string }).id).sort();

  it("only the listed organization's IMAP accounts are queued; OAuth accounts as before", async () => {
    const deps = polling(on([ORG]));
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(enqueued(deps)).toEqual(["gmail-other", "imap-allowed"]);
  });

  it("empty allowlist: no IMAP account is queued", async () => {
    const deps = polling(on([]));
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(enqueued(deps)).toEqual(["gmail-other"]);
  });
});

describe("processEmail", () => {
  const job = (account: WorkerAccount, overrides: Partial<EmailProcessingJob> = {}): EmailProcessingJob => ({
    organizationId: account.organizationId,
    emailAccountId: account.id,
    provider: account.provider,
    providerMessageId: "7:1",
    ...overrides
  });

  it("another organization's IMAP mail: skipped, nothing fetched or stored", async () => {
    const account = imapAccount({ organizationId: OTHER_ORG });
    const { deps, imapFetch, emails } = processDeps([account], on([ORG]));
    expect(await processEmail(job(account), deps)).toEqual({ status: "skipped", reason: "imap_disabled" });
    expect(imapFetch).not.toHaveBeenCalled();
    expect(emails.rows).toHaveLength(0);
  });

  it("empty allowlist with IMAP on: skipped", async () => {
    const account = imapAccount();
    const { deps, imapFetch } = processDeps([account], on([]));
    expect(await processEmail(job(account), deps)).toEqual({ status: "skipped", reason: "imap_disabled" });
    expect(imapFetch).not.toHaveBeenCalled();
  });

  it("the listed organization's IMAP mail goes on to the fetch", async () => {
    const account = imapAccount();
    const { deps, imapFetch } = processDeps([account], on([ORG]));
    await processEmail(job(account), deps).catch(() => undefined);
    expect(imapFetch).toHaveBeenCalled();
  });

  it("an account that does not exist, or a job claiming another organization: skipped before any fetch", async () => {
    const account = imapAccount();
    const { deps, imapFetch } = processDeps([account], on([ORG]));
    expect(await processEmail(job(account, { emailAccountId: "missing" }), deps)).toEqual({ status: "skipped", reason: "account_not_found" });
    expect(await processEmail(job(account, { organizationId: OTHER_ORG }), deps)).toEqual({ status: "skipped", reason: "account_not_found" });
    expect(imapFetch).not.toHaveBeenCalled();
  });

  it("Gmail mail of an unlisted organization is processed as before", async () => {
    const account = makeAccount({ organizationId: OTHER_ORG });
    const { deps, oauthFetch } = processDeps([account], on([ORG]));
    await processEmail(job(account, { providerMessageId: "m1" }), deps).catch(() => undefined);
    expect(oauthFetch).toHaveBeenCalled();
  });
});

describe("RECOVER_INCOMPLETE", () => {
  function seed() {
    const emails = new MemoryEmailStore();
    let n = 0;
    for (const [organization, account] of [
      [ORG, "imap-allowed"],
      [OTHER_ORG, "imap-other"]
    ] as const) {
      emails.accountProviders.set(account, "IMAP");
      for (let i = 0; i < 3; i++)
        emails.rows.push({
          organization_id: organization,
          email_account_id: account,
          provider_message_id: `${account}:${i}`,
          processing_status: "PROCESSING",
          processing_attempts: 1,
          processing_started_at: new Date(Date.UTC(2026, 0, 1) + (n += 1) * 1000).toISOString()
        } as never);
    }
    return emails;
  }

  it("only the listed organization's incomplete IMAP mail is recovered; the other is not even looked up", async () => {
    const emails = seed();
    const { deps } = eventDeps([], { ...on([ORG]), emails });
    await handleEmailEvent({ type: "RECOVER_INCOMPLETE" }, deps);
    const jobs = (deps.producer.enqueueProcessing as ReturnType<typeof vi.fn>).mock.calls.map(([job]) => job as EmailProcessingJob);
    expect(jobs.length).toBeGreaterThan(0);
    expect(new Set(jobs.map((job) => job.organizationId))).toEqual(new Set([ORG]));
    for (const [ids] of (deps.accounts.commercialAccess as ReturnType<typeof vi.fn>).mock.calls as Array<[string[]]>) expect(ids).not.toContain(OTHER_ORG);
    for (const [id] of (deps.accounts.imapEntitled as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>) expect(id).not.toBe(OTHER_ORG);
  });

  it("empty allowlist: no IMAP mail is recovered", async () => {
    const emails = seed();
    const { deps } = eventDeps([], { ...on([]), emails });
    await handleEmailEvent({ type: "RECOVER_INCOMPLETE" }, deps);
    const jobs = (deps.producer.enqueueProcessing as ReturnType<typeof vi.fn>).mock.calls.map(([job]) => job as EmailProcessingJob);
    expect(jobs.filter((job) => job.provider === "IMAP")).toHaveLength(0);
  });
});
