import { PLAN_USAGE_KEYS, type OrganizationPlanOverview, type PlanCatalogEntry, type PlanUsage } from "@emailbot/types";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization } from "../../plugins/organization.js";
import { requestEntitlements } from "./entitlements.js";

export function planRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    /*
     * Commercial V1: the public plan catalog (pricing page /planes, no session).
     * Read-only and identical for everyone: only the active plans, prices and
     * entitlements of the database catalog; nothing about any organization.
     */
    app.get("/plans", { config: { rateLimit: RATE_LIMITS.planCatalog } }, async (_request, reply): Promise<{ items: PlanCatalogEntry[] }> => {
      const items = await deps.privileged.listPlanCatalog();
      reply.header("Cache-Control", "public, max-age=300");
      return { items };
    });

    /*
     * Commercial V1 / V1.1: plan, usage and subscription of the active
     * organization as its members see it (every role; readable while SUSPENDED /
     * CANCELLED and without an active subscription, so the panel can say why it
     * is restricted). Read-only: nothing here activates or changes anything.
     */
    app.get(
      "/organizations/current/plan",
      { preHandler: [app.authenticate, app.requireOrganization], config: { allowInactiveOrganization: true } },
      async (request): Promise<OrganizationPlanOverview> => {
        const plans = requestEntitlements(request);
        const [entitlements, measured, subscription] = await Promise.all([
          plans.read(),
          plans.usage(PLAN_USAGE_KEYS),
          getAuth(request).repos.plans.subscription(getOrganization(request).id)
        ]);
        const usage = Object.fromEntries(PLAN_USAGE_KEYS.map((key) => [key, measured[key] ?? 0])) as PlanUsage;
        return { entitlements, usage, subscription };
      }
    );
  };
}
