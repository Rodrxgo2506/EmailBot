import type { AdminOrganizationDetail, OffsetPage, Paginated } from "@emailbot/types";
import {
  adminLogQuerySchema,
  adminOrganizationCreateSchema,
  adminOrganizationListQuerySchema,
  adminOrganizationUpdateSchema,
  adminSubscriptionActionParamsSchema,
  adminSubscriptionActionSchema,
  adminSubscriptionActivateSchema,
  idParamsSchema,
  paginationQuerySchema,
  slugify
} from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../deps.js";
import { badRequest, conflict, notFound, unprocessable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";

/*
 * Platform administration API (EmailBot V2 phase 6), /api/admin/*.
 *
 * - authenticate + requirePlatformAdmin on every route; never
 *   requireOrganization (X-Organization-Id is ignored: the platform admin
 *   does not act as a member of any organization).
 * - The actor id always comes from the verified JWT and is checked again by
 *   every admin.* function in the database.
 * - Metadata and statistics only. No e-mail bodies, HTML, extracted data,
 *   attachments, credentials, customer identifiers, Access IDs or sessions.
 * - Writes (create, status, subscriptions) are audited in platform_audit_logs
 *   inside the same database transaction, with the request id.
 * - Commercial V1.1: the plan is never edited on the organization. The Super
 *   Admin activates / renews / changes a subscription after a manual payment
 *   (YAPE, CASH, TRANSFER, MANUAL) and suspends, reactivates, cancels or
 *   expires it; all of it goes through the database subscription core that
 *   the payment provider webhook will also use.
 */

const PAYMENT_EVENTS_SHOWN = 25;

async function requireOrganization(deps: AppDeps, request: FastifyRequest, id: string): Promise<AdminOrganizationDetail> {
  const organization = await deps.admin.getOrganization(getAuth(request).user.id, id);
  if (!organization) throw notFound("Organization");
  return organization;
}

function offsetPage<T>(rows: T[], page: number, pageSize: number): OffsetPage<T> {
  return { items: rows.slice(0, pageSize), page, pageSize, hasMore: rows.length > pageSize };
}

export function adminRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: [app.authenticate, app.requirePlatformAdmin] };
    const write = { preHandler: [app.authenticate, app.requirePlatformAdmin], config: { rateLimit: RATE_LIMITS.adminWrite } };
    const actor = (request: FastifyRequest) => getAuth(request).user.id;

    app.get("/admin/stats", read, async (request) => ({ stats: await deps.admin.stats(actor(request)) }));

    app.get("/admin/organizations", read, async (request) => {
      const query = parseWith(adminOrganizationListQuerySchema, request.query, "query");
      const result = await deps.admin.listOrganizations(actor(request), {
        search: query.search,
        status: query.status,
        plan: query.plan,
        sort: query.sort,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize
      });
      return { items: result.items, page: query.page, pageSize: query.pageSize, total: result.total } satisfies Paginated<unknown>;
    });

    app.post("/admin/organizations", write, async (request, reply) => {
      const input = parseWith(adminOrganizationCreateSchema, request.body);
      const slug = input.slug ?? slugify(input.name);
      if (!slug) throw badRequest("Provide a slug: the name has no usable characters", "INVALID_SLUG");

      // Only an existing user with a confirmed e-mail can own it (no account is created here).
      const ownerUserId = await deps.privileged.findProfileIdByEmail(input.ownerEmail);
      if (!ownerUserId) throw unprocessable("No confirmed user has this e-mail address", "OWNER_NOT_FOUND");

      const id = await deps.admin.createOrganization(actor(request), {
        name: input.name,
        slug,
        ownerUserId,
        requestId: request.id
      });
      request.log.info({ event: "organization.created", organizationId: id }, "platform admin created an organization");
      return reply.status(201).send({ organization: await requireOrganization(deps, request, id) });
    });

    app.get("/admin/organizations/:id", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      return { organization: await requireOrganization(deps, request, id) };
    });

    app.patch("/admin/organizations/:id", write, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const input = parseWith(adminOrganizationUpdateSchema, request.body);
      const found = await deps.admin.updateOrganization(actor(request), id, { status: input.status }, request.id);
      if (!found) throw notFound("Organization");
      request.log.info({ event: "organization.updated", organizationId: id, status: input.status }, "platform admin updated an organization");
      return { organization: await requireOrganization(deps, request, id) };
    });

    /* ---------------------------------------------------------- subscriptions (Commercial V1.1) */

    app.get("/admin/plan-prices", read, async (request) => ({ items: await deps.admin.listPlanPrices(actor(request)) }));

    app.get("/admin/organizations/:id/subscription", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireOrganization(deps, request, id);
      const [subscriptions, paymentEvents] = await Promise.all([
        deps.admin.listSubscriptions(actor(request), id),
        deps.admin.listPaymentEvents(actor(request), id, PAYMENT_EVENTS_SHOWN)
      ]);
      return { subscriptions, paymentEvents };
    });

    /** Manual payment: activates, renews or changes the plan of the organization's subscription. */
    app.post("/admin/organizations/:id/subscription/activate", write, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const input = parseWith(adminSubscriptionActivateSchema, request.body);
      await requireOrganization(deps, request, id);
      const result = await deps.admin.activateSubscription(actor(request), id, input, request.id);
      if (result.outcome === "DUPLICATE") {
        throw conflict("This payment reference was already registered", "PAYMENT_ALREADY_RECORDED");
      }
      request.log.info(
        { event: "subscription.activated", organizationId: id, subscriptionId: result.subscriptionId, outcome: result.outcome, plan: input.plan, paymentMethod: input.paymentMethod },
        "platform admin activated a subscription"
      );
      return { subscriptionId: result.subscriptionId, outcome: result.outcome, organization: await requireOrganization(deps, request, id) };
    });

    /** suspend / reactivate / cancel / expire. */
    app.post("/admin/subscriptions/:id/:action", write, async (request) => {
      const { id, action } = parseWith(adminSubscriptionActionParamsSchema, request.params, "params");
      const input = parseWith(adminSubscriptionActionSchema, request.body ?? {});
      const result = await deps.admin.updateSubscriptionStatus(actor(request), id, action, input.reason ?? null, request.id);
      if (!result) throw notFound("Subscription");
      request.log.info(
        { event: `subscription.${action}`, subscriptionId: id, organizationId: result.organizationId, status: result.status },
        "platform admin changed a subscription"
      );
      return { subscription: result, organization: await requireOrganization(deps, request, result.organizationId) };
    });

    app.get("/admin/organizations/:id/members", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireOrganization(deps, request, id);
      return { items: await deps.admin.listMembers(actor(request), id) };
    });

    app.get("/admin/organizations/:id/bots", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireOrganization(deps, request, id);
      return { items: await deps.admin.listBots(actor(request), id) };
    });

    app.get("/admin/organizations/:id/customers", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const query = parseWith(paginationQuerySchema, request.query, "query");
      await requireOrganization(deps, request, id);
      const result = await deps.admin.listCustomers(actor(request), id, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
      return { items: result.items, page: query.page, pageSize: query.pageSize, total: result.total } satisfies Paginated<unknown>;
    });

    app.get("/admin/organizations/:id/email-accounts", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireOrganization(deps, request, id);
      return { items: await deps.admin.listEmailAccounts(actor(request), id) };
    });

    app.get("/admin/activity", read, async (request) => {
      const query = parseWith(adminLogQuerySchema, request.query, "query");
      const rows = await deps.admin.listActivity(actor(request), {
        organizationId: query.organizationId,
        limit: query.pageSize + 1,
        offset: (query.page - 1) * query.pageSize
      });
      return offsetPage(rows, query.page, query.pageSize);
    });

    app.get("/admin/audit", read, async (request) => {
      const query = parseWith(adminLogQuerySchema, request.query, "query");
      const rows = await deps.admin.listAudit(actor(request), {
        organizationId: query.organizationId,
        limit: query.pageSize + 1,
        offset: (query.page - 1) * query.pageSize
      });
      return offsetPage(rows, query.page, query.pageSize);
    });
  };
}
