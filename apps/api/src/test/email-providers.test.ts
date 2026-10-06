import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiConfig, OAuthProviderConfig } from "../config/env.js";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";

/*
 * F8-A block B: which providers new accounts can be connected with comes from
 * the server configuration (B-1, Microsoft gating), and new IMAP accounts are
 * refused while IMAP synchronization does not exist (B-2).
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const viewer = makeUser({ [ORG_A]: "VIEWER" });
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";

const google: OAuthProviderConfig = { clientId: "google-client", clientSecret: "google-secret", redirectUri: "https://api.example.com/api/oauth/gmail/callback" };
const microsoft: OAuthProviderConfig = {
  clientId: "microsoft-client",
  clientSecret: "microsoft-secret",
  redirectUri: "https://api.example.com/api/oauth/microsoft/callback",
  tenant: "common"
};

const imapBody = {
  emailAddress: "buzon@empresa.test",
  host: "imap.empresa.test",
  port: 993,
  secure: true,
  username: "buzon@empresa.test",
  password: "contraseña-del-buzon"
};

const account = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: ACCOUNT_ID,
  organizationId: ORG_A,
  provider: "IMAP",
  status: "PAUSED",
  emailAddress: "historico@empresa.test",
  displayName: null,
  lastSyncedAt: null,
  lastErrorCode: "IMAP_SYNC_NOT_IMPLEMENTED",
  lastErrorMessage: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(config: Partial<ApiConfig> = {}) {
  ctx = await createTestApp({ users: [owner, viewer], config });
  return ctx;
}

const providers = async (user = owner) =>
  ctx!.app.inject({ method: "GET", url: "/api/email-accounts/providers", headers: authHeaders(user, ORG_A) });

describe("B-1: provider availability comes from the server configuration", () => {
  it("Microsoft NOT configured (production today): only Gmail is offered; IMAP never", async () => {
    await setup({ google });
    const response = await providers();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providers: { GMAIL: true, MICROSOFT: false, IMAP: false } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("Microsoft configured (future F9): offered just by configuring it", async () => {
    await setup({ google, microsoft });
    expect((await providers()).json()).toEqual({ providers: { GMAIL: true, MICROSOFT: true, IMAP: false } });
  });

  it("nothing configured: nothing offered", async () => {
    await setup();
    expect((await providers()).json()).toEqual({ providers: { GMAIL: false, MICROSOFT: false, IMAP: false } });
  });

  it("every member can read it (the connect buttons are hidden by role in the UI, not here); it needs a session", async () => {
    await setup({ google });
    expect((await providers(viewer)).statusCode).toBe(200);
    expect((await ctx!.app.inject({ method: "GET", url: "/api/email-accounts/providers" })).statusCode).toBe(401);
  });

  it("starting OAuth with Microsoft not configured is refused (503 PROVIDER_NOT_CONFIGURED); configured, it returns the consent URL", async () => {
    await setup({ google });
    const refused = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/oauth/microsoft/start", headers: authHeaders(owner, ORG_A) });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("PROVIDER_NOT_CONFIGURED");
    await ctx!.app.close();

    await setup({ google, microsoft });
    const started = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/oauth/microsoft/start", headers: authHeaders(owner, ORG_A) });
    expect(started.statusCode).toBe(200);
    expect(new URL(started.json().authorizationUrl).host).toBe("login.microsoftonline.com");
  });
});

describe("B-2: new IMAP accounts are refused while IMAP synchronization does not exist", () => {
  it("POST /email-accounts/imap -> 503 IMAP_NOT_AVAILABLE; nothing is stored or audited", async () => {
    const { privileged } = await setup({ google });
    const response = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(owner, ORG_A), payload: imapBody });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IMAP_NOT_AVAILABLE");
    expect(privileged.createImapEmailAccount).not.toHaveBeenCalled();
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
    expect(response.body).not.toContain(imapBody.password);
  });

  it("the password is never even parsed: an invalid body gets the same 503, not a validation error", async () => {
    const { privileged } = await setup();
    const response = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(owner, ORG_A), payload: { password: "x" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IMAP_NOT_AVAILABLE");
    expect(privileged.createImapEmailAccount).not.toHaveBeenCalled();
  });

  it("authentication and role still come first (401 / 403 before the 503)", async () => {
    await setup();
    expect((await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", payload: imapBody })).statusCode).toBe(401);
    const forbidden = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(viewer, ORG_A), payload: imapBody });
    expect(forbidden.statusCode).toBe(403);
  });

  it("when IMAP is enabled in code (future), the existing creation path still encrypts the password and creates the account PAUSED", async () => {
    const { privileged } = await setup({ imapAccountsEnabled: true });
    privileged.createImapEmailAccount.mockResolvedValue(account({ emailAddress: imapBody.emailAddress }));
    const response = await ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(owner, ORG_A), payload: imapBody });
    expect(response.statusCode).toBe(201);
    const stored = privileged.createImapEmailAccount.mock.calls[0]?.[0] as { passwordEncrypted: string };
    expect(stored.passwordEncrypted).not.toContain(imapBody.password);
    expect(ctx!.deps.secretBox.decrypt(stored.passwordEncrypted)).toBe(imapBody.password);
  });

  it("historical IMAP accounts keep working: listed, cannot be resumed, can be disconnected and deleted", async () => {
    const { repos, privileged } = await setup({ google });
    const headers = authHeaders(owner, ORG_A);

    repos.emailAccounts.list.mockResolvedValue([account()]);
    const list = await ctx!.app.inject({ method: "GET", url: "/api/email-accounts", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    repos.emailAccounts.get.mockResolvedValue(account());
    const resume = await ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${ACCOUNT_ID}`, headers, payload: { status: "ACTIVE" } });
    expect(resume.statusCode).toBe(409);
    expect(resume.json().error.code).toBe("IMAP_SYNC_NOT_IMPLEMENTED");

    privileged.disconnectEmailAccount.mockResolvedValue(account({ status: "DISCONNECTED" }));
    expect((await ctx!.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/disconnect`, headers })).statusCode).toBe(200);
    expect(privileged.disconnectEmailAccount).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);

    repos.emailAccounts.get.mockResolvedValue(account({ status: "DISCONNECTED" }));
    repos.attachments.listStoredObjects.mockResolvedValue([]);
    repos.emailAccounts.remove.mockResolvedValue(undefined);
    expect((await ctx!.app.inject({ method: "DELETE", url: `/api/email-accounts/${ACCOUNT_ID}`, headers })).statusCode).toBe(204);
    expect(repos.emailAccounts.remove).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);
  });
});
