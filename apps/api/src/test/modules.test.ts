import { createOAuthState } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

const RULE_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const EMAIL_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
const CATEGORY_ID = "77777777-7777-4777-8777-777777777777";

const validRule = {
  name: "Verification codes",
  conditions: [
    { field: "sender", operator: "contains", value: "streaming.example" },
    { field: "subject", operator: "contains", value: "código temporal" }
  ],
  actions: [
    { type: "MARK_IMPORTANT" },
    { type: "EXTRACT", name: "verification_code", preset: "verification_code" }
  ]
};

function storedRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    organizationId: ORG_A,
    categoryId: null,
    name: "Verification codes",
    description: null,
    enabled: true,
    priority: 100,
    stopProcessing: false,
    matchMode: "AND",
    conditions: validRule.conditions,
    actions: [{ type: "MARK_IMPORTANT" }, { type: "EXTRACT", name: "verification_code", preset: "verification_code", source: "any" }],
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

describe("RBAC on routes", () => {
  it("VIEWER and OPERATOR cannot create rules", async () => {
    for (const role of ["VIEWER", "OPERATOR"] as const) {
      const user = makeUser({ [ORG_A]: role });
      const { app, repos } = await createTestApp({ users: [user] });

      const response = await app.inject({
        method: "POST",
        url: "/api/rules",
        headers: authHeaders(user, ORG_A),
        payload: validRule
      });
      expect(response.statusCode, role).toBe(403);
      expect(response.json().error.code).toBe("INSUFFICIENT_ROLE");
      expect(repos.rules.create).not.toHaveBeenCalled();
    }
  });

  it("OPERATOR can update emails, VIEWER cannot", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [operator, viewer] });
    repos.emails.update.mockResolvedValue({ id: EMAIL_ID, isRead: true });

    const byOperator = await app.inject({
      method: "PATCH",
      url: `/api/emails/${EMAIL_ID}`,
      headers: authHeaders(operator, ORG_A),
      payload: { isRead: true }
    });
    const byViewer = await app.inject({
      method: "PATCH",
      url: `/api/emails/${EMAIL_ID}`,
      headers: authHeaders(viewer, ORG_A),
      payload: { isRead: true }
    });

    expect(byOperator.statusCode).toBe(200);
    expect(repos.emails.update).toHaveBeenCalledWith(ORG_A, EMAIL_ID, { is_read: true });
    expect(byViewer.statusCode).toBe(403);
  });

  it("only OWNER/ADMIN can read the audit log", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const { app } = await createTestApp({ users: [operator] });
    const response = await app.inject({ method: "GET", url: "/api/audit-logs", headers: authHeaders(operator, ORG_A) });
    expect(response.statusCode).toBe(403);
  });
});

describe("organizations", () => {
  it("ADMIN cannot transfer ownership (to themselves or anyone)", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });

    const response = await app.inject({
      method: "POST",
      url: "/api/organizations/current/transfer-ownership",
      headers: authHeaders(admin, ORG_A),
      payload: { newOwnerUserId: admin.id }
    });
    expect(response.statusCode).toBe(403);
    expect(repos.organizations.transferOwnership).not.toHaveBeenCalled();
  });

  it("OWNER can transfer ownership and the action is audited", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos, privileged } = await createTestApp({ users: [owner] });
    repos.organizations.transferOwnership.mockResolvedValue(undefined);

    const response = await app.inject({
      method: "POST",
      url: "/api/organizations/current/transfer-ownership",
      headers: authHeaders(owner, ORG_A),
      payload: { newOwnerUserId: MEMBER_ID }
    });

    expect(response.statusCode).toBe(200);
    expect(repos.organizations.transferOwnership).toHaveBeenCalledWith(ORG_A, MEMBER_ID);
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: owner.id, action: "OWNERSHIP_TRANSFER" })
    );
  });

  it("creates an organization with a generated slug and audits it", async () => {
    const user = makeUser({});
    const { app, repos, privileged } = await createTestApp({ users: [user] });
    repos.organizations.create.mockResolvedValue(ORG_A);
    repos.organizations.get.mockResolvedValue({ id: ORG_A, name: "Mi Empresa", slug: "mi-empresa" });

    const response = await app.inject({
      method: "POST",
      url: "/api/organizations",
      headers: authHeaders(user),
      payload: { name: "Mi Empresa" }
    });

    expect(response.statusCode).toBe(201);
    expect(repos.organizations.create).toHaveBeenCalledWith("Mi Empresa", "mi-empresa");
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE", organizationId: ORG_A }));
  });
});

describe("members", () => {
  const ownerMember = { id: MEMBER_ID, organizationId: ORG_A, userId: "owner-user", role: "OWNER" };

  it("rejects OWNER as a target role (validation)", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/organizations/current/members/${MEMBER_ID}`,
      headers: authHeaders(admin, ORG_A),
      payload: { role: "OWNER" }
    });
    expect(response.statusCode).toBe(400);
    expect(repos.members.updateRole).not.toHaveBeenCalled();
  });

  it("cannot modify or remove the OWNER", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.members.get.mockResolvedValue(ownerMember);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/organizations/current/members/${MEMBER_ID}`,
      headers: authHeaders(admin, ORG_A),
      payload: { role: "VIEWER" }
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/organizations/current/members/${MEMBER_ID}`,
      headers: authHeaders(admin, ORG_A)
    });

    expect(patch.json().error.code).toBe("CANNOT_MODIFY_OWNER");
    expect(remove.json().error.code).toBe("CANNOT_REMOVE_OWNER");
    expect(repos.members.updateRole).not.toHaveBeenCalled();
    expect(repos.members.remove).not.toHaveBeenCalled();
  });

  it("an ADMIN cannot change their own role", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.members.get.mockResolvedValue({ id: MEMBER_ID, organizationId: ORG_A, userId: admin.id, role: "ADMIN" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/organizations/current/members/${MEMBER_ID}`,
      headers: authHeaders(admin, ORG_A),
      payload: { role: "VIEWER" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("CANNOT_CHANGE_OWN_ROLE");
  });

  it("changes roles of other members and audits ROLE_CHANGE", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.members.get.mockResolvedValue({ id: MEMBER_ID, organizationId: ORG_A, userId: "other", role: "VIEWER" });
    repos.members.updateRole.mockResolvedValue({ id: MEMBER_ID, organizationId: ORG_A, userId: "other", role: "OPERATOR" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/organizations/current/members/${MEMBER_ID}`,
      headers: authHeaders(admin, ORG_A),
      payload: { role: "OPERATOR" }
    });
    expect(response.statusCode).toBe(200);
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ROLE_CHANGE", metadata: { userId: "other", from: "VIEWER", to: "OPERATOR" } })
    );
  });

  it("adding an unknown email returns 404 without inserting", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos, privileged } = await createTestApp({ users: [owner] });
    privileged.findProfileIdByEmail.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/organizations/current/members",
      headers: authHeaders(owner, ORG_A),
      payload: { email: "nobody@example.com", role: "VIEWER" }
    });
    expect(response.statusCode).toBe(404);
    expect(repos.members.add).not.toHaveBeenCalled();
  });
});

describe("rules", () => {
  it("validates the rule body", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app } = await createTestApp({ users: [admin] });

    const response = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: authHeaders(admin, ORG_A),
      payload: { name: "x", conditions: [{ field: "sender", operator: "regex", value: "(a+)+" }] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects categories that do not belong to the organization", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.categories.get.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: authHeaders(admin, ORG_A),
      payload: { ...validRule, categoryId: CATEGORY_ID }
    });
    expect(response.statusCode).toBe(422);
    expect(repos.categories.get).toHaveBeenCalledWith(ORG_A, CATEGORY_ID);
    expect(repos.rules.create).not.toHaveBeenCalled();
  });

  it("creates a rule with defaults and audits it", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.rules.create.mockImplementation(async (_org: string, _user: string, input: Record<string, unknown>) =>
      storedRule(input)
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: authHeaders(admin, ORG_A),
      payload: validRule
    });

    expect(response.statusCode).toBe(201);
    const [, createdBy, input] = repos.rules.create.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(createdBy).toBe(admin.id);
    expect(input).toMatchObject({ enabled: true, priority: 100, matchMode: "AND", stopProcessing: false });
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE", entityType: "email_rule" }));
  });

  it("disables a rule through PATCH", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.rules.update.mockResolvedValue(storedRule({ enabled: false }));

    const response = await app.inject({
      method: "PATCH",
      url: `/api/rules/${RULE_ID}`,
      headers: authHeaders(admin, ORG_A),
      payload: { enabled: false }
    });
    expect(response.statusCode).toBe(200);
    expect(repos.rules.update).toHaveBeenCalledWith(ORG_A, RULE_ID, admin.id, { enabled: false });
  });

  it("tests a saved rule against a sample email (any member)", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.rules.get.mockResolvedValue(storedRule({ enabled: false }));

    const response = await app.inject({
      method: "POST",
      url: `/api/rules/${RULE_ID}/test`,
      headers: authHeaders(viewer, ORG_A),
      payload: {
        email: {
          sender: "Streaming <info@account.streaming.example>",
          subject: "Tu código temporal",
          body: "Tu código es 4821"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.matched).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.actions).toMatchObject({ markImportant: true, extracted: { verification_code: "4821" } });
    expect(repos.rules.get).toHaveBeenCalledWith(ORG_A, RULE_ID);
  });

  it("draft test: AND does not match when one condition fails, OR does", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app } = await createTestApp({ users: [admin] });
    const email = { sender: "info@account.streaming.example", subject: "Factura", body: "" };

    const run = (matchMode: "AND" | "OR") =>
      app.inject({
        method: "POST",
        url: "/api/rules/test",
        headers: authHeaders(admin, ORG_A),
        payload: { rule: { ...validRule, matchMode }, email }
      });

    const and = (await run("AND")).json();
    const or = (await run("OR")).json();
    expect(and.matched).toBe(false);
    expect(and.conditionResults.map((result: { matched: boolean }) => result.matched)).toEqual([true, false]);
    expect(or.matched).toBe(true);
  });
});

describe("emails and attachments", () => {
  it("passes validated filters to the repository scoped by organization", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.emails.list.mockResolvedValue({ items: [], page: 2, pageSize: 10, total: 0 });

    const response = await app.inject({
      method: "GET",
      url: `/api/emails?page=2&pageSize=10&isImportant=true&categoryId=${CATEGORY_ID}&search=codigo`,
      headers: authHeaders(viewer, ORG_A)
    });

    expect(response.statusCode).toBe(200);
    expect(repos.emails.list).toHaveBeenCalledWith(
      ORG_A,
      expect.objectContaining({ page: 2, pageSize: 10, isImportant: true, categoryId: CATEGORY_ID, search: "codigo" })
    );
  });

  it("does not sign download URLs for attachments outside the organization", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos, privileged } = await createTestApp({ users: [viewer] });
    repos.attachments.get.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: `/api/attachments/${EMAIL_ID}/download`,
      headers: authHeaders(viewer, ORG_A)
    });
    expect(response.statusCode).toBe(404);
    expect(privileged.createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe("email accounts and OAuth", () => {
  const google = { clientId: "cid", clientSecret: "csecret", redirectUri: "http://localhost:3000/api/oauth/gmail/callback" };

  it("reports unconfigured providers", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app } = await createTestApp({ users: [admin] });
    const response = await app.inject({
      method: "POST",
      url: "/api/email-accounts/oauth/gmail/start",
      headers: authHeaders(admin, ORG_A)
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("returns a consent URL with a signed state", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app } = await createTestApp({ users: [admin], config: { google } });
    const response = await app.inject({
      method: "POST",
      url: "/api/email-accounts/oauth/gmail/start",
      headers: authHeaders(admin, ORG_A)
    });
    const url = new URL(response.json().authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toMatch(/\./);
    expect(response.body).not.toContain("csecret");
  });

  it("callback with a forged state never touches the provider", async () => {
    const fetchMock = vi.fn();
    const { app, privileged } = await createTestApp({ config: { google }, fetch: fetchMock as unknown as typeof fetch });

    const response = await app.inject({ method: "GET", url: "/api/oauth/gmail/callback?code=abc&state=forged.state" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://localhost:5173/accounts?oauth=error&reason=invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(privileged.upsertOAuthEmailAccount).not.toHaveBeenCalled();
  });

  it("callback stores encrypted tokens and never exposes them", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "PLAIN-ACCESS", refresh_token: "PLAIN-REFRESH", expires_in: 3600 }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ emailAddress: "Me@Gmail.com", historyId: "1234" }), { status: 200 });
    });
    const { app, privileged, deps } = await createTestApp({
      users: [owner],
      config: { google },
      fetch: fetchMock as unknown as typeof fetch
    });
    privileged.getMemberRole.mockResolvedValue("OWNER");
    privileged.upsertOAuthEmailAccount.mockResolvedValue({ account: { id: ACCOUNT_ID, emailAddress: "me@gmail.com" }, created: true });

    const state = createOAuthState({ userId: owner.id, organizationId: ORG_A, provider: "GMAIL" }, deps.config.oauthStateSecret);
    const response = await app.inject({
      method: "GET",
      url: `/api/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("oauth=connected");
    expect(response.headers.location).not.toContain("PLAIN");

    const stored = privileged.upsertOAuthEmailAccount.mock.calls[0]?.[0] as Record<string, string>;
    expect(stored).toMatchObject({ organizationId: ORG_A, provider: "GMAIL", emailAddress: "me@gmail.com", syncCursor: "1234" });
    expect(stored.accessTokenEncrypted).not.toContain("PLAIN-ACCESS");
    expect(deps.secretBox.decrypt(stored.accessTokenEncrypted as string)).toBe("PLAIN-ACCESS");
    expect(deps.secretBox.decrypt(stored.refreshTokenEncrypted as string)).toBe("PLAIN-REFRESH");
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CONNECT", actorUserId: owner.id }));
  });

  it("callback refuses users who lost OWNER/ADMIN after starting the flow", async () => {
    const fetchMock = vi.fn();
    const { app, privileged, deps } = await createTestApp({ config: { google }, fetch: fetchMock as unknown as typeof fetch });
    privileged.getMemberRole.mockResolvedValue("VIEWER");

    const state = createOAuthState({ userId: "u", organizationId: ORG_A, provider: "GMAIL" }, deps.config.oauthStateSecret);
    const response = await app.inject({ method: "GET", url: `/api/oauth/gmail/callback?code=c&state=${encodeURIComponent(state)}` });

    expect(response.headers.location).toContain("reason=forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an account must be disconnected before deletion, and cannot be resumed when disconnected", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.emailAccounts.get.mockResolvedValueOnce({ id: ACCOUNT_ID, status: "ACTIVE", provider: "GMAIL" });
    repos.emailAccounts.get.mockResolvedValueOnce({ id: ACCOUNT_ID, status: "DISCONNECTED", provider: "GMAIL" });

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/email-accounts/${ACCOUNT_ID}`,
      headers: authHeaders(admin, ORG_A)
    });
    const resume = await app.inject({
      method: "PATCH",
      url: `/api/email-accounts/${ACCOUNT_ID}`,
      headers: authHeaders(admin, ORG_A),
      payload: { status: "ACTIVE" }
    });

    expect(remove.json().error.code).toBe("ACCOUNT_NOT_DISCONNECTED");
    expect(resume.json().error.code).toBe("RECONNECT_REQUIRED");
    expect(repos.emailAccounts.remove).not.toHaveBeenCalled();
  });

  it("manual sync enqueues a job for active accounts only", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const { app, repos, queue } = await createTestApp({ users: [operator] });
    repos.emailAccounts.get.mockResolvedValue({ id: ACCOUNT_ID, status: "ACTIVE", provider: "GMAIL" });

    const response = await app.inject({
      method: "POST",
      url: `/api/email-accounts/${ACCOUNT_ID}/sync`,
      headers: authHeaders(operator, ORG_A)
    });
    expect(response.statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledWith(
      { type: "SYNC_ACCOUNT", emailAccountId: ACCOUNT_ID, organizationId: ORG_A, requestedBy: operator.id },
      { jobId: `sync-${ACCOUNT_ID}` }
    );
  });
});

describe("webhooks", () => {
  const token = "pubsub-token-0123456789";
  const pubsub = (payload: unknown) => ({
    message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), messageId: "1" },
    subscription: "projects/x/subscriptions/y"
  });

  it("Gmail: rejects a wrong verification token", async () => {
    const { app, queue } = await createTestApp({ config: { gmailPubSubVerificationToken: token } });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/gmail?token=wrong",
      payload: pubsub({ emailAddress: "a@b.com", historyId: 1 })
    });
    expect(response.statusCode).toBe(401);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("Gmail: only enqueues (no processing in the webhook) with an idempotent job id", async () => {
    const { app, queue } = await createTestApp({ config: { gmailPubSubVerificationToken: token } });
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/gmail?token=${token}`,
      payload: pubsub({ emailAddress: "Me@Gmail.com", historyId: 987 })
    });

    expect(response.statusCode).toBe(204);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledWith(
      { type: "GMAIL_NOTIFICATION", emailAddress: "me@gmail.com", historyId: "987" },
      { jobId: expect.stringMatching(/^gmail-[a-f0-9]+-987$/) }
    );
  });

  it("Gmail: acknowledges malformed payloads and answers 503 when the queue is down", async () => {
    const { app, queue } = await createTestApp({ config: { gmailPubSubVerificationToken: token } });

    const malformed = await app.inject({ method: "POST", url: `/webhooks/gmail?token=${token}`, payload: { nope: true } });
    expect(malformed.statusCode).toBe(204);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();

    queue.enqueueEmailEvent.mockRejectedValueOnce(new Error("redis down"));
    const down = await app.inject({
      method: "POST",
      url: `/webhooks/gmail?token=${token}`,
      payload: pubsub({ emailAddress: "a@b.com", historyId: 1 })
    });
    expect(down.statusCode).toBe(503);
  });

  it("Gmail webhook is disabled when not configured", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "POST", url: "/webhooks/gmail?token=x", payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it("Microsoft webhook is disabled unless MICROSOFT_GRAPH_PUSH_ENABLED (detailed tests: microsoft-webhook.test.ts)", async () => {
    const { app } = await createTestApp();
    expect((await app.inject({ method: "POST", url: "/webhooks/microsoft?validationToken=abc" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/webhooks/microsoft/lifecycle?validationToken=abc" })).statusCode).toBe(404);
  });
});

describe("tenant isolation at the API layer", () => {
  it("a member of A cannot reach B's resources by id", async () => {
    const user = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [user] });

    for (const url of [`/api/rules/${RULE_ID}`, `/api/emails/${EMAIL_ID}`, `/api/email-accounts/${ACCOUNT_ID}`]) {
      const response = await app.inject({ method: "GET", url, headers: authHeaders(user, ORG_B) });
      expect(response.statusCode, url).toBe(403);
    }
    expect(repos.rules.get).not.toHaveBeenCalled();
    expect(repos.emails.get).not.toHaveBeenCalled();
    expect(repos.emailAccounts.get).not.toHaveBeenCalled();
  });
});
