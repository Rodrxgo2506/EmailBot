import type { Customer } from "@emailbot/types";
import {
  botCustomerAssignSchema,
  botCustomerParamsSchema,
  botCustomerUpdateSchema,
  customerCreateSchema,
  customerIdentifierCreateSchema,
  customerIdentifierParamsSchema,
  customerIdentifierUpdateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  idParamsSchema,
  normalizeIdentifier
} from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import type { CustomerIdentifierWrite, CustomerWrite } from "../../repositories/types.js";
import { requestEntitlements } from "../plans/entitlements.js";

/*
 * Customers, identifiers and bot assignments (EmailBot V2, phase 2).
 *
 * - organizationId always comes from the active organization, the actor from
 *   the JWT; bodies are strict and never carry them.
 * - Every resource id in the path is resolved INSIDE the active organization
 *   (404 otherwise), so ids of other tenants are indistinguishable from
 *   missing ones (IDOR).
 * - Customers are never deleted: suspension (status = SUSPENDED) keeps their
 *   history, identifiers and assignments.
 * - Audit: existing actions + metadata.event. Identifier VALUES are personal
 *   data and are never written to the audit log (type and scope only).
 */

async function requireCustomer(request: FastifyRequest, customerId: string): Promise<Customer> {
  const customer = await getAuth(request).repos.customers.get(getOrganization(request).id, customerId);
  if (!customer) throw notFound("Customer");
  return customer;
}

async function requireBot(request: FastifyRequest, botId: string) {
  const bot = await getAuth(request).repos.bots.get(getOrganization(request).id, botId);
  if (!bot) throw notFound("Bot");
  return bot;
}

/** A bot-scoped identifier may only reference a bot of the active organization. */
async function assertScopeBot(request: FastifyRequest, botId: string | null | undefined) {
  if (!botId) return;
  const bot = await getAuth(request).repos.bots.get(getOrganization(request).id, botId);
  if (!bot) throw unprocessable("Bot not found in this organization", "INVALID_BOT");
}

function normalizedOrThrow(type: Parameters<typeof normalizeIdentifier>[0], value: string) {
  const result = normalizeIdentifier(type, value);
  if (!result.ok) throw badRequest(`Value ${result.problem}`, "INVALID_IDENTIFIER");
  return result;
}

function statusEvent(before: Customer, after: Customer): "customer.suspended" | "customer.reactivated" | null {
  if (before.status === after.status) return null;
  return after.status === "SUSPENDED" ? "customer.suspended" : "customer.reactivated";
}

export async function customerRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("customers:read")] };
  const manage = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("customers:manage")] };

  /* ------------------------------------------------------------ customers */

  app.get("/customers", read, async (request) => {
    const query = parseWith(customerListQuerySchema, request.query, "query");
    return getAuth(request).repos.customers.list(getOrganization(request).id, query);
  });

  app.get("/customers/:id", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    return { customer: await requireCustomer(request, id) };
  });

  app.post("/customers", manage, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseWith(customerCreateSchema, request.body);
    const insert: CustomerWrite & { displayName: string } = { displayName: input.displayName, status: input.status };
    if (input.externalRef !== undefined) insert.externalRef = input.externalRef;
    if (input.notes !== undefined) insert.notes = input.notes;
    // Commercial V1: the CUSTOMERS limit counts ACTIVE customers (customers are suspended, never deleted).
    if (insert.status === "ACTIVE") await requestEntitlements(request).assertWithinLimit("CUSTOMERS");

    const customer = await auth.repos.customers.create(getOrganization(request).id, auth.user.id, insert);
    await app.audit(request, {
      action: "CREATE",
      entityType: "customer",
      entityId: customer.id,
      metadata: { event: "customer.created", status: customer.status }
    });
    return reply.status(201).send({ customer });
  });

  app.patch("/customers/:id", manage, async (request) => {
    const auth = getAuth(request);
    const organizationId = getOrganization(request).id;
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const input = parseWith(customerUpdateSchema, request.body);
    const before = await requireCustomer(request, id);

    const patch: CustomerWrite = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.status !== undefined) patch.status = input.status;
    if (input.externalRef !== undefined) patch.externalRef = input.externalRef;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (before.status !== "ACTIVE" && patch.status === "ACTIVE") await requestEntitlements(request).assertWithinLimit("CUSTOMERS");

    const customer = await auth.repos.customers.update(organizationId, id, patch);
    if (!customer) throw notFound("Customer");

    const status = statusEvent(before, customer);
    if (status) await app.audit(request, { action: "UPDATE", entityType: "customer", entityId: id, metadata: { event: status } });
    const fields = Object.keys(patch).filter((field) => field !== "status");
    if (fields.length > 0) {
      await app.audit(request, { action: "UPDATE", entityType: "customer", entityId: id, metadata: { event: "customer.updated", fields } });
    }
    return { customer };
  });

  /* ------------------------------------------------------------ identifiers */

  app.get("/customers/:id/identifiers", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    await requireCustomer(request, id);
    return { items: await getAuth(request).repos.customerIdentifiers.list(getOrganization(request).id, id) };
  });

  app.post("/customers/:id/identifiers", manage, async (request, reply) => {
    const organizationId = getOrganization(request).id;
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const input = parseWith(customerIdentifierCreateSchema, request.body);
    await requireCustomer(request, id);
    await assertScopeBot(request, input.botId);
    const normalized = normalizedOrThrow(input.type, input.value);

    const identifier = await getAuth(request).repos.customerIdentifiers.create(organizationId, id, {
      type: input.type,
      value: normalized.value,
      normalizedValue: normalized.normalized,
      botId: input.botId ?? null,
      active: input.active
    });
    await app.audit(request, {
      action: "CREATE",
      entityType: "customer_identifier",
      entityId: identifier.id,
      metadata: { event: "identifier.created", customerId: id, type: identifier.type, botId: identifier.botId }
    });
    return reply.status(201).send({ identifier });
  });

  app.patch("/customers/:id/identifiers/:identifierId", manage, async (request) => {
    const organizationId = getOrganization(request).id;
    const { id, identifierId } = parseWith(customerIdentifierParamsSchema, request.params, "params");
    const input = parseWith(customerIdentifierUpdateSchema, request.body);
    await requireCustomer(request, id);
    const repos = getAuth(request).repos;
    const current = await repos.customerIdentifiers.get(organizationId, id, identifierId);
    if (!current) throw notFound("Identifier");

    const patch: CustomerIdentifierWrite = {};
    if (input.value !== undefined) {
      const normalized = normalizedOrThrow(current.type, input.value);
      patch.value = normalized.value;
      patch.normalizedValue = normalized.normalized;
    }
    if (input.botId !== undefined) {
      await assertScopeBot(request, input.botId);
      patch.botId = input.botId;
    }
    if (input.active !== undefined) patch.active = input.active;

    const identifier = await repos.customerIdentifiers.update(organizationId, id, identifierId, patch);
    if (!identifier) throw notFound("Identifier");
    await app.audit(request, {
      action: "UPDATE",
      entityType: "customer_identifier",
      entityId: identifierId,
      metadata: {
        event: "identifier.updated",
        customerId: id,
        fields: Object.keys(patch).filter((field) => field !== "normalizedValue")
      }
    });
    return { identifier };
  });

  app.delete("/customers/:id/identifiers/:identifierId", manage, async (request, reply) => {
    const organizationId = getOrganization(request).id;
    const { id, identifierId } = parseWith(customerIdentifierParamsSchema, request.params, "params");
    await requireCustomer(request, id);
    const repos = getAuth(request).repos;
    const current = await repos.customerIdentifiers.get(organizationId, id, identifierId);
    if (!current) throw notFound("Identifier");

    await repos.customerIdentifiers.remove(organizationId, id, identifierId);
    await app.audit(request, {
      action: "DELETE",
      entityType: "customer_identifier",
      entityId: identifierId,
      metadata: { event: "identifier.deleted", customerId: id, type: current.type, botId: current.botId }
    });
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------ bots of a customer / customers of a bot */

  app.get("/customers/:id/bots", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    await requireCustomer(request, id);
    return { items: await getAuth(request).repos.botCustomers.listForCustomer(getOrganization(request).id, id) };
  });

  app.get("/bots/:id/customers", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    await requireBot(request, id);
    return { items: await getAuth(request).repos.botCustomers.listForBot(getOrganization(request).id, id) };
  });

  app.post("/bots/:id/customers", manage, async (request, reply) => {
    const auth = getAuth(request);
    const organizationId = getOrganization(request).id;
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const input = parseWith(botCustomerAssignSchema, request.body);
    await requireBot(request, id);
    const customer = await auth.repos.customers.get(organizationId, input.customerId);
    if (!customer) throw unprocessable("Customer not found in this organization", "INVALID_CUSTOMER");

    const assignment = await auth.repos.botCustomers.create(organizationId, auth.user.id, id, input.customerId, input.active);
    await app.audit(request, {
      action: "CREATE",
      entityType: "bot_customer_assignment",
      entityId: input.customerId,
      metadata: { event: "customer.bot.assigned", botId: id, customerId: input.customerId, active: input.active }
    });
    return reply.status(201).send({ assignment });
  });

  app.patch("/bots/:id/customers/:customerId", manage, async (request) => {
    const organizationId = getOrganization(request).id;
    const { id, customerId } = parseWith(botCustomerParamsSchema, request.params, "params");
    const { active } = parseWith(botCustomerUpdateSchema, request.body);
    await requireBot(request, id);

    const assignment = await getAuth(request).repos.botCustomers.update(organizationId, id, customerId, active);
    if (!assignment) throw notFound("Assignment");
    await app.audit(request, {
      action: "UPDATE",
      entityType: "bot_customer_assignment",
      entityId: customerId,
      metadata: { event: active ? "customer.bot.activated" : "customer.bot.deactivated", botId: id, customerId }
    });
    return { assignment };
  });

  app.delete("/bots/:id/customers/:customerId", manage, async (request, reply) => {
    const organizationId = getOrganization(request).id;
    const { id, customerId } = parseWith(botCustomerParamsSchema, request.params, "params");
    await requireBot(request, id);

    const removed = await getAuth(request).repos.botCustomers.remove(organizationId, id, customerId);
    if (!removed) throw notFound("Assignment");
    await app.audit(request, {
      action: "DELETE",
      entityType: "bot_customer_assignment",
      entityId: customerId,
      metadata: { event: "customer.bot.unassigned", botId: id, customerId }
    });
    return reply.status(204).send();
  });
}
