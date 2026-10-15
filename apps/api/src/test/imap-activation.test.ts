import net from "node:net";
import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";
import { entitlementsFor, noAccess } from "./plan-fixtures.js";

/*
 * IMAP M1: explicit activation through PATCH /api/email-accounts/:id { status: "ACTIVE" }.
 * Production keeps imapAccountsEnabled = false (first block: unchanged 409, nothing called).
 * The other blocks turn the flag on in the TEST configuration only. The database's
 * decision (public.activate_imap_email_account) is a fake here; its own rules are in
 * packages/database/test/imap-m1.test.ts. No network: no resolver, no IMAP client.
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const admin = makeUser({ [ORG_A]: "ADMIN" });
const viewer = makeUser({ [ORG_A]: "VIEWER" });
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";

const imapAccount = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: ACCOUNT_ID,
  organizationId: ORG_A,
  provider: "IMAP",
  status: "PAUSED",
  emailAddress: "ventas@empresa-correo.com",
  displayName: "Ventas",
  lastSyncedAt: null,
  lastErrorCode: "IMAP_ACTIVATION_PENDING",
  lastErrorMessage: "Mailbox connected and paused. Resume it to start synchronizing new mail.",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides
});
const active = () => imapAccount({ status: "ACTIVE", lastErrorCode: null, lastErrorMessage: null });

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(options: { enabled?: boolean } = {}) {
  ctx = await createTestApp({ users: [owner, admin, viewer], config: { imapAccountsEnabled: options.enabled ?? true } });
  ctx.repos.emailAccounts.get.mockResolvedValue(imapAccount());
  return ctx;
}

const resume = (user = owner, payload: Record<string, unknown> = { status: "ACTIVE" }) =>
  ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${ACCOUNT_ID}`, headers: authHeaders(user, ORG_A), payload });
const errorCode = (response: { json(): { error?: { code?: string } } }) => response.json().error?.code;

describe("IMAP disabled (production configuration)", () => {
  it("resuming an IMAP mailbox keeps the 409 IMAP_SYNC_NOT_IMPLEMENTED: no RPC, no queue, no write", async () => {
    const { privileged, repos, queue } = await setup({ enabled: false });
    const response = await resume();
    expect([response.statusCode, errorCode(response)]).toEqual([409, "IMAP_SYNC_NOT_IMPLEMENTED"]);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
    expect(repos.emailAccounts.update).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("both IMAP routes still answer 503 IMAP_NOT_AVAILABLE", async () => {
    await setup({ enabled: false });
    for (const url of ["/api/email-accounts/imap", "/api/email-accounts/imap/test"]) {
      const response = await ctx!.app.inject({ method: "POST", url, headers: authHeaders(owner, ORG_A), payload: {} });
      expect([response.statusCode, errorCode(response)], url).toEqual([503, "IMAP_NOT_AVAILABLE"]);
    }
  });
});

describe("IMAP activation (enabled in test configuration only)", () => {
  it.each([
    ["OWNER", owner],
    ["ADMIN", admin]
  ])("%s: the RPC decides; 200 ACTIVE, audited, first sync queued with the manual-sync job id", async (_role, user) => {
    const { privileged, repos, queue } = await setup();
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome: "ACTIVATED", account: active(), previousStatus: "PAUSED" });
    const response = await resume(user);
    expect([response.statusCode, response.json().account.status]).toEqual([200, "ACTIVE"]);
    expect(privileged.activateImapEmailAccount).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);
    // Never a member (Data API) write of the status.
    expect(repos.emailAccounts.update).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SYNC_ACCOUNT", emailAccountId: ACCOUNT_ID, organizationId: ORG_A }),
      { jobId: `sync-${ACCOUNT_ID}` }
    );
    const audit = JSON.stringify(privileged.insertAuditLog.mock.calls);
    expect(audit).toContain('"from":"PAUSED"');
    expect(audit).toContain('"to":"ACTIVE"');
    expect(audit).toContain('"via":"activate_imap"');
  });

  it("a rename sent with the resume is applied after the activation (display_name only, never the status)", async () => {
    const { privileged, repos } = await setup();
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome: "ACTIVATED", account: active(), previousStatus: "PAUSED" });
    repos.emailAccounts.update.mockResolvedValue({ ...active(), displayName: "Soporte" });
    const response = await resume(owner, { status: "ACTIVE", displayName: "Soporte" });
    expect([response.statusCode, response.json().account.displayName]).toEqual([200, "Soporte"]);
    expect(repos.emailAccounts.update).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID, { display_name: "Soporte" });
  });

  it("VIEWER: 403, the RPC is never called", async () => {
    const { privileged } = await setup();
    expect((await resume(viewer)).statusCode).toBe(403);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it("BASIC: 403 PLAN_FEATURE_UNAVAILABLE; no commercial access: 403 SUBSCRIPTION_REQUIRED (both before the RPC)", async () => {
    const { privileged, repos } = await setup();
    repos.plans.entitlements.mockResolvedValue(entitlementsFor("BASIC"));
    const basic = await resume();
    expect([basic.statusCode, errorCode(basic)]).toEqual([403, "PLAN_FEATURE_UNAVAILABLE"]);
    repos.plans.entitlements.mockResolvedValue(noAccess("CANCELED"));
    const none = await resume();
    expect([none.statusCode, errorCode(none)]).toEqual([403, "SUBSCRIPTION_REQUIRED"]);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["DISCONNECTED", 409, "RECONNECT_REQUIRED"],
    // M1.4 (H1): the mailbox became ERROR between the early check and the RPC.
    ["RECONNECT_REQUIRED", 409, "IMAP_RECONNECT_REQUIRED"],
    ["CREDENTIALS_MISSING", 409, "IMAP_RECONNECT_REQUIRED"],
    ["SETTINGS_INVALID", 409, "IMAP_RECONNECT_REQUIRED"],
    ["FEATURE_NOT_AVAILABLE", 403, "PLAN_FEATURE_UNAVAILABLE"],
    ["NOT_FOUND", 404, "NOT_FOUND"],
    ["NOT_IMAP", 404, "NOT_FOUND"]
  ])("the database refuses with %s: %s %s, no audit, nothing queued", async (outcome, status, code) => {
    const { privileged, queue } = await setup();
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome });
    const response = await resume();
    expect([response.statusCode, errorCode(response)]).toEqual([status, code]);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
  });

  it("ALREADY_ACTIVE: 200, nothing audited or queued again (no duplicate activation)", async () => {
    const { privileged, queue } = await setup();
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome: "ALREADY_ACTIVE", account: active(), previousStatus: "ACTIVE" });
    const response = await resume();
    expect([response.statusCode, response.json().account.status]).toEqual([200, "ACTIVE"]);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
  });

  it("a queue failure after the activation is not an error: the mailbox is ACTIVE (polling picks it up)", async () => {
    const { privileged, queue } = await setup();
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome: "ACTIVATED", account: active(), previousStatus: "PAUSED" });
    queue.enqueueEmailEvent.mockRejectedValueOnce(new Error("redis down"));
    const response = await resume();
    expect([response.statusCode, response.json().account.status]).toEqual([200, "ACTIVE"]);
    expect(privileged.activateImapEmailAccount).toHaveBeenCalledTimes(1);
  });

  it("another organization's mailbox is invisible (404) and a DISCONNECTED one is refused before the RPC", async () => {
    const { privileged, repos } = await setup();
    repos.emailAccounts.get.mockResolvedValue(null);
    expect((await resume()).statusCode).toBe(404);
    repos.emailAccounts.get.mockResolvedValue(imapAccount({ status: "DISCONNECTED" }));
    const disconnected = await resume();
    expect([disconnected.statusCode, errorCode(disconnected)]).toEqual([409, "RECONNECT_REQUIRED"]);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it("pausing an IMAP mailbox stays a member write (status PAUSED), never the activation RPC", async () => {
    const { privileged, repos } = await setup();
    repos.emailAccounts.get.mockResolvedValue(active());
    repos.emailAccounts.update.mockResolvedValue(imapAccount());
    const response = await resume(owner, { status: "PAUSED" });
    expect([response.statusCode, response.json().account.status]).toEqual([200, "PAUSED"]);
    expect(repos.emailAccounts.update).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID, { status: "PAUSED" });
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it("Gmail / Microsoft in ERROR are still resumed as before (member write, no RPC, no IMAP refusal)", async () => {
    const { privileged, repos } = await setup();
    for (const provider of ["GMAIL", "MICROSOFT"] as const) {
      repos.emailAccounts.get.mockResolvedValue(imapAccount({ provider, status: "ERROR", lastErrorCode: "INVALID_GRANT" }));
      repos.emailAccounts.update.mockResolvedValue(imapAccount({ provider, status: "ACTIVE" }));
      const response = await resume();
      expect([response.statusCode, response.json().account.status], provider).toEqual([200, "ACTIVE"]);
      expect(repos.emailAccounts.update).toHaveBeenLastCalledWith(ORG_A, ACCOUNT_ID, { status: "ACTIVE" });
    }
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it("Gmail / Microsoft resume is unchanged (member write, no RPC)", async () => {
    const { privileged, repos } = await setup();
    for (const provider of ["GMAIL", "MICROSOFT"] as const) {
      repos.emailAccounts.get.mockResolvedValue(imapAccount({ provider }));
      repos.emailAccounts.update.mockResolvedValue(imapAccount({ provider, status: "ACTIVE" }));
      const response = await resume();
      expect([response.statusCode, response.json().account.status], provider).toEqual([200, "ACTIVE"]);
      expect(repos.emailAccounts.update).toHaveBeenLastCalledWith(ORG_A, ACCOUNT_ID, { status: "ACTIVE" });
    }
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });
});

describe("M1.4 (H1): an IMAP mailbox in ERROR cannot be resumed; it must be connected again", () => {
  it.each(["IMAP_AUTH_FAILED", "IMAP_TLS_FAILED", "IMAP_RESPONSE_TOO_LARGE", "IMAP_ACTIVATION_PENDING"])(
    "ERROR (%s): 409 IMAP_RECONNECT_REQUIRED; no plan lookup, no RPC, no write, no audit, no job, no connection",
    async (lastErrorCode) => {
      const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
      const open = vi.fn(async () => {
        throw new Error("must not connect");
      });
      ctx = await createTestApp({ users: [owner], config: { imapAccountsEnabled: true }, imapResolver: resolver, imapProbeOpen: open as never });
      const { privileged, repos, queue } = ctx;
      repos.emailAccounts.get.mockResolvedValue(imapAccount({ status: "ERROR", lastErrorCode, lastErrorMessage: "x" }));
      const sockets = vi.spyOn(net.Socket.prototype, "connect");
      try {
        const response = await resume(owner, { status: "ACTIVE", displayName: "Otro nombre" });
        expect([response.statusCode, errorCode(response)]).toEqual([409, "IMAP_RECONNECT_REQUIRED"]);
        expect(response.json().error.message).toMatch(/connect it again/i);
        expect(response.json().error.message).toMatch(/tested again/i);
        expect(sockets).not.toHaveBeenCalled();
      } finally {
        sockets.mockRestore();
      }
      expect(resolver).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(repos.plans.entitlements).not.toHaveBeenCalled();
      expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
      expect(repos.emailAccounts.update).not.toHaveBeenCalled();
      expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
      expect(privileged.insertAuditLog).not.toHaveBeenCalled();
    }
  );

  it("IMAP disabled (production configuration): an ERROR mailbox keeps the unchanged 409 IMAP_SYNC_NOT_IMPLEMENTED", async () => {
    const { privileged, repos } = await setup({ enabled: false });
    repos.emailAccounts.get.mockResolvedValue(imapAccount({ status: "ERROR", lastErrorCode: "IMAP_AUTH_FAILED" }));
    const response = await resume();
    expect([response.statusCode, errorCode(response)]).toEqual([409, "IMAP_SYNC_NOT_IMPLEMENTED"]);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it("pausing an IMAP mailbox in ERROR is still allowed (member write; it stays unusable until reconnected)", async () => {
    const { privileged, repos } = await setup();
    repos.emailAccounts.get.mockResolvedValue(imapAccount({ status: "ERROR", lastErrorCode: "IMAP_AUTH_FAILED" }));
    repos.emailAccounts.update.mockResolvedValue(imapAccount({ status: "PAUSED", lastErrorCode: "IMAP_AUTH_FAILED" }));
    const response = await resume(owner, { status: "PAUSED" });
    expect(response.statusCode).toBe(200);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
  });

  it("a valid PAUSED mailbox is still activated through the RPC (approved flow unchanged)", async () => {
    const { privileged, queue } = await setup();
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome: "ACTIVATED", account: active(), previousStatus: "PAUSED" });
    const response = await resume();
    expect([response.statusCode, response.json().account.status]).toEqual([200, "ACTIVE"]);
    expect(privileged.activateImapEmailAccount).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledTimes(1);
    expect(privileged.insertAuditLog).toHaveBeenCalledTimes(1);
  });
});
