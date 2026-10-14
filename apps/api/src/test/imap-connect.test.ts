import { imapCredentialContext, type ImapResolver } from "@emailbot/shared";
import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";
import { entitlementsFor } from "./plan-fixtures.js";

/*
 * IMAP E1: POST /api/email-accounts/imap as it will behave once IMAP is
 * enabled. Production keeps imapAccountsEnabled = false (email-providers.test.ts
 * covers the 503); here the flag is turned on in the TEST configuration only.
 * DNS answers come from a fake resolver: no network.
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const admin = makeUser({ [ORG_A]: "ADMIN" });
const viewer = makeUser({ [ORG_A]: "VIEWER" });
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const PASSWORD = "contraseña-de-aplicacion-123";

const body = {
  emailAddress: "Ventas@Empresa-Correo.com",
  displayName: "Ventas",
  host: " IMAP.Hostinger.com ",
  port: 993,
  security: "TLS",
  username: "ventas@empresa-correo.com",
  password: PASSWORD
};

const account = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: ACCOUNT_ID,
  organizationId: ORG_A,
  provider: "IMAP",
  status: "PAUSED",
  emailAddress: "ventas@empresa-correo.com",
  displayName: "Ventas",
  lastSyncedAt: null,
  lastErrorCode: "IMAP_SYNC_NOT_IMPLEMENTED",
  lastErrorMessage: "IMAP synchronization is not available yet. Credentials were stored encrypted.",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides
});

const publicResolver = (): ImapResolver => vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(resolver: ImapResolver = publicResolver()) {
  ctx = await createTestApp({ users: [owner, admin, viewer], config: { imapAccountsEnabled: true }, imapResolver: resolver });
  return { ...ctx, resolver };
}

const post = (payload: unknown, user = owner) =>
  ctx!.app.inject({ method: "POST", url: "/api/email-accounts/imap", headers: authHeaders(user, ORG_A), payload: payload as object });

describe("IMAP connection (enabled in test configuration only)", () => {
  it("creates through the atomic RPC: normalized settings, v2 password bound to the mailbox, PAUSED, audited without secrets", async () => {
    const { privileged, resolver } = await setup();
    privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });

    const response = await post(body);
    expect(response.statusCode).toBe(201);
    expect(response.json().account).toMatchObject({ id: ACCOUNT_ID, provider: "IMAP", status: "PAUSED" });
    expect(resolver).toHaveBeenCalledWith("imap.hostinger.com");

    const input = privileged.connectImapEmailAccount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      organizationId: ORG_A,
      emailAddress: "Ventas@Empresa-Correo.com",
      displayName: "Ventas",
      username: "ventas@empresa-correo.com",
      host: "imap.hostinger.com",
      port: 993,
      security: "TLS",
      syncCursor: null
    });
    const encrypted = input.passwordEncrypted as string;
    expect(encrypted.startsWith("v2.")).toBe(true);
    expect(encrypted).not.toContain(PASSWORD);
    const box = ctx!.deps.secretBox;
    expect(box.decryptBound(encrypted, imapCredentialContext(ORG_A, "ventas@empresa-correo.com"))).toBe(PASSWORD);
    expect(() => box.decryptBound(encrypted, imapCredentialContext(ORG_A, "otra@empresa-correo.com"))).toThrow();
    expect(() => box.decrypt(encrypted)).toThrow();

    const audit = JSON.stringify(privileged.insertAuditLog.mock.calls);
    expect(audit).toContain('"provider":"IMAP"');
    expect(audit).toContain('"reconnected":false');
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain(encrypted);
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain("v2.");
  });

  it("a reconnection of the same mailbox answers 200 and is audited as such", async () => {
    const { privileged } = await setup();
    privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "RECONNECTED", account: account(), created: false, previousStatus: "ERROR" });
    const response = await post(body, admin);
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(privileged.insertAuditLog.mock.calls)).toContain('"reconnected":true');
  });

  it("STARTTLS on 143 is accepted", async () => {
    const { privileged } = await setup();
    privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });
    expect((await post({ ...body, port: 143, security: "STARTTLS" })).statusCode).toBe(201);
    expect(privileged.connectImapEmailAccount.mock.calls[0]?.[0]).toMatchObject({ port: 143, security: "STARTTLS" });
  });

  it("BASIC (no IMAP in the plan): 403 PLAN_FEATURE_UNAVAILABLE before any DNS query or write", async () => {
    const { repos, privileged, resolver } = await setup();
    repos.plans.entitlements.mockResolvedValue(entitlementsFor("BASIC"));
    const response = await post(body);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PLAN_FEATURE_UNAVAILABLE");
    expect(resolver).not.toHaveBeenCalled();
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it("PRO and BUSINESS pass the early plan check", async () => {
    for (const plan of ["PRO", "BUSINESS"] as const) {
      const { repos, privileged } = await setup();
      repos.plans.entitlements.mockResolvedValue(entitlementsFor(plan));
      privileged.connectImapEmailAccount.mockResolvedValue({ outcome: "CREATED", account: account(), created: true, previousStatus: null });
      expect((await post(body)).statusCode, plan).toBe(201);
      await ctx!.app.close();
      ctx = undefined;
    }
  });

  it("the database's answer wins: feature removed meanwhile, limit reached, mailbox already connected elsewhere", async () => {
    const { privileged } = await setup();
    privileged.connectImapEmailAccount.mockResolvedValueOnce({ outcome: "FEATURE_NOT_AVAILABLE" });
    const feature = await post(body);
    expect([feature.statusCode, feature.json().error.code]).toEqual([403, "PLAN_FEATURE_UNAVAILABLE"]);

    privileged.connectImapEmailAccount.mockResolvedValueOnce({ outcome: "PLAN_LIMIT_REACHED", used: 250, limit: 250 });
    const limit = await post(body);
    expect([limit.statusCode, limit.json().error.code]).toEqual([403, "PLAN_LIMIT_REACHED"]);

    privileged.connectImapEmailAccount.mockResolvedValueOnce({ outcome: "DUPLICATE_ACCOUNT" });
    const duplicate = await post(body);
    expect([duplicate.statusCode, duplicate.json().error.code]).toEqual([409, "EMAIL_ACCOUNT_ALREADY_CONNECTED"]);
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["a private address", [{ address: "10.0.0.7", family: 4 as const }], "IMAP_ADDRESS_FORBIDDEN"],
    ["the metadata service", [{ address: "169.254.169.254", family: 4 as const }], "IMAP_ADDRESS_FORBIDDEN"],
    ["one public and one loopback address", [{ address: "93.184.216.34", family: 4 as const }, { address: "::1", family: 6 as const }], "IMAP_ADDRESS_FORBIDDEN"],
    ["no address", [], "IMAP_DNS_NO_ADDRESSES"]
  ])("SSRF: a host resolving to %s is refused with 422 and nothing is stored", async (_label, answer, code) => {
    const { privileged } = await setup(vi.fn(async () => answer));
    const response = await post(body);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(code);
    expect(response.body).not.toMatch(/10\.0\.0\.7|169\.254|::1/);
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it("SSRF: a DNS failure is refused (fail closed)", async () => {
    const { privileged } = await setup(vi.fn(async () => Promise.reject(new Error("ENOTFOUND"))));
    const response = await post(body);
    expect([response.statusCode, response.json().error.code]).toEqual([422, "IMAP_DNS_FAILED"]);
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["plaintext (old boolean)", { secure: false }],
    ["a mismatched port", { port: 143 }],
    ["another port", { port: 110 }],
    ["no security mode", { security: undefined }],
    ["an IP literal", { host: "127.0.0.1" }],
    ["localhost", { host: "localhost" }],
    ["an internal name", { host: "mail.internal" }],
    ["disabling certificate validation", { rejectUnauthorized: false }]
  ])("invalid settings (%s): 400 before any DNS query or write", async (_label, change) => {
    const { privileged, resolver } = await setup();
    const response = await post({ ...body, ...change });
    expect(response.statusCode).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
  });

  it("VIEWER cannot connect mailboxes", async () => {
    const { privileged } = await setup();
    expect((await post(body, viewer)).statusCode).toBe(403);
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
  });

  it("an existing IMAP mailbox still cannot be resumed (the worker does not synchronize IMAP)", async () => {
    const { repos } = await setup();
    repos.emailAccounts.get.mockResolvedValue(account());
    const response = await ctx!.app.inject({
      method: "PATCH",
      url: `/api/email-accounts/${ACCOUNT_ID}`,
      headers: authHeaders(owner, ORG_A),
      payload: { status: "ACTIVE" }
    });
    expect([response.statusCode, response.json().error.code]).toEqual([409, "IMAP_SYNC_NOT_IMPLEMENTED"]);
  });
});
