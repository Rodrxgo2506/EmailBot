import { emailDeliveryParamsSchema, idParamsSchema, manualDeliveryCreateSchema } from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { notFound } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";

/*
 * Deliveries of an email (EmailBot V2 phase 5).
 *
 *   GET    /api/emails/:id/deliveries                 emails:read
 *   POST   /api/emails/:id/deliveries { customerId }  deliveries:manage  (MANUAL)
 *   DELETE /api/emails/:id/deliveries/:deliveryId     deliveries:manage  (MANUAL only, soft)
 *
 * The organization comes from the operator's session; the email, the
 * customer and the delivery are resolved inside it (404 otherwise: IDOR).
 * A MANUAL delivery follows exactly the automatic rules (same organization,
 * email bot, bot ACTIVE, customer ACTIVE, active assignment), enforced by
 * the database function and the eligibility trigger; nothing is duplicated.
 * Audit metadata: ids only (never email content, Access IDs or tokens).
 */

async function requireEmail(request: FastifyRequest, emailId: string) {
  const email = await getAuth(request).repos.emails.get(getOrganization(request).id, emailId);
  if (!email) throw notFound("Email");
  return email;
}

export async function deliveryRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("emails:read")] };
  const manage = {
    preHandler: [app.authenticate, app.requireOrganization, requirePermission("deliveries:manage")],
    config: { rateLimit: RATE_LIMITS.deliveryManage }
  };

  app.get("/emails/:id/deliveries", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    await requireEmail(request, id);
    return { items: await getAuth(request).repos.emailDeliveries.list(getOrganization(request).id, id) };
  });

  app.post("/emails/:id/deliveries", manage, async (request, reply) => {
    const auth = getAuth(request);
    const organizationId = getOrganization(request).id;
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const { customerId } = parseWith(manualDeliveryCreateSchema, request.body);
    await requireEmail(request, id);
    const customer = await auth.repos.customers.get(organizationId, customerId);
    if (!customer) throw notFound("Customer");

    const result = await auth.repos.emailDeliveries.addManual(id, customerId);
    if (result.outcome !== "EXISTING") {
      await app.audit(request, {
        action: "CREATE",
        entityType: "email_delivery",
        entityId: result.deliveryId,
        metadata: {
          event: "delivery.created.manual",
          emailId: id,
          deliveryId: result.deliveryId,
          customerId,
          botId: result.botId,
          reactivated: result.outcome === "REACTIVATED"
        }
      });
    }
    const delivery = await auth.repos.emailDeliveries.get(organizationId, id, result.deliveryId);
    return reply.status(result.outcome === "EXISTING" ? 200 : 201).send({ delivery, outcome: result.outcome });
  });

  app.delete("/emails/:id/deliveries/:deliveryId", manage, async (request) => {
    const auth = getAuth(request);
    const organizationId = getOrganization(request).id;
    const { id, deliveryId } = parseWith(emailDeliveryParamsSchema, request.params, "params");
    const existing = await auth.repos.emailDeliveries.get(organizationId, id, deliveryId);
    if (!existing) throw notFound("Delivery");

    const result = await auth.repos.emailDeliveries.removeManual(deliveryId);
    if (result.removed) {
      await app.audit(request, {
        action: "UPDATE",
        entityType: "email_delivery",
        entityId: deliveryId,
        metadata: { event: "delivery.removed.manual", emailId: id, deliveryId, customerId: result.customerId, botId: result.botId }
      });
    }
    return { removed: result.removed };
  });
}
