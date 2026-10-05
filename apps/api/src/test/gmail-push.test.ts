import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createOAuthState } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleOidcVerifier, GOOGLE_CERTS_URL } from "../lib/google-oidc.js";
import { generateSessionToken, hashSessionToken } from "../lib/customer-access.js";
import { PORTAL_SESSION_COOKIE } from "../modules/portal/session.js";
import type { PortalSessionContext } from "../repositories/types.js";
import { createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/*
 * EmailBot V2 phase 5.6: Gmail Pub/Sub push webhook (OIDC), portal manual
 * sync and the Gmail watch queued after OAuth.
 */

const AUDIENCE = "https://api.emailbot.test/webhooks/gmail";
const PUSH_ACCOUNT = "pubsub-push@emailbot-test.iam.gserviceaccount.com";
const KID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwt(claims: Record<string, unknown>, options: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), options.key ?? privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const now = () => Math.floor(Date.now() / 1000);
const validClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: AUDIENCE,
  email: PUSH_ACCOUNT,
  email_verified: true,
  iat: now(),
  exp: now() + 3600,
  ...overrides
});

const certsResponse = () =>
  new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" }
  });

const pubsub = (data: unknown, messageId = "pubsub-1") => ({
  message: { data: Buffer.from(JSON.stringify(data)).toString("base64"), messageId },
  subscription: "projects/emailbot-test/subscriptions/gmail-push"
});

async function pushApp(options: { token?: string | null; oidc?: boolean } = {}) {
  const fetch = vi.fn(async (url: string) => (url === GOOGLE_CERTS_URL ? certsResponse() : new Response("{}", { status: 500 })));
  const context = await createTestApp({
    fetch: fetch as unknown as typeof globalThis.fetch,
    config: {
      gmailPubSubVerificationToken: options.token ?? null,
      gmailPubSubOidc: options.oidc === false ? null : { audience: AUDIENCE, serviceAccount: PUSH_ACCOUNT }
    }
  });
  const push = (body: unknown, headers: Record<string, string> = {}, url = "/webhooks/gmail") =>
    context.app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: body as object });
  return { ...context, fetch, push };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

afterEach(() => {
  vi.useRealTimers();
});

describe("Gmail Pub/Sub push webhook", () => {
  it("valid OIDC push: one deduplicated job, 204, nothing fetched from Gmail", async () => {
    const { push, queue, fetch, privileged } = await pushApp();
    const response = await push(pubsub({ emailAddress: "Me@Gmail.com", historyId: 987 }), bearer(jwt(validClaims())));
    expect(response.statusCode).toBe(204);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledWith(
      { type: "GMAIL_NOTIFICATION", emailAddress: "me@gmail.com", historyId: "987" },
      { jobId: expect.stringMatching(/^gmail-[0-9a-f]{24}-987$/) }
    );
    expect(privileged.hasActiveMailbox).toHaveBeenCalledWith("GMAIL", "me@gmail.com");
    // Only Google's public keys were fetched: no Gmail API call inside the request.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([GOOGLE_CERTS_URL]);
  });

  it.each([
    ["no Authorization header", undefined],
    ["another audience", jwt(validClaims({ aud: "https://evil.example/webhooks/gmail" }))],
    ["another service account", jwt(validClaims({ email: "attacker@evil.iam.gserviceaccount.com" }))],
    ["unverified email", jwt(validClaims({ email_verified: false }))],
    ["expired token", jwt(validClaims({ exp: now() - 3600, iat: now() - 7200 }))],
    ["another issuer", jwt(validClaims({ iss: "https://evil.example" }))],
    ["signed with another key", jwt(validClaims(), { key: other.privateKey })],
    ["unknown key id", jwt(validClaims(), { kid: "unknown" })],
    ["alg none", jwt(validClaims(), { alg: "none" })],
    ["garbage", "not.a.jwt"]
  ])("rejects a push with %s (401, nothing queued)", async (_label, token) => {
    const { push, queue } = await pushApp();
    const response = await push(pubsub({ emailAddress: "me@gmail.com", historyId: 1 }), token ? bearer(token) : {});
    expect(response.statusCode).toBe(401);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("malformed envelopes and missing fields are acknowledged (204) without a job", async () => {
    const { push, queue } = await pushApp();
    const auth = bearer(jwt(validClaims()));
    for (const body of [{ nope: true }, { message: { data: "%%%not-base64-json" } }, pubsub({ emailAddress: "me@gmail.com" }), pubsub({ historyId: 5 })]) {
      expect((await push(body, auth)).statusCode).toBe(204);
    }
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("pushes for unknown mailboxes are acknowledged and ignored", async () => {
    const { push, queue, privileged } = await pushApp();
    privileged.hasActiveMailbox.mockResolvedValue(false);
    expect((await push(pubsub({ emailAddress: "stranger@gmail.com", historyId: 9 }), bearer(jwt(validClaims())))).statusCode).toBe(204);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("duplicates (redelivery) map to the same job id; rapid distinct events to distinct ids", async () => {
    const { push, queue } = await pushApp();
    const auth = bearer(jwt(validClaims()));
    for (const historyId of [200, 200, 205]) await push(pubsub({ emailAddress: "me@gmail.com", historyId }), auth);
    const ids = queue.enqueueEmailEvent.mock.calls.map(([, options]) => (options as { jobId: string }).jobId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("queue failure: 503 so Pub/Sub redelivers", async () => {
    const { push, queue } = await pushApp();
    queue.enqueueEmailEvent.mockRejectedValueOnce(new Error("redis down"));
    expect((await push(pubsub({ emailAddress: "me@gmail.com", historyId: 1 }), bearer(jwt(validClaims())))).statusCode).toBe(503);
  });

  it("Google keys unavailable: 503 (never accepts an unverified push)", async () => {
    const { push, queue, fetch } = await pushApp();
    fetch.mockResolvedValue(new Response("down", { status: 503 }));
    expect((await push(pubsub({ emailAddress: "me@gmail.com", historyId: 1 }), bearer(jwt(validClaims())))).statusCode).toBe(503);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("Google's keys are cached (one fetch for many pushes)", async () => {
    const { push, fetch } = await pushApp();
    for (let index = 0; index < 5; index++) await push(pubsub({ emailAddress: "me@gmail.com", historyId: index }), bearer(jwt(validClaims())));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("with both mechanisms configured, both are required; without any, the route does not exist", async () => {
    const both = await pushApp({ token: "t".repeat(32) });
    const body = pubsub({ emailAddress: "me@gmail.com", historyId: 1 });
    expect((await both.push(body, bearer(jwt(validClaims())))).statusCode).toBe(401); // token missing
    expect((await both.push(body, {}, `/webhooks/gmail?token=${"t".repeat(32)}`)).statusCode).toBe(401); // OIDC missing
    expect((await both.push(body, bearer(jwt(validClaims())), `/webhooks/gmail?token=${"t".repeat(32)}`)).statusCode).toBe(204);
    const none = await pushApp({ oidc: false });
    expect((await none.push(body, bearer(jwt(validClaims())))).statusCode).toBe(404);
  });

  it("the verifier rejects tokens outside the clock skew and accepts a list audience", async () => {
    const fetch = vi.fn(async () => certsResponse());
    const verifier = createGoogleOidcVerifier({ fetch: fetch as unknown as typeof globalThis.fetch });
    const expected = { audience: AUDIENCE, email: PUSH_ACCOUNT };
    expect(await verifier.verify(jwt(validClaims({ aud: [AUDIENCE, "other"] })), expected)).toBe(true);
    expect(await verifier.verify(jwt(validClaims({ iat: now() + 3600 })), expected)).toBe(false);
    expect(await verifier.verify("x".repeat(5000), expected)).toBe(false);
  });
});

describe("portal manual sync", () => {
  const ACCOUNT_A1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const ACCOUNT_A2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
  const ACCOUNT_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
  const CUSTOMER_A = "cccccccc-0000-4000-8000-0000000000a1";
  const CUSTOMER_B = "cccccccc-0000-4000-8000-0000000000b1";

  async function syncApp() {
    const context = await createTestApp();
    const sessions = new Map<string, { customerId: string; organizationId: string }>();
    const cookieFor = (customerId: string, organizationId: string) => {
      const token = generateSessionToken();
      sessions.set(hashSessionToken(token), { customerId, organizationId });
      return `${PORTAL_SESSION_COOKIE}=${token}`;
    };
    context.privileged.validatePortalSession.mockImplementation(async (tokenHash: string): Promise<PortalSessionContext | null> => {
      const session = sessions.get(tokenHash);
      return session
        ? {
            sessionId: randomUUID(),
            ...session,
            profile: { customer: { displayName: "x", status: "ACTIVE" }, organization: { name: "o" }, bots: [], session: { idleExpiresAt: "", absoluteExpiresAt: "" } }
          }
        : null;
    });
    // portal.sync_scope: derived from the session only.
    context.privileged.portalSyncScope.mockImplementation(async (tokenHash: string) => {
      const session = sessions.get(tokenHash);
      if (session?.organizationId === ORG_A && session.customerId === CUSTOMER_A) {
        return [
          { emailAccountId: ACCOUNT_A1, organizationId: ORG_A, lastSyncedAt: "2026-10-05T11:59:00.000Z" },
          { emailAccountId: ACCOUNT_A2, organizationId: ORG_A, lastSyncedAt: "2026-10-05T11:58:00.000Z" }
        ];
      }
      if (session?.organizationId === ORG_B) return [{ emailAccountId: ACCOUNT_B, organizationId: ORG_B, lastSyncedAt: null }];
      return [];
    });
    const post = (cookie: string | null, body: unknown = undefined, headers: Record<string, string> = {}) =>
      context.app.inject({
        method: "POST",
        url: "/api/portal/sync",
        headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { payload: body as object } : {})
      });
    const status = (cookie: string) => context.app.inject({ method: "GET", url: "/api/portal/sync", headers: { cookie } });
    return { ...context, cookieFor, post, status };
  }

  it("queues a coalesced sync of every account in the session's scope and answers fast, without ids", async () => {
    const { post, cookieFor, queue, privileged } = await syncApp();
    const response = await post(cookieFor(CUSTOMER_A, ORG_A));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "QUEUED", lastSyncAt: "2026-10-05T11:59:00.000Z" });
    expect(queue.requestAccountSync.mock.calls).toEqual([
      [{ id: ACCOUNT_A1, organizationId: ORG_A }, "PORTAL"],
      [{ id: ACCOUNT_A2, organizationId: ORG_A }, "PORTAL"]
    ]);
    expect(response.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, entityId: CUSTOMER_A, metadata: { event: "gmail.manual_sync.requested", accounts: 2, queued: 2, status: "QUEUED" } })
    );
  });

  it("requires a portal session", async () => {
    const { post, queue } = await syncApp();
    expect((await post(null)).statusCode).toBe(401);
    expect((await post(`${PORTAL_SESSION_COOKIE}=${generateSessionToken()}`)).statusCode).toBe(401);
    expect(queue.requestAccountSync).not.toHaveBeenCalled();
  });

  it.each([
    ["customerId", { customerId: CUSTOMER_B }],
    ["organizationId", { organizationId: ORG_B }],
    ["botId", { botId: randomUUID() }],
    ["emailAccountId", { emailAccountId: ACCOUNT_B }]
  ])("a %s in the body has no authority (the scope comes from the session)", async (_label, body) => {
    const { post, cookieFor, queue } = await syncApp();
    await post(cookieFor(CUSTOMER_A, ORG_A), body, { "x-organization-id": ORG_B });
    expect(queue.requestAccountSync.mock.calls.map(([account]) => (account as { id: string }).id)).toEqual([ACCOUNT_A1, ACCOUNT_A2]);
  });

  it("cross-tenant: a session of B only ever syncs B's mailbox", async () => {
    const { post, cookieFor, queue } = await syncApp();
    await post(cookieFor(CUSTOMER_B, ORG_B), { emailAccountId: ACCOUNT_A1, organizationId: ORG_A });
    expect(queue.requestAccountSync.mock.calls).toEqual([[{ id: ACCOUNT_B, organizationId: ORG_B }, "PORTAL"]]);
  });

  it("one manual sync per customer every 30 s (429 + Retry-After); allowed again afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { post, cookieFor, queue } = await syncApp();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    expect((await post(cookie)).statusCode).toBe(202);
    const limited = await post(cookie);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another customer is not affected.
    expect((await post(cookieFor(CUSTOMER_B, ORG_B))).statusCode).toBe(202);
    vi.setSystemTime(Date.now() + 31_000);
    expect((await post(cookie)).statusCode).toBe(202);
    expect(queue.requestAccountSync).toHaveBeenCalledTimes(5);
  });

  it("ALREADY_RUNNING when every account already has a pending sync; NOTHING_TO_SYNC without scope", async () => {
    const { post, cookieFor, queue } = await syncApp();
    queue.requestAccountSync.mockResolvedValue("ALREADY_QUEUED");
    expect((await post(cookieFor(CUSTOMER_A, ORG_A))).json()).toMatchObject({ status: "ALREADY_RUNNING" });
    const unassigned = await post(cookieFor("cccccccc-0000-4000-8000-0000000000ff", ORG_A));
    expect(unassigned.json()).toEqual({ status: "NOTHING_TO_SYNC", lastSyncAt: null });
  });

  it("status: running while a sync is pending, plus the real last sync time (no ids)", async () => {
    const { status, cookieFor, queue } = await syncApp();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    queue.isAccountSyncPending.mockImplementation(async (id: string) => id === ACCOUNT_A2);
    expect((await status(cookie)).json()).toEqual({ running: true, lastSyncAt: "2026-10-05T11:59:00.000Z" });
    queue.isAccountSyncPending.mockResolvedValue(false);
    expect((await status(cookie)).json()).toEqual({ running: false, lastSyncAt: "2026-10-05T11:59:00.000Z" });
  });

  it("CSRF: a foreign browser origin is refused", async () => {
    const { post, cookieFor, queue } = await syncApp();
    expect((await post(cookieFor(CUSTOMER_A, ORG_A), undefined, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect(queue.requestAccountSync).not.toHaveBeenCalled();
  });
});

describe("Gmail watch after OAuth", () => {
  it("connecting a Gmail mailbox queues WATCH_ACCOUNT (deduplicated by account)", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const fetch = vi.fn(async (url: string) =>
      url.includes("oauth2.googleapis.com/token")
        ? new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }), { status: 200 })
        : new Response(JSON.stringify({ emailAddress: "me@gmail.com", historyId: "555" }), { status: 200 })
    );
    const context = await createTestApp({
      users: [owner],
      fetch: fetch as unknown as typeof globalThis.fetch,
      config: { google: { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:3000/api/oauth/gmail/callback" } }
    });
    context.privileged.getMemberRole.mockResolvedValue("OWNER");
    context.privileged.upsertOAuthEmailAccount.mockResolvedValue({ account: { id: "acc-new", emailAddress: "me@gmail.com" }, created: true });
    const state = createOAuthState({ userId: owner.id, organizationId: ORG_A, provider: "GMAIL" }, context.deps.config.oauthStateSecret);

    const response = await context.app.inject({ method: "GET", url: `/api/oauth/gmail/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(response.headers.location).toContain("oauth=connected");
    expect(context.queue.enqueueEmailEvent).toHaveBeenCalledWith(
      { type: "WATCH_ACCOUNT", emailAccountId: "acc-new", organizationId: ORG_A },
      { jobId: "watch-acc-new" }
    );
    // The job payload never carries tokens.
    expect(JSON.stringify(context.queue.enqueueEmailEvent.mock.calls)).not.toMatch(/"at"|"rt"|secret/);
  });
});
