import type { Bot } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/* EmailBot V2 phase 1: bots API, bot of a rule, email filter, organization status. */

const BOT_ID = "88888888-8888-4888-8888-888888888888";

function storedBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: BOT_ID,
    organizationId: ORG_A,
    name: "Netflix",
    slug: "netflix",
    description: null,
    status: "ACTIVE",
    customerResolution: { source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" },
    portalSettings: { showBody: false, showAttachments: false, fields: [] },
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides
  };
}

const validRule = {
  name: "Netflix codes",
  conditions: [{ field: "sender", operator: "contains", value: "netflix.com" }],
  actions: [{ type: "EXTRACT", name: "verification_code", preset: "verification_code" }]
};

describe("bots API: RBAC", () => {
  it("every member can list and read bots of the active organization", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.bots.list.mockResolvedValue([storedBot()]);
    repos.bots.get.mockResolvedValue(storedBot());

    const list = await app.inject({ method: "GET", url: "/api/bots", headers: authHeaders(viewer, ORG_A) });
    const detail = await app.inject({ method: "GET", url: `/api/bots/${BOT_ID}`, headers: authHeaders(viewer, ORG_A) });

    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(repos.bots.list).toHaveBeenCalledWith(ORG_A);
    expect(detail.json().bot.id).toBe(BOT_ID);
    expect(repos.bots.get).toHaveBeenCalledWith(ORG_A, BOT_ID);
  });

  it.each(["OPERATOR", "VIEWER"] as const)("%s cannot create, update or delete bots", async (role) => {
    const user = makeUser({ [ORG_A]: role });
    const { app, repos } = await createTestApp({ users: [user] });
    const headers = authHeaders(user, ORG_A);

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/bots", headers, payload: { name: "Netflix" } }),
      app.inject({ method: "PATCH", url: `/api/bots/${BOT_ID}`, headers, payload: { status: "PAUSED" } }),
      app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}`, headers })
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("INSUFFICIENT_ROLE");
    }
    expect(repos.bots.create).not.toHaveBeenCalled();
    expect(repos.bots.update).not.toHaveBeenCalled();
    expect(repos.bots.remove).not.toHaveBeenCalled();
  });

  it("the role of the selected organization applies (OWNER elsewhere does not help)", async () => {
    const user = makeUser({ [ORG_A]: "VIEWER", [ORG_B]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [user] });
    const response = await app.inject({ method: "POST", url: "/api/bots", headers: authHeaders(user, ORG_A), payload: { name: "X" } });
    expect(response.statusCode).toBe(403);
    expect(repos.bots.create).not.toHaveBeenCalled();
  });
});

describe("bots API: create, update, delete", () => {
  it("ADMIN creates a bot with a derived slug, scoped to the active organization, and it is audited", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.bots.create.mockResolvedValue(storedBot({ name: "Prime Vídeo", slug: "prime-video" }));

    const response = await app.inject({ method: "POST", url: "/api/bots", headers: authHeaders(admin, ORG_A), payload: { name: "Prime Vídeo" } });

    expect(response.statusCode).toBe(201);
    expect(repos.bots.create).toHaveBeenCalledWith(ORG_A, admin.id, { name: "Prime Vídeo", slug: "prime-video", status: "ACTIVE" });
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_A,
        action: "CREATE",
        entityType: "bot",
        metadata: expect.objectContaining({ event: "bot.created" })
      })
    );
  });

  it("rejects unknown fields (organizationId, createdBy) and invalid documents", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    const headers = authHeaders(owner, ORG_A);

    for (const payload of [
      { name: "x", organizationId: ORG_B },
      { name: "x", createdBy: owner.id },
      { name: "x", customerResolution: { source: "EXTRACTED_FIELD" } },
      { name: "x", portalSettings: { fields: [{ key: "code", label: "A" }, { key: "code", label: "B" }] } }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/bots", headers, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(repos.bots.create).not.toHaveBeenCalled();
  });

  it("pausing and resuming are audited as their own events", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos, privileged } = await createTestApp({ users: [owner] });
    repos.bots.get.mockResolvedValueOnce(storedBot({ status: "ACTIVE" })).mockResolvedValueOnce(storedBot({ status: "PAUSED" }));
    repos.bots.update.mockResolvedValueOnce(storedBot({ status: "PAUSED" })).mockResolvedValueOnce(storedBot({ status: "ACTIVE", name: "N2" }));
    const headers = authHeaders(owner, ORG_A);

    await app.inject({ method: "PATCH", url: `/api/bots/${BOT_ID}`, headers, payload: { status: "PAUSED" } });
    await app.inject({ method: "PATCH", url: `/api/bots/${BOT_ID}`, headers, payload: { status: "ACTIVE", name: "N2" } });

    const events = privileged.insertAuditLog.mock.calls.map(([entry]) => (entry as { metadata: { event: string } }).metadata.event);
    expect(events).toEqual(["bot.paused", "bot.resumed", "bot.updated"]);
    expect(repos.bots.update).toHaveBeenNthCalledWith(1, ORG_A, BOT_ID, owner.id, { status: "PAUSED" });
  });

  it("the portal delivery (customerResolution) is updated as the panel sends it; an incomplete one is rejected", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    const recipient = { source: "RECIPIENT", identifierType: "EMAIL", onMultipleMatches: "LEAVE_UNASSIGNED" } as const;
    repos.bots.get.mockResolvedValue(storedBot());
    repos.bots.update.mockResolvedValue(storedBot({ customerResolution: recipient }));
    const headers = authHeaders(admin, ORG_A);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/bots/${BOT_ID}`,
      headers,
      payload: { customerResolution: { source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED" } }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().bot.customerResolution).toEqual(recipient);
    expect(repos.bots.update).toHaveBeenCalledWith(ORG_A, BOT_ID, admin.id, { customerResolution: recipient });
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityType: "bot", metadata: expect.objectContaining({ event: "bot.updated" }) }));

    const invalid = await app.inject({ method: "PATCH", url: `/api/bots/${BOT_ID}`, headers, payload: { customerResolution: { source: "EXTRACTED_FIELD" } } });
    expect(invalid.statusCode).toBe(400);
    expect(repos.bots.update).toHaveBeenCalledTimes(1);
  });

  it("a bot of another organization is not found", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.bots.get.mockResolvedValue(null);
    const response = await app.inject({ method: "PATCH", url: `/api/bots/${BOT_ID}`, headers: authHeaders(owner, ORG_A), payload: { name: "x" } });
    expect(response.statusCode).toBe(404);
    expect(repos.bots.update).not.toHaveBeenCalled();
  });

  it("a bot with routed emails cannot be deleted (pause it to keep its history)", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.bots.get.mockResolvedValue(storedBot());
    repos.bots.hasEmails.mockResolvedValue(true);

    const response = await app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}`, headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BOT_HAS_EMAILS");
    expect(repos.bots.remove).not.toHaveBeenCalled();
  });

  it("a bot without emails is deleted and audited", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos, privileged } = await createTestApp({ users: [owner] });
    repos.bots.get.mockResolvedValue(storedBot());
    repos.bots.hasEmails.mockResolvedValue(false);
    repos.bots.hasCustomerLinks.mockResolvedValue(false);
    repos.bots.remove.mockResolvedValue(true);

    const response = await app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}`, headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(204);
    expect(repos.bots.remove).toHaveBeenCalledWith(ORG_A, BOT_ID);
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DELETE", entityType: "bot", metadata: expect.objectContaining({ event: "bot.deleted" }) })
    );
  });
});

describe("rules and emails: bot", () => {
  it("a rule can only reference a bot of the active organization", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.bots.get.mockResolvedValue(null);

    const response = await app.inject({ method: "POST", url: "/api/rules", headers: authHeaders(admin, ORG_A), payload: { ...validRule, botId: BOT_ID } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("INVALID_BOT");
    expect(repos.bots.get).toHaveBeenCalledWith(ORG_A, BOT_ID);
    expect(repos.rules.create).not.toHaveBeenCalled();
  });

  it("creates a bot rule and moves a rule back to general (botId null)", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos } = await createTestApp({ users: [admin] });
    repos.bots.get.mockResolvedValue(storedBot());
    const rule = { id: BOT_ID, name: "r", enabled: true, priority: 100, botId: BOT_ID };
    repos.rules.create.mockResolvedValue(rule);
    repos.rules.update.mockResolvedValue({ ...rule, botId: null });
    const headers = authHeaders(admin, ORG_A);

    const created = await app.inject({ method: "POST", url: "/api/rules", headers, payload: { ...validRule, botId: BOT_ID } });
    const general = await app.inject({ method: "PATCH", url: `/api/rules/${BOT_ID}`, headers, payload: { botId: null } });

    expect(created.statusCode).toBe(201);
    expect(repos.rules.create).toHaveBeenCalledWith(ORG_A, admin.id, expect.objectContaining({ botId: BOT_ID }));
    expect(general.statusCode).toBe(200);
    expect(repos.rules.update).toHaveBeenCalledWith(ORG_A, BOT_ID, admin.id, { botId: null });
  });

  it("lists the rules of a bot, the general rules, or all of them", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.rules.list.mockResolvedValue([]);
    const headers = authHeaders(viewer, ORG_A);

    await app.inject({ method: "GET", url: `/api/rules?botId=${BOT_ID}`, headers });
    await app.inject({ method: "GET", url: "/api/rules?botId=none", headers });
    await app.inject({ method: "GET", url: "/api/rules", headers });
    const invalid = await app.inject({ method: "GET", url: "/api/rules?botId=netflix", headers });

    expect(repos.rules.list.mock.calls).toEqual([[ORG_A, { botId: BOT_ID }], [ORG_A, { botId: null }], [ORG_A, {}]]);
    expect(invalid.statusCode).toBe(400);
  });

  it("the email list can be filtered by bot", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.emails.list.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });

    const response = await app.inject({ method: "GET", url: `/api/emails?botId=${BOT_ID}`, headers: authHeaders(viewer, ORG_A) });
    expect(response.statusCode).toBe(200);
    expect(repos.emails.list).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ botId: BOT_ID }));
  });
});

describe("organization status (EmailBot V2)", () => {
  it.each(["SUSPENDED", "CANCELLED"] as const)("a %s organization cannot be operated, with or without X-Organization-Id", async (status) => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner], organizationStatuses: { [ORG_A]: status } });

    for (const headers of [authHeaders(owner, ORG_A), authHeaders(owner)]) {
      for (const [method, url] of [
        ["GET", "/api/rules"],
        ["GET", "/api/bots"],
        ["GET", "/api/emails"],
        ["POST", "/api/bots"]
      ] as const) {
        const response = await app.inject(method === "POST" ? { method, url, headers, payload: { name: "x" } } : { method, url, headers });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.json().error.code).toBe("ORGANIZATION_INACTIVE");
      }
    }
    expect(repos.rules.list).not.toHaveBeenCalled();
    expect(repos.bots.create).not.toHaveBeenCalled();
  });

  it("the organization and the user's memberships stay readable, so the UI can show the status", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner], organizationStatuses: { [ORG_A]: "SUSPENDED" } });
    repos.organizations.get.mockResolvedValue({ id: ORG_A, status: "SUSPENDED" });
    repos.organizations.getSettings.mockResolvedValue(null);

    const current = await app.inject({ method: "GET", url: "/api/organizations/current", headers: authHeaders(owner, ORG_A) });
    const me = await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) });

    expect(current.statusCode).toBe(200);
    expect(current.json().organization.status).toBe("SUSPENDED");
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships[0].organization.status).toBe("SUSPENDED");
  });

  it("other organizations of the same user keep working", async () => {
    const user = makeUser({ [ORG_A]: "OWNER", [ORG_B]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [user], organizationStatuses: { [ORG_A]: "SUSPENDED" } });
    repos.rules.list.mockResolvedValue([]);

    expect((await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user, ORG_B) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user, ORG_A) })).statusCode).toBe(403);
  });
});
