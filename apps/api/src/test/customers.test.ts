import type { Bot, Customer, CustomerIdentifier } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { identifierSearchFilter, sanitizeSearchTerm } from "../repositories/supabase/customer-repositories.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/* EmailBot V2 phase 2: customers, identifiers and bot assignments (API layer). */

const CUSTOMER_ID = "99999999-9999-4999-8999-999999999999";
const BOT_ID = "88888888-8888-4888-8888-888888888888";
const IDENTIFIER_ID = "77777777-7777-4777-8777-777777777771";

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    organizationId: ORG_A,
    displayName: "Juan Pérez",
    status: "ACTIVE",
    externalRef: null,
    notes: null,
    createdBy: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides
  };
}

function identifier(overrides: Partial<CustomerIdentifier> = {}): CustomerIdentifier {
  return {
    id: IDENTIFIER_ID,
    organizationId: ORG_A,
    customerId: CUSTOMER_ID,
    type: "EMAIL",
    value: "Juan@Gmail.com",
    normalizedValue: "juan@gmail.com",
    botId: null,
    active: true,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides
  };
}

const bot = { id: BOT_ID, organizationId: ORG_A, name: "Netflix", slug: "netflix", status: "ACTIVE" } as Bot;

describe("customers API: RBAC", () => {
  it("every member lists and reads customers of the active organization", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.customers.list.mockResolvedValue({ items: [customer()], page: 1, pageSize: 25, total: 1 });
    repos.customers.get.mockResolvedValue(customer());

    const list = await app.inject({ method: "GET", url: "/api/customers?search=juan&status=ACTIVE", headers: authHeaders(viewer, ORG_A) });
    const detail = await app.inject({ method: "GET", url: `/api/customers/${CUSTOMER_ID}`, headers: authHeaders(viewer, ORG_A) });

    expect(list.statusCode).toBe(200);
    expect(repos.customers.list).toHaveBeenCalledWith(ORG_A, expect.objectContaining({ search: "juan", status: "ACTIVE" }));
    expect(detail.json().customer.id).toBe(CUSTOMER_ID);
    expect(repos.customers.get).toHaveBeenCalledWith(ORG_A, CUSTOMER_ID);
  });

  it("VIEWER cannot create or edit customers, identifiers or assignments", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    const headers = authHeaders(viewer, ORG_A);
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/customers", headers, payload: { displayName: "x" } }),
      app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}`, headers, payload: { status: "SUSPENDED" } }),
      app.inject({ method: "POST", url: `/api/customers/${CUSTOMER_ID}/identifiers`, headers, payload: { type: "EMAIL", value: "a@b.co" } }),
      app.inject({ method: "DELETE", url: `/api/customers/${CUSTOMER_ID}/identifiers/${IDENTIFIER_ID}`, headers }),
      app.inject({ method: "POST", url: `/api/bots/${BOT_ID}/customers`, headers, payload: { customerId: CUSTOMER_ID } }),
      app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}/customers/${CUSTOMER_ID}`, headers })
    ]);
    for (const response of responses) expect(response.json().error.code).toBe("INSUFFICIENT_ROLE");
    expect(repos.customers.create).not.toHaveBeenCalled();
    expect(repos.customerIdentifiers.create).not.toHaveBeenCalled();
    expect(repos.botCustomers.create).not.toHaveBeenCalled();
  });

  it("OPERATOR manages customers (approved permission matrix)", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const { app, repos } = await createTestApp({ users: [operator] });
    repos.customers.create.mockResolvedValue(customer());
    const response = await app.inject({ method: "POST", url: "/api/customers", headers: authHeaders(operator, ORG_A), payload: { displayName: "Juan" } });
    expect(response.statusCode).toBe(201);
  });
});

describe("customers API: create / update / no delete", () => {
  it("creates in the active organization with the caller as creator, and audits it", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos, privileged } = await createTestApp({ users: [owner] });
    repos.customers.create.mockResolvedValue(customer());

    const response = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: authHeaders(owner, ORG_A),
      payload: { displayName: " Juan Pérez ", externalRef: "CRM-1" }
    });
    expect(response.statusCode).toBe(201);
    expect(repos.customers.create).toHaveBeenCalledWith(ORG_A, owner.id, { displayName: "Juan Pérez", status: "ACTIVE", externalRef: "CRM-1" });
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "customer", metadata: expect.objectContaining({ event: "customer.created" }) })
    );
  });

  it("rejects organizationId / createdBy in the body (never trusted)", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    for (const payload of [
      { displayName: "x", organizationId: ORG_B },
      { displayName: "x", createdBy: owner.id }
    ]) {
      expect((await app.inject({ method: "POST", url: "/api/customers", headers: authHeaders(owner, ORG_A), payload })).statusCode).toBe(400);
    }
    expect(repos.customers.create).not.toHaveBeenCalled();
  });

  it("suspension and reactivation are audited as their own events", async () => {
    const admin = makeUser({ [ORG_A]: "ADMIN" });
    const { app, repos, privileged } = await createTestApp({ users: [admin] });
    repos.customers.get.mockResolvedValueOnce(customer()).mockResolvedValueOnce(customer({ status: "SUSPENDED" }));
    repos.customers.update.mockResolvedValueOnce(customer({ status: "SUSPENDED" })).mockResolvedValueOnce(customer({ status: "ACTIVE", notes: "ok" }));
    const headers = authHeaders(admin, ORG_A);

    await app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}`, headers, payload: { status: "SUSPENDED" } });
    await app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}`, headers, payload: { status: "ACTIVE", notes: "ok" } });

    const events = privileged.insertAuditLog.mock.calls.map(([entry]) => (entry as { metadata: { event: string } }).metadata.event);
    expect(events).toEqual(["customer.suspended", "customer.reactivated", "customer.updated"]);
  });

  it("there is no delete: customers are suspended to keep their history", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app } = await createTestApp({ users: [owner] });
    const response = await app.inject({ method: "DELETE", url: `/api/customers/${CUSTOMER_ID}`, headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(404);
  });
});

describe("customers API: IDOR and organization isolation", () => {
  it("a customer id of another organization is not found through the active organization", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.customers.get.mockResolvedValue(null);
    const headers = authHeaders(owner, ORG_A);

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/api/customers/${CUSTOMER_ID}`, headers }),
      app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}`, headers, payload: { displayName: "x" } }),
      app.inject({ method: "GET", url: `/api/customers/${CUSTOMER_ID}/identifiers`, headers }),
      app.inject({ method: "POST", url: `/api/customers/${CUSTOMER_ID}/identifiers`, headers, payload: { type: "EMAIL", value: "a@b.co" } }),
      app.inject({ method: "GET", url: `/api/customers/${CUSTOMER_ID}/bots`, headers })
    ]);
    for (const response of responses) expect(response.statusCode).toBe(404);
    for (const [organizationId] of repos.customers.get.mock.calls) expect(organizationId).toBe(ORG_A);
    expect(repos.customers.update).not.toHaveBeenCalled();
    expect(repos.customerIdentifiers.create).not.toHaveBeenCalled();
  });

  it("selecting another organization without membership is rejected", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app } = await createTestApp({ users: [owner] });
    const response = await app.inject({ method: "GET", url: "/api/customers", headers: authHeaders(owner, ORG_B) });
    expect(response.json().error.code).toBe("NOT_A_MEMBER");
  });

  it("an identifier id that does not belong to the customer is not found", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.customers.get.mockResolvedValue(customer());
    repos.customerIdentifiers.get.mockResolvedValue(null);
    const headers = authHeaders(owner, ORG_A);
    const patch = await app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}/identifiers/${IDENTIFIER_ID}`, headers, payload: { active: false } });
    const remove = await app.inject({ method: "DELETE", url: `/api/customers/${CUSTOMER_ID}/identifiers/${IDENTIFIER_ID}`, headers });
    expect([patch.statusCode, remove.statusCode]).toEqual([404, 404]);
    expect(repos.customerIdentifiers.get).toHaveBeenCalledWith(ORG_A, CUSTOMER_ID, IDENTIFIER_ID);
    expect(repos.customerIdentifiers.remove).not.toHaveBeenCalled();
  });

  it("phone searches match the normalized phone fragment (+51 987 -> +51987)", () => {
    expect(identifierSearchFilter(sanitizeSearchTerm("+51 987"))).toBe(
      'normalized_value.ilike."*+51 987*",and(type.eq.PHONE,normalized_value.ilike."*+51987*")'
    );
    expect(identifierSearchFilter(sanitizeSearchTerm("(01) 234-5678"))).toContain('and(type.eq.PHONE,normalized_value.ilike."*012345678*")');
    expect(identifierSearchFilter("Juan@Gmail")).toBe('normalized_value.ilike."*juan@gmail*"');
    expect(identifierSearchFilter("987654321")).toBe('normalized_value.ilike."*987654321*"');
    // The phone form only ever contains "+" and digits, whatever the term.
    const injected = identifierSearchFilter(sanitizeSearchTerm("98,and(type.eq.EMAIL)*7"));
    expect(injected).not.toContain("type.eq.EMAIL)*");
  });

  it("the search term cannot inject PostgREST filters or wildcards", () => {
    expect(sanitizeSearchTerm("juan,organization_id.eq.x")).toBe("juan organization_id.eq.x");
    expect(sanitizeSearchTerm('a)"or(id.neq.1*%')).toBe("a or id.neq.1");
    expect(sanitizeSearchTerm("  +51 987  ")).toBe("+51 987");
  });
});

describe("customer identifiers", () => {
  it("normalizes with the shared normalizer; the stored value keeps the original text", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const { app, repos, privileged } = await createTestApp({ users: [operator] });
    repos.customers.get.mockResolvedValue(customer());
    repos.customerIdentifiers.create.mockResolvedValue(identifier());

    const response = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER_ID}/identifiers`,
      headers: authHeaders(operator, ORG_A),
      payload: { type: "EMAIL", value: "  John.Smith+Netflix@Gmail.com " }
    });
    expect(response.statusCode).toBe(201);
    expect(repos.customerIdentifiers.create).toHaveBeenCalledWith(ORG_A, CUSTOMER_ID, {
      type: "EMAIL",
      value: "John.Smith+Netflix@Gmail.com",
      normalizedValue: "john.smith+netflix@gmail.com",
      botId: null,
      active: true
    });
    const audit = privileged.insertAuditLog.mock.calls.at(-1)?.[0] as { metadata: Record<string, unknown> };
    expect(audit.metadata).toEqual({ event: "identifier.created", customerId: CUSTOMER_ID, type: "EMAIL", botId: null });
    expect(JSON.stringify(audit)).not.toContain("john.smith");
  });

  it("rejects invalid values and a scope bot of another organization", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.customers.get.mockResolvedValue(customer());
    repos.bots.get.mockResolvedValue(null);
    const headers = authHeaders(owner, ORG_A);

    const invalid = await app.inject({ method: "POST", url: `/api/customers/${CUSTOMER_ID}/identifiers`, headers, payload: { type: "PHONE", value: "12" } });
    const foreignBot = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER_ID}/identifiers`,
      headers,
      payload: { type: "USERNAME", value: "juan", botId: BOT_ID }
    });
    expect(invalid.statusCode).toBe(400);
    expect(foreignBot.json().error.code).toBe("INVALID_BOT");
    expect(repos.bots.get).toHaveBeenCalledWith(ORG_A, BOT_ID);
    expect(repos.customerIdentifiers.create).not.toHaveBeenCalled();
  });

  it("update re-normalizes with the stored type and never changes the type", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.customers.get.mockResolvedValue(customer());
    repos.customerIdentifiers.get.mockResolvedValue(identifier({ type: "PHONE", value: "1", normalizedValue: "1" }));
    repos.customerIdentifiers.update.mockResolvedValue(identifier({ type: "PHONE" }));
    const headers = authHeaders(owner, ORG_A);

    await app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}/identifiers/${IDENTIFIER_ID}`, headers, payload: { value: "+51 987 654 321" } });
    expect(repos.customerIdentifiers.update).toHaveBeenCalledWith(ORG_A, CUSTOMER_ID, IDENTIFIER_ID, {
      value: "+51 987 654 321",
      normalizedValue: "+51987654321"
    });
    const typeChange = await app.inject({ method: "PATCH", url: `/api/customers/${CUSTOMER_ID}/identifiers/${IDENTIFIER_ID}`, headers, payload: { type: "EMAIL" } });
    expect(typeChange.statusCode).toBe(400);
  });

  it("a duplicate identifier for the same customer and scope is a 409", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.customers.get.mockResolvedValue(customer());
    repos.customerIdentifiers.create.mockRejectedValue(Object.assign(new Error("duplicate"), { statusCode: 409, code: "ALREADY_EXISTS" }));
    const response = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER_ID}/identifiers`,
      headers: authHeaders(owner, ORG_A),
      payload: { type: "EMAIL", value: "juan@gmail.com" }
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("bot <-> customer assignments", () => {
  it("assigns a customer of the active organization to a bot of the active organization, audited", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const { app, repos, privileged } = await createTestApp({ users: [operator] });
    repos.bots.get.mockResolvedValue(bot);
    repos.customers.get.mockResolvedValue(customer());
    repos.botCustomers.create.mockResolvedValue({ botId: BOT_ID, customerId: CUSTOMER_ID, active: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/bots/${BOT_ID}/customers`,
      headers: authHeaders(operator, ORG_A),
      payload: { customerId: CUSTOMER_ID }
    });
    expect(response.statusCode).toBe(201);
    expect(repos.botCustomers.create).toHaveBeenCalledWith(ORG_A, operator.id, BOT_ID, CUSTOMER_ID, true);
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ event: "customer.bot.assigned", botId: BOT_ID, customerId: CUSTOMER_ID }) })
    );
  });

  it("a customer of another organization cannot be assigned (422), a bot of another organization is not found (404)", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    const headers = authHeaders(owner, ORG_A);

    repos.bots.get.mockResolvedValueOnce(bot);
    repos.customers.get.mockResolvedValueOnce(null);
    const foreignCustomer = await app.inject({ method: "POST", url: `/api/bots/${BOT_ID}/customers`, headers, payload: { customerId: CUSTOMER_ID } });

    repos.bots.get.mockResolvedValueOnce(null);
    const foreignBot = await app.inject({ method: "POST", url: `/api/bots/${BOT_ID}/customers`, headers, payload: { customerId: CUSTOMER_ID } });

    expect(foreignCustomer.json().error.code).toBe("INVALID_CUSTOMER");
    expect(foreignBot.statusCode).toBe(404);
    expect(repos.botCustomers.create).not.toHaveBeenCalled();
  });

  it("deactivates and unassigns (audited); unknown assignment is 404", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos, privileged } = await createTestApp({ users: [owner] });
    repos.bots.get.mockResolvedValue(bot);
    repos.botCustomers.update.mockResolvedValue({ botId: BOT_ID, customerId: CUSTOMER_ID, active: false });
    repos.botCustomers.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const headers = authHeaders(owner, ORG_A);

    const off = await app.inject({ method: "PATCH", url: `/api/bots/${BOT_ID}/customers/${CUSTOMER_ID}`, headers, payload: { active: false } });
    const removed = await app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}/customers/${CUSTOMER_ID}`, headers });
    const missing = await app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}/customers/${CUSTOMER_ID}`, headers });

    expect([off.statusCode, removed.statusCode, missing.statusCode]).toEqual([200, 204, 404]);
    const events = privileged.insertAuditLog.mock.calls.map(([entry]) => (entry as { metadata: { event: string } }).metadata.event);
    expect(events).toEqual(["customer.bot.deactivated", "customer.bot.unassigned"]);
  });

  it("lists the customers of a bot and the bots of a customer", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [viewer] });
    repos.bots.get.mockResolvedValue(bot);
    repos.customers.get.mockResolvedValue(customer());
    repos.botCustomers.listForBot.mockResolvedValue([]);
    repos.botCustomers.listForCustomer.mockResolvedValue([]);
    const headers = authHeaders(viewer, ORG_A);

    expect((await app.inject({ method: "GET", url: `/api/bots/${BOT_ID}/customers`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/customers/${CUSTOMER_ID}/bots`, headers })).statusCode).toBe(200);
    expect(repos.botCustomers.listForBot).toHaveBeenCalledWith(ORG_A, BOT_ID);
    expect(repos.botCustomers.listForCustomer).toHaveBeenCalledWith(ORG_A, CUSTOMER_ID);
  });

  it("a bot with customers or bot-scoped identifiers cannot be deleted (409 BOT_IN_USE)", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [owner] });
    repos.bots.get.mockResolvedValue(bot);
    repos.bots.hasEmails.mockResolvedValue(false);
    repos.bots.hasCustomerLinks.mockResolvedValue(true);
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${BOT_ID}`, headers: authHeaders(owner, ORG_A) });
    expect(response.json().error.code).toBe("BOT_IN_USE");
    expect(repos.bots.remove).not.toHaveBeenCalled();
  });

  it("a suspended organization blocks customer management", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const { app } = await createTestApp({ users: [owner], organizationStatuses: { [ORG_A]: "SUSPENDED" } });
    const response = await app.inject({ method: "GET", url: "/api/customers", headers: authHeaders(owner, ORG_A) });
    expect(response.json().error.code).toBe("ORGANIZATION_INACTIVE");
  });
});
