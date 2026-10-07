import { PLAN_USAGE_KEYS, type OrganizationPlanOverview, type PlanUsage } from "@emailbot/types";
import type { FastifyInstance } from "fastify";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization } from "../../plugins/organization.js";
import { requestEntitlements } from "./entitlements.js";

/*
 * Commercial V1 / V1.1: plan, usage and subscription of the active
 * organization as its members see it (every role; readable while SUSPENDED /
 * CANCELLED and without an active subscription, so the panel can say why it
 * is restricted). Read-only: nothing here activates or changes anything.
 */
export async function planRoutes(app: FastifyInstance) {
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
}
