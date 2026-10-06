import { randomBytes } from "node:crypto";
import { addCoalescedSync, hashClientState, MICROSOFT_SUBSCRIPTION_LIFETIME_MS, type CoalescingQueue, type EmailEventJob } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import { ensureWatch, handleEmailEvent, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { ProviderHttpError } from "../providers/http.js";
import { createMicrosoftSubscriptionClient, type MicrosoftSubscriptionClient } from "../providers/microsoft/subscriptions.js";
import { ProviderAuthError, ProviderTransientError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRegistry, MemoryEmailStore, ORG, OTHER_ORG, silentLogger } from "./fakes.js";

/*
 * F9: Microsoft Graph change notifications. A notification (or a lifecycle
 * "missed") only TRIGGERS the account's coalesced, locked sync; the delta
 * cursor decides what is new. Subscriptions are created / renewed / recreated
 * by the WATCH_ACCOUNT job with the account's delegated token, each with its
 * own clientState (only its hash is stored). Polling stays as the safety net.
 */

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;
const SUB = "11111111-2222-4333-8444-555555555555";
const NEW_SUB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PUSH = { notificationUrl: "https://api.example.test/webhooks/microsoft", lifecycleNotificationUrl: "https://api.example.test/webhooks/microsoft/lifecycle" };
const at = (ms: number) => new Date(NOW + ms).toISOString();

function msAccount(overrides: Partial<WorkerAccount> = {}): WorkerAccount {
  return makeAccount({ id: "ms-1", provider: "MICROSOFT", emailAddress: "box@contoso.test", refreshTokenEncrypted: "enc-refresh", accessTokenEncrypted: "enc-access", ...overrides });
}

function fakeClient(overrides: Partial<Record<keyof MicrosoftSubscriptionClient, ReturnType<typeof vi.fn>>> = {}) {
  return {
    create: vi.fn(async () => ({ id: NEW_SUB, expirationDateTime: at(70 * HOUR) })),
    renew: vi.fn(async () => ({ expirationDateTime: at(70 * HOUR) })),
    remove: vi.fn(async () => "deleted" as const),
    ...overrides
  };
}

function setup(accounts: WorkerAccount[] = [msAccount()], client = fakeClient(), push: HandleEventDeps["microsoftPush"] = PUSH) {
  const store = makeAccountStore(accounts);
  const audit = makeAudit();
  const producer = makeProducer();
  const enqueueSync = vi.fn(async (_account: { id: string; organizationId: string }, _reason?: string) => undefined);
  const enqueueWatch = vi.fn(async (_account: { id: string; organizationId: string }) => undefined);
  const processMessage = vi.fn();
  const deps: HandleEventDeps = {
    accounts: store,
    emails: new MemoryEmailStore(),
    producer,
    providers: makeRegistry(makeAdapter()),
    createContext: (account) => ({ account, getAccessToken: async () => "access" }),
    enqueueSync,
    enqueueWatch,
    processMessage,
    audit,
    microsoftPush: push,
    microsoftSubscriptions: client as unknown as MicrosoftSubscriptionClient,
    now: () => NOW,
    logger: silentLogger
  };
  const mocks = store as unknown as Record<"saveSubscriptionState" | "saveWatchState", ReturnType<typeof vi.fn>>;
  return { deps, store: mocks, audit, producer, enqueueSync, enqueueWatch, processMessage, client, accounts };
}

describe("Graph subscriptions client (POST / PATCH / DELETE /subscriptions)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const context = (): ProviderContext & { getAccessToken: ReturnType<typeof vi.fn> } => ({ account: msAccount(), getAccessToken: vi.fn(async () => "delegated-token") });

  it("1. create: inbox messages, changeType created, configured URLs, clientState; delegated bearer token", async () => {
    const fetchImpl = vi.fn(async () => json({ id: SUB, expirationDateTime: "2026-10-09T10:00:00Z", resource: "me/mailFolders('inbox')/messages" }, 201));
    const ctx = context();
    const result = await createMicrosoftSubscriptionClient(fetchImpl as unknown as typeof fetch).create(ctx, {
      ...PUSH,
      clientState: "per-subscription-secret",
      expirationDateTime: at(70 * HOUR)
    });
    expect(result).toEqual({ id: SUB, expirationDateTime: "2026-10-09T10:00:00.000Z" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer delegated-token");
    expect(JSON.parse(init.body as string)).toEqual({
      changeType: "created",
      notificationUrl: PUSH.notificationUrl,
      lifecycleNotificationUrl: PUSH.lifecycleNotificationUrl,
      resource: "me/mailFolders('inbox')/messages",
      expirationDateTime: at(70 * HOUR),
      clientState: "per-subscription-secret"
    });
  });

  it("2. renew: PATCH /subscriptions/{id} with the new expiration", async () => {
    const fetchImpl = vi.fn(async () => json({ id: SUB, expirationDateTime: "2026-10-09T10:00:00Z" }));
    const result = await createMicrosoftSubscriptionClient(fetchImpl as unknown as typeof fetch).renew(context(), SUB, at(70 * HOUR));
    expect(result).toEqual({ expirationDateTime: "2026-10-09T10:00:00.000Z" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.microsoft.com/v1.0/subscriptions/${SUB}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ expirationDateTime: at(70 * HOUR) });
  });

  it("3. delete: 204 -> deleted; 14. 404 -> not_found (already gone, not an error)", async () => {
    const client = (status: number) => createMicrosoftSubscriptionClient(vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch);
    expect(await client(204).remove(context(), SUB)).toBe("deleted");
    expect(await client(404).remove(context(), SUB)).toBe("not_found");
    await expect(client(403).remove(context(), SUB)).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("renew 404 surfaces as ProviderHttpError(404); 401 refreshes once; 503 is transient; malformed ids are never sent", async () => {
    await expect(
      createMicrosoftSubscriptionClient(vi.fn(async () => json({}, 404)) as unknown as typeof fetch).renew(context(), SUB, at(HOUR))
    ).rejects.toMatchObject({ status: 404 });

    const ctx = context();
    const retried = vi.fn().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ expirationDateTime: "2026-10-09T10:00:00Z" }));
    await createMicrosoftSubscriptionClient(retried as unknown as typeof fetch).renew(ctx, SUB, at(HOUR));
    expect(ctx.getAccessToken.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);

    await expect(
      createMicrosoftSubscriptionClient(vi.fn(async () => json({}, 503)) as unknown as typeof fetch).create(ctx, { ...PUSH, clientState: "s", expirationDateTime: at(HOUR) })
    ).rejects.toBeInstanceOf(ProviderTransientError);

    const never = vi.fn();
    await expect(createMicrosoftSubscriptionClient(never as unknown as typeof fetch).renew(ctx, "../../me/messages", at(HOUR))).rejects.toThrow("Invalid Graph subscription id");
    expect(never).not.toHaveBeenCalled();
  });
});

describe("ensureWatch for Microsoft accounts (create / renew / recreate)", () => {
  it("creates a subscription with a fresh random clientState and stores only its hash", async () => {
    const { deps, client, accounts, audit } = setup();
    expect(await ensureWatch("ms-1", ORG, deps)).toBe(true);
    const input = client.create.mock.calls[0]?.[1] as { clientState: string; expirationDateTime: string; notificationUrl: string; lifecycleNotificationUrl: string };
    expect(input.notificationUrl).toBe(PUSH.notificationUrl);
    expect(input.lifecycleNotificationUrl).toBe(PUSH.lifecycleNotificationUrl);
    expect(input.expirationDateTime).toBe(at(MICROSOFT_SUBSCRIPTION_LIFETIME_MS));
    expect(input.clientState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = accounts[0]?.providerMetadata ?? {};
    expect(stored).toEqual({ subscriptionId: NEW_SUB, subscriptionClientStateHash: hashClientState(input.clientState) });
    expect(JSON.stringify(stored)).not.toContain(input.clientState);
    expect(accounts[0]?.watchExpiresAt).toBe(at(70 * HOUR));
    expect(audit.accountEntries).toEqual([expect.objectContaining({ event: "microsoft.subscription.created", action: "UPDATE" })]);
    expect(JSON.stringify(audit.accountEntries)).not.toContain(input.clientState);
  });

  it("each subscription gets its own clientState", async () => {
    const a = setup([msAccount({ id: "a" })]);
    const b = setup([msAccount({ id: "b" })]);
    await ensureWatch("a", ORG, a.deps);
    await ensureWatch("b", ORG, b.deps);
    expect((a.client.create.mock.calls[0]?.[1] as { clientState: string }).clientState).not.toBe((b.client.create.mock.calls[0]?.[1] as { clientState: string }).clientState);
  });

  it("a valid subscription is left alone; one expiring within 24 h is renewed (clientState kept)", async () => {
    const meta = { subscriptionId: SUB, subscriptionClientStateHash: hashClientState("old"), other: "kept" };
    const { deps, client, accounts, store } = setup([
      msAccount({ id: "valid", providerMetadata: { ...meta }, watchExpiresAt: at(40 * HOUR) }),
      msAccount({ id: "due", providerMetadata: { ...meta }, watchExpiresAt: at(5 * HOUR) })
    ]);
    expect(await ensureWatch("valid", ORG, deps)).toBe(false);
    expect(await ensureWatch("due", ORG, deps)).toBe(true);
    expect(client.renew).toHaveBeenCalledTimes(1);
    expect(client.renew).toHaveBeenCalledWith(expect.anything(), SUB, at(MICROSOFT_SUBSCRIPTION_LIFETIME_MS));
    expect(client.create).not.toHaveBeenCalled();
    expect(accounts[1]?.providerMetadata).toEqual(meta);
    expect(store.saveSubscriptionState).toHaveBeenCalledWith("due", expect.objectContaining({ expiresAt: at(70 * HOUR), renewedAt: at(0), errorCode: null }));
  });

  it("13. renewal 404 (gone at Graph): state cleared, a new subscription created and stored", async () => {
    const client = fakeClient({ renew: vi.fn(async () => Promise.reject(new ProviderHttpError("Provider returned HTTP 404", 404))) });
    const { deps, accounts, store } = setup([msAccount({ providerMetadata: { subscriptionId: SUB, subscriptionClientStateHash: hashClientState("old") }, watchExpiresAt: at(HOUR) })], client);
    expect(await ensureWatch("ms-1", ORG, deps)).toBe(true);
    expect(store.saveSubscriptionState.mock.calls[0]?.[1]).toMatchObject({ providerMetadata: {}, expiresAt: null, errorCode: "SUBSCRIPTION_NOT_FOUND" });
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(accounts[0]?.providerMetadata.subscriptionId).toBe(NEW_SUB);
    expect(accounts[0]?.providerMetadata.subscriptionClientStateHash).not.toBe(hashClientState("old"));
  });

  it("a rejected creation (e.g. 400, URL not reachable by Graph) is recorded without secrets and does not throw: polling continues", async () => {
    const client = fakeClient({ create: vi.fn(async () => Promise.reject(new ProviderHttpError("Provider returned HTTP 400", 400))) });
    const { deps, store, audit } = setup([msAccount()], client);
    expect(await ensureWatch("ms-1", ORG, deps)).toBe(false);
    expect(store.saveWatchState).toHaveBeenCalledWith("ms-1", expect.objectContaining({ errorCode: "HTTP_400" }));
    expect(audit.accountEntries).toEqual([expect.objectContaining({ event: "microsoft.subscription.failed", metadata: { errorCode: "HTTP_400" } })]);
  });

  it("credentials and transient failures are rethrown (account -> ERROR / BullMQ retry by the job runner)", async () => {
    for (const error of [new ProviderAuthError("revoked", "AUTH_REVOKED"), new ProviderTransientError("HTTP 503", 503)]) {
      const { deps } = setup([msAccount()], fakeClient({ create: vi.fn(async () => Promise.reject(error)) }));
      await expect(ensureWatch("ms-1", ORG, deps)).rejects.toBe(error);
    }
  });

  it("if the new subscription cannot be stored, it is removed at Graph (no orphan)", async () => {
    const { deps, client, store } = setup();
    store.saveSubscriptionState.mockRejectedValueOnce(new Error("db down"));
    await expect(ensureWatch("ms-1", ORG, deps)).resolves.toBe(false);
    expect(client.remove).toHaveBeenCalledWith(expect.anything(), NEW_SUB);
  });

  it("never subscribes: push not configured, inactive / disconnected / other-organization accounts, no credentials", async () => {
    const accounts = [
      msAccount({ id: "paused", status: "PAUSED" }),
      msAccount({ id: "error", status: "ERROR" }),
      msAccount({ id: "disconnected", status: "DISCONNECTED", refreshTokenEncrypted: null, accessTokenEncrypted: null }),
      msAccount({ id: "suspended", organizationStatus: "SUSPENDED" }),
      msAccount({ id: "no-credentials", refreshTokenEncrypted: null, accessTokenEncrypted: null }),
      msAccount({ id: "ok" })
    ];
    const { deps, client } = setup(accounts);
    for (const id of ["paused", "error", "disconnected", "suspended", "no-credentials"]) expect(await ensureWatch(id, ORG, deps)).toBe(false);
    expect(await ensureWatch("ok", OTHER_ORG, deps)).toBe(false);
    expect(await ensureWatch("ok", ORG, { ...deps, microsoftPush: null })).toBe(false);
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe("MICROSOFT_NOTIFICATION: a trigger only (like GMAIL_NOTIFICATION)", () => {
  const notification = (subscriptionId = SUB, messageId: string | null = "m1"): EmailEventJob => ({ type: "MICROSOFT_NOTIFICATION", subscriptionId, resource: "x", messageId });
  const subscribed = (overrides: Partial<WorkerAccount> = {}) => msAccount({ providerMetadata: { subscriptionId: SUB, subscriptionClientStateHash: hashClientState("s") }, ...overrides });

  it("15. enqueueSync(account, GRAPH); 16. processEmail is never called and nothing is queued for processing", async () => {
    const { deps, enqueueSync, processMessage, producer } = setup([subscribed()]);
    expect(await handleEmailEvent(notification(), deps)).toEqual({ accounts: 1, enqueued: 1 });
    expect(enqueueSync).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1", organizationId: ORG }), "GRAPH");
    expect(processMessage).not.toHaveBeenCalled();
    expect(producer.processing).toEqual([]);
  });

  it("unknown subscription, malformed id, inactive account or organization: nothing", async () => {
    const { deps, enqueueSync } = setup([subscribed({ id: "paused", status: "PAUSED" })]);
    expect(await handleEmailEvent(notification(NEW_SUB), deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(await handleEmailEvent(notification("not-a-guid"), deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(await handleEmailEvent(notification(), deps)).toEqual({ accounts: 0, enqueued: 0 });
    const suspended = setup([subscribed({ organizationStatus: "SUSPENDED" })]);
    expect(await handleEmailEvent(notification(), suspended.deps)).toEqual({ accounts: 0, enqueued: 0 });
    expect(enqueueSync).not.toHaveBeenCalled();
    expect(suspended.enqueueSync).not.toHaveBeenCalled();
  });

  it("9. duplicated notifications and a concurrent poll coalesce into ONE pending sync of the account", async () => {
    const jobs = new Map<string, { state: string }>();
    const queue: CoalescingQueue = {
      getJob: async (id) => (jobs.has(id) ? { getState: async () => jobs.get(id)?.state ?? "waiting", remove: async () => void jobs.delete(id) } : undefined),
      add: async (_name, _data, options) => {
        const id = String(options.jobId);
        if (!jobs.has(id)) jobs.set(id, { state: "waiting" });
      }
    };
    const { deps } = setup([subscribed()]);
    deps.enqueueSync = (account, reason) => addCoalescedSync(queue, account, reason ?? "MANUAL").then(() => undefined);
    for (const messageId of ["m1", "m1", "m2"]) await handleEmailEvent(notification(SUB, messageId), deps);
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect([...jobs.keys()]).toEqual(["sync-ms-1"]);
  });
});

describe("MICROSOFT_LIFECYCLE", () => {
  const lifecycle = (lifecycleEvent: "reauthorizationRequired" | "subscriptionRemoved" | "missed"): EmailEventJob => ({ type: "MICROSOFT_LIFECYCLE", subscriptionId: SUB, lifecycleEvent });
  const subscribed = () => msAccount({ providerMetadata: { subscriptionId: SUB, subscriptionClientStateHash: hashClientState("s") }, watchExpiresAt: at(50 * HOUR) });

  it("12. missed: only a sync (delta recovers the changes), no message is rebuilt", async () => {
    const { deps, enqueueSync, enqueueWatch, processMessage } = setup([subscribed()]);
    await handleEmailEvent(lifecycle("missed"), deps);
    expect(enqueueSync).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1" }), "GRAPH");
    expect(enqueueWatch).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("10. reauthorizationRequired: subscription marked due and the WATCH job queued, which then renews it", async () => {
    const { deps, enqueueWatch, accounts, client } = setup([subscribed()]);
    await handleEmailEvent(lifecycle("reauthorizationRequired"), deps);
    expect(accounts[0]?.watchExpiresAt).toBe(at(0));
    expect(enqueueWatch).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1" }));
    // The queued WATCH_ACCOUNT job:
    expect(await ensureWatch("ms-1", ORG, deps)).toBe(true);
    expect(client.renew).toHaveBeenCalledWith(expect.anything(), SUB, expect.any(String));
  });

  it("11. subscriptionRemoved: state cleared, a new subscription queued (the WATCH job creates it) and a sync for the gap", async () => {
    const { deps, enqueueWatch, enqueueSync, accounts, client } = setup([subscribed()]);
    await handleEmailEvent(lifecycle("subscriptionRemoved"), deps);
    expect(accounts[0]?.providerMetadata).toEqual({});
    expect(accounts[0]?.watchExpiresAt).toBeNull();
    expect(enqueueWatch).toHaveBeenCalledTimes(1);
    expect(enqueueSync).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1" }), "GRAPH");
    expect(await ensureWatch("ms-1", ORG, deps)).toBe(true);
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it("lifecycle events for unknown subscriptions or inactive accounts do nothing", async () => {
    const { deps, enqueueSync, enqueueWatch } = setup([msAccount({ status: "ERROR", providerMetadata: { subscriptionId: SUB } })]);
    for (const event of ["missed", "reauthorizationRequired", "subscriptionRemoved"] as const) {
      expect(await handleEmailEvent(lifecycle(event), deps)).toEqual({ accounts: 0, enqueued: 0 });
    }
    expect(enqueueSync).not.toHaveBeenCalled();
    expect(enqueueWatch).not.toHaveBeenCalled();
  });
});

describe("renewal scheduler (RENEW_WATCHES) and polling safety net", () => {
  it("RENEW_WATCHES queues due Microsoft subscriptions when Microsoft push is configured, Gmail ones when Gmail push is", async () => {
    const accounts = [
      msAccount({ id: "ms-due", watchExpiresAt: at(2 * HOUR) }),
      msAccount({ id: "ms-none" }),
      msAccount({ id: "ms-fresh", watchExpiresAt: at(60 * HOUR) }),
      makeAccount({ id: "gmail-due", watchExpiresAt: at(HOUR) })
    ];
    const { deps, enqueueWatch } = setup(accounts);
    expect(await handleEmailEvent({ type: "RENEW_WATCHES" }, deps)).toEqual({ accounts: 2, enqueued: 2 });
    expect(enqueueWatch.mock.calls.map(([account]) => account.id).sort()).toEqual(["ms-due", "ms-none"]);

    const both = setup(accounts);
    expect(await handleEmailEvent({ type: "RENEW_WATCHES" }, { ...both.deps, watchTopic: "projects/emailbot-test/topics/gmail-push" })).toEqual({ accounts: 3, enqueued: 3 });
    const none = setup(accounts);
    expect(await handleEmailEvent({ type: "RENEW_WATCHES" }, { ...none.deps, microsoftPush: null })).toEqual({ accounts: 0, enqueued: 0 });
  });

  it("POLL_ACCOUNTS still syncs Microsoft (and Gmail) accounts every cycle, with or without push", async () => {
    const accounts = [msAccount({ id: "ms" }), makeAccount({ id: "gmail" })];
    const { deps, enqueueSync } = setup(accounts);
    await handleEmailEvent({ type: "POLL_ACCOUNTS" }, deps);
    expect(enqueueSync.mock.calls.map(([account, reason]) => [account.id, reason])).toEqual([
      ["ms", "POLL"],
      ["gmail", "POLL"]
    ]);
  });

  it("the polling interval stays 5 minutes by default; the notification URL is optional and https only", () => {
    const base = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
    expect(loadWorkerConfig(base).pollIntervalMinutes).toBe(5);
    expect(loadWorkerConfig(base).microsoftPush).toBeNull();
    const microsoft = { MICROSOFT_CLIENT_ID: "id", MICROSOFT_CLIENT_SECRET: "secret", MICROSOFT_REDIRECT_URI: "http://localhost:3000/api/oauth/microsoft/callback" };
    expect(loadWorkerConfig({ ...base, ...microsoft, MICROSOFT_GRAPH_NOTIFICATION_URL: "https://hooks.example.test/webhooks/microsoft" }).microsoftPush).toEqual({
      notificationUrl: "https://hooks.example.test/webhooks/microsoft",
      lifecycleNotificationUrl: "https://hooks.example.test/webhooks/microsoft/lifecycle"
    });
    expect(() => loadWorkerConfig({ ...base, ...microsoft, MICROSOFT_GRAPH_NOTIFICATION_URL: "http://hooks.example.test/webhooks/microsoft" })).toThrow();
    expect(() => loadWorkerConfig({ ...base, MICROSOFT_GRAPH_NOTIFICATION_URL: "https://hooks.example.test/webhooks/microsoft" })).toThrow();
  });
});
