import { createOAuthState, hashClientState } from "@emailbot/shared";
import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { ApiConfig } from "../config/env.js";
import { authHeaders, createTestApp, makeUser, MICROSOFT_OAUTH, ORG_A } from "./helpers.js";

/*
 * F9: Microsoft Graph change notifications at the API. The webhook only
 * answers the validation handshake, authenticates each notification against
 * its subscription's own clientState (SHA-256 stored, constant-time compare)
 * and enqueues one job; the worker then only syncs the account from its
 * delta cursor. Disconnecting a Microsoft account deletes its subscription
 * at Graph before the tokens are wiped.
 */

const SUB = "11111111-2222-4333-8444-555555555555";
const OTHER_SUB = "99999999-8888-4777-8666-555555555555";
const CLIENT_STATE = "per-subscription-client-state-value";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const owner = makeUser({ [ORG_A]: "OWNER" });

const subscription = (overrides: Record<string, unknown> = {}) => ({
  emailAccountId: ACCOUNT_ID,
  organizationId: ORG_A,
  accountStatus: "ACTIVE",
  organizationStatus: "ACTIVE",
  clientStateHash: hashClientState(CLIENT_STATE),
  ...overrides
});

const notification = (overrides: Record<string, unknown> = {}) => ({
  subscriptionId: SUB,
  clientState: CLIENT_STATE,
  changeType: "created",
  resource: `Users/u-1/Messages/m-1`,
  resourceData: { id: "m-1" },
  tenantId: "t-1",
  ...overrides
});

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(config: Partial<ApiConfig> = {}, fetchImpl?: typeof fetch) {
  ctx = await createTestApp({
    users: [owner],
    config: { microsoftGraphPushEnabled: true, microsoft: MICROSOFT_OAUTH, ...config },
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  });
  ctx.privileged.findMicrosoftSubscription.mockImplementation(async (id: string) => (id === SUB ? subscription() : null));
  return ctx;
}

const post = (url: string, payload?: object) => ctx!.app.inject(payload === undefined ? { method: "POST", url } : { method: "POST", url, payload });

describe("validation handshake (both endpoints)", () => {
  it.each(["/webhooks/microsoft", "/webhooks/microsoft/lifecycle"])("4. %s echoes validationToken as text/plain, nothing else happens", async (url) => {
    const { queue, privileged } = await setup();
    const token = "Validation: Token-123 &+/=";
    const response = await post(`${url}?validationToken=${encodeURIComponent(token)}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe(token);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(privileged.findMicrosoftSubscription).not.toHaveBeenCalled();
  });

  it("an oversized or empty validationToken is rejected, never truncated", async () => {
    await setup();
    expect((await post(`/webhooks/microsoft?validationToken=${"a".repeat(4097)}`)).statusCode).toBe(400);
    expect((await post("/webhooks/microsoft?validationToken=")).statusCode).toBe(400);
  });

  it("disabled (404) unless MICROSOFT_GRAPH_PUSH_ENABLED and the Microsoft OAuth client are configured", async () => {
    await setup({ microsoftGraphPushEnabled: false });
    expect((await post("/webhooks/microsoft?validationToken=abc")).statusCode).toBe(404);
    await ctx!.app.close();
    await setup({ microsoft: null });
    expect((await post("/webhooks/microsoft/lifecycle?validationToken=abc")).statusCode).toBe(404);
  });
});

describe("POST /webhooks/microsoft", () => {
  it("5. a valid notification enqueues MICROSOFT_NOTIFICATION (deterministic job id) and answers 202", async () => {
    const { queue } = await setup();
    const response = await post("/webhooks/microsoft", { value: [notification()] });
    expect(response.statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledTimes(1);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledWith(
      { type: "MICROSOFT_NOTIFICATION", subscriptionId: SUB, resource: "Users/u-1/Messages/m-1", messageId: "m-1" },
      { jobId: expect.stringMatching(/^graph-[0-9a-f]{24}$/) }
    );
    // The job never carries the clientState.
    expect(JSON.stringify(queue.enqueueEmailEvent.mock.calls)).not.toContain(CLIENT_STATE);
  });

  it("6. a wrong (or missing) clientState is ignored: nothing enqueued, still 202", async () => {
    const { queue } = await setup();
    const response = await post("/webhooks/microsoft", {
      value: [notification({ clientState: "forged-client-state" }), notification({ clientState: undefined }), notification({ clientState: CLIENT_STATE.toUpperCase() })]
    });
    expect(response.statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("another subscription's clientState does not authenticate this one (no shared secret)", async () => {
    const { queue, privileged } = await setup();
    privileged.findMicrosoftSubscription.mockImplementation(async (id: string) =>
      id === OTHER_SUB ? subscription({ clientStateHash: hashClientState("other-subscription-state") }) : id === SUB ? subscription() : null
    );
    await post("/webhooks/microsoft", { value: [notification({ subscriptionId: OTHER_SUB, clientState: CLIENT_STATE })] });
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("7. unknown or malformed subscription ids are ignored", async () => {
    const { queue } = await setup();
    await post("/webhooks/microsoft", { value: [notification({ subscriptionId: OTHER_SUB }), notification({ subscriptionId: "../../x" })] });
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("8. an inactive account or organization is ignored", async () => {
    for (const inactive of [{ accountStatus: "PAUSED" }, { accountStatus: "ERROR" }, { organizationStatus: "SUSPENDED" }]) {
      const { queue, privileged } = await setup();
      privileged.findMicrosoftSubscription.mockResolvedValue(subscription(inactive));
      expect((await post("/webhooks/microsoft", { value: [notification()] })).statusCode).toBe(202);
      expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
      await ctx!.app.close();
    }
    ctx = undefined;
  });

  it("9. a redelivered notification gets the same job id (deduplicated by BullMQ); another message a new one; one lookup per subscription", async () => {
    const { queue, privileged } = await setup();
    await post("/webhooks/microsoft", { value: [notification(), notification(), notification({ resourceData: { id: "m-2" }, resource: "Users/u-1/Messages/m-2" })] });
    const jobIds = queue.enqueueEmailEvent.mock.calls.map((call) => (call[1] as { jobId: string }).jobId);
    expect(jobIds[0]).toBe(jobIds[1]);
    expect(jobIds[2]).not.toBe(jobIds[0]);
    expect(privileged.findMicrosoftSubscription).toHaveBeenCalledTimes(1);
  });

  it("malformed bodies are acknowledged (202) without effect; a database failure answers 503 so Graph retries", async () => {
    const { queue, privileged } = await setup();
    expect((await post("/webhooks/microsoft", { nope: true })).statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    privileged.findMicrosoftSubscription.mockRejectedValue(new Error("db down"));
    expect((await post("/webhooks/microsoft", { value: [notification()] })).statusCode).toBe(503);
  });

  it("logs never contain the clientState, the resource path or the subscription id in clear", async () => {
    const lines: string[] = [];
    const context = await setup();
    const app = await buildApp(context.deps, { logger: { level: "debug", stream: { write: (line: string) => lines.push(line) } } });
    await app.inject({ method: "POST", url: "/webhooks/microsoft", payload: { value: [notification(), notification({ clientState: "forged-client-state" })] } });
    await app.close();
    const output = lines.join("\n");
    expect(output).toContain("microsoft.graph.received");
    for (const secret of [CLIENT_STATE, "forged-client-state", "Users/u-1/Messages", SUB]) expect(output).not.toContain(secret);
  });
});

describe("POST /webhooks/microsoft/lifecycle", () => {
  it.each(["reauthorizationRequired", "subscriptionRemoved", "missed"] as const)("10-12. %s enqueues MICROSOFT_LIFECYCLE", async (lifecycleEvent) => {
    const { queue } = await setup();
    const response = await post("/webhooks/microsoft/lifecycle", {
      value: [{ subscriptionId: SUB, clientState: CLIENT_STATE, lifecycleEvent, subscriptionExpirationDateTime: "2026-10-08T00:00:00Z", tenantId: "t-1" }]
    });
    expect(response.statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledWith({ type: "MICROSOFT_LIFECYCLE", subscriptionId: SUB, lifecycleEvent });
  });

  it("unsupported events and a wrong clientState are ignored", async () => {
    const { queue } = await setup();
    await post("/webhooks/microsoft/lifecycle", {
      value: [
        { subscriptionId: SUB, clientState: CLIENT_STATE, lifecycleEvent: "somethingNew" },
        { subscriptionId: SUB, clientState: "forged", lifecycleEvent: "missed" }
      ]
    });
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });
});

describe("account connection and disconnection", () => {
  const msAccount = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
    id: ACCOUNT_ID,
    organizationId: ORG_A,
    provider: "MICROSOFT",
    status: "ACTIVE",
    emailAddress: "box@contoso.test",
    displayName: null,
    lastSyncedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  });

  it("connecting a Microsoft mailbox queues WATCH_ACCOUNT (the worker creates the subscription), without tokens in the job", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("login.microsoftonline.com")
        ? new Response(JSON.stringify({ access_token: "ms-at", refresh_token: "ms-rt", expires_in: 3600, token_type: "Bearer" }), { status: 200 })
        : new Response(JSON.stringify({ id: "u-1", mail: "box@contoso.test", displayName: "Box" }), { status: 200 })
    );
    const context = await setup({}, fetchImpl as unknown as typeof fetch);
    context.privileged.getMemberRole.mockResolvedValue("OWNER");
    context.privileged.connectOAuthEmailAccount.mockResolvedValue({ outcome: "CREATED", account: msAccount({ id: "acc-ms" }), created: true, previousStatus: null });
    const state = createOAuthState({ userId: owner.id, organizationId: ORG_A, provider: "MICROSOFT" }, context.deps.config.oauthStateSecret);
    const response = await context.app.inject({ method: "GET", url: `/api/oauth/microsoft/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(response.headers.location).toContain("oauth=connected");
    expect(context.queue.enqueueEmailEvent).toHaveBeenCalledWith({ type: "WATCH_ACCOUNT", emailAccountId: "acc-ms", organizationId: ORG_A }, { jobId: "watch-acc-ms" });
    expect(JSON.stringify(context.queue.enqueueEmailEvent.mock.calls)).not.toMatch(/ms-at|ms-rt|secret/);
  });

  it("disconnecting deletes the Graph subscription with the account's token BEFORE wiping the tokens, then clears it", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const context = await setup({}, fetchImpl as unknown as typeof fetch);
    const order: string[] = [];
    context.repos.emailAccounts.get.mockResolvedValue(msAccount());
    context.privileged.getMicrosoftSubscriptionCredentials.mockResolvedValue({
      subscriptionId: SUB,
      accessTokenEncrypted: context.deps.secretBox.encrypt("delegated-access"),
      refreshTokenEncrypted: context.deps.secretBox.encrypt("delegated-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    context.privileged.clearMicrosoftSubscription.mockImplementation(async () => void order.push("clear"));
    context.privileged.disconnectEmailAccount.mockImplementation(async () => {
      order.push("disconnect");
      return msAccount({ status: "DISCONNECTED" });
    });
    fetchImpl.mockImplementation(async () => {
      order.push("graph-delete");
      return new Response(null, { status: 204 });
    });

    const response = await context.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/disconnect`, headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["graph-delete", "clear", "disconnect"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.microsoft.com/v1.0/subscriptions/${SUB}`);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer delegated-access");
  });

  it("14. Graph 404 on DELETE (already gone) or a failure is not fatal: state cleared, account disconnected", async () => {
    for (const status of [404, 500]) {
      const context = await setup({}, vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch);
      context.repos.emailAccounts.get.mockResolvedValue(msAccount());
      context.privileged.getMicrosoftSubscriptionCredentials.mockResolvedValue({
        subscriptionId: SUB,
        accessTokenEncrypted: context.deps.secretBox.encrypt("delegated-access"),
        refreshTokenEncrypted: null,
        tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString()
      });
      context.privileged.clearMicrosoftSubscription.mockResolvedValue(undefined);
      context.privileged.disconnectEmailAccount.mockResolvedValue(msAccount({ status: "DISCONNECTED" }));
      const response = await context.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/disconnect`, headers: authHeaders(owner, ORG_A) });
      expect(response.statusCode).toBe(200);
      expect(context.privileged.clearMicrosoftSubscription).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);
      expect(context.privileged.disconnectEmailAccount).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);
      await context.app.close();
    }
    ctx = undefined;
  });

  it("an expired access token is refreshed (not persisted) before the DELETE", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("login.microsoftonline.com")
        ? new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600, token_type: "Bearer" }), { status: 200 })
        : new Response(null, { status: 204 })
    );
    const context = await setup({}, fetchImpl as unknown as typeof fetch);
    context.repos.emailAccounts.get.mockResolvedValue(msAccount());
    context.privileged.getMicrosoftSubscriptionCredentials.mockResolvedValue({
      subscriptionId: SUB,
      accessTokenEncrypted: context.deps.secretBox.encrypt("old-access"),
      refreshTokenEncrypted: context.deps.secretBox.encrypt("delegated-refresh"),
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString()
    });
    context.privileged.clearMicrosoftSubscription.mockResolvedValue(undefined);
    context.privileged.disconnectEmailAccount.mockResolvedValue(msAccount({ status: "DISCONNECTED" }));
    await context.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/disconnect`, headers: authHeaders(owner, ORG_A) });
    const graphCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("/subscriptions/")) as unknown as [string, RequestInit];
    expect((graphCall[1].headers as Record<string, string>).authorization).toBe("Bearer fresh-access");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("login.microsoftonline.com"))).toHaveLength(1);
  });

  it("Gmail accounts (and Microsoft accounts without a subscription) are disconnected exactly as before", async () => {
    const context = await setup();
    context.repos.emailAccounts.get.mockResolvedValue(msAccount({ provider: "GMAIL", emailAddress: "me@gmail.com" }));
    context.privileged.disconnectEmailAccount.mockResolvedValue(msAccount({ provider: "GMAIL", status: "DISCONNECTED" }));
    expect((await context.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/disconnect`, headers: authHeaders(owner, ORG_A) })).statusCode).toBe(200);
    expect(context.privileged.getMicrosoftSubscriptionCredentials).not.toHaveBeenCalled();

    context.repos.emailAccounts.get.mockResolvedValue(msAccount());
    context.privileged.getMicrosoftSubscriptionCredentials.mockResolvedValue({ subscriptionId: null, accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiresAt: null });
    expect((await context.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/disconnect`, headers: authHeaders(owner, ORG_A) })).statusCode).toBe(200);
    expect(context.privileged.clearMicrosoftSubscription).not.toHaveBeenCalled();
  });
});
