import type {
  OrganizationEntitlements,
  PlanFeatureErrorDetails,
  PlanFeatureKey,
  PlanLimitErrorDetails,
  PlanLimitKey,
  PlanUsage,
  PlanUsageKey,
  SubscriptionStatus
} from "@emailbot/types";
import type { FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization } from "../../plugins/organization.js";
import type { PlanRepository } from "../../repositories/types.js";

/*
 * Commercial V1 / V1.1: the single place where plan entitlements are decided.
 *
 * EmailBot is a paid service: the entitlements come from the organization's
 * ACTIVE subscription (public.organization_entitlements; legacy
 * organizations that never had one keep their old plan). Without commercial
 * access every commercial action is refused with 403 SUBSCRIPTION_REQUIRED.
 *
 * Limits are HARD: an action that would exceed one is refused with
 * 403 PLAN_LIMIT_REACHED (nothing is charged, the plan never changes by
 * itself, existing data is never deleted); a feature outside the plan is
 * refused with 403 PLAN_FEATURE_UNAVAILABLE. Routes only name the limit or
 * feature they need.
 *
 * Usage that is ALREADY above a limit (lower plan, legacy FREE organizations
 * entitled as BASIC) is kept: only new additions are refused.
 */

export const planLimitReached = (details: PlanLimitErrorDetails) =>
  new AppError(403, "PLAN_LIMIT_REACHED", `The ${details.plan} plan allows up to ${details.max} (${details.limit})`, details);

export const planFeatureUnavailable = (details: PlanFeatureErrorDetails) =>
  new AppError(403, "PLAN_FEATURE_UNAVAILABLE", `${details.feature} is not included in the ${details.plan} plan`, details);

export const subscriptionRequired = (subscriptionStatus: SubscriptionStatus | null) =>
  new AppError(403, "SUBSCRIPTION_REQUIRED", "The organization has no active subscription", { subscriptionStatus });

/* ------------------------------------------------------------ pure checks */

export function hasCommercialAccess(entitlements: OrganizationEntitlements): boolean {
  return entitlements.access !== "NONE" && entitlements.effectivePlan !== null;
}

export function assertCommercialAccess(entitlements: OrganizationEntitlements): asserts entitlements is OrganizationEntitlements & {
  effectivePlan: NonNullable<OrganizationEntitlements["effectivePlan"]>;
} {
  if (!hasCommercialAccess(entitlements)) throw subscriptionRequired(entitlements.subscriptionStatus);
}

export function canUseFeature(entitlements: OrganizationEntitlements, feature: PlanFeatureKey): boolean {
  return hasCommercialAccess(entitlements) && entitlements.features[feature] === true;
}

/** null = unlimited. */
export function getLimit(entitlements: OrganizationEntitlements, limit: PlanLimitKey): number | null {
  return hasCommercialAccess(entitlements) ? entitlements.limits[limit] : 0;
}

/** Whether `adding` more fit on top of `currentUsage`. */
export function isWithinLimit(entitlements: OrganizationEntitlements, limit: PlanUsageKey, currentUsage: number, adding = 1): boolean {
  const max = getLimit(entitlements, limit);
  return max === null || currentUsage + adding <= max;
}

export function assertWithinLimit(entitlements: OrganizationEntitlements, limit: PlanUsageKey, currentUsage: number, adding = 1): void {
  assertCommercialAccess(entitlements);
  if (isWithinLimit(entitlements, limit, currentUsage, adding)) return;
  throw planLimitReached({ limit, max: getLimit(entitlements, limit) ?? 0, used: currentUsage, plan: entitlements.effectivePlan });
}

export function assertFeatureEnabled(entitlements: OrganizationEntitlements, feature: PlanFeatureKey): void {
  assertCommercialAccess(entitlements);
  if (!canUseFeature(entitlements, feature)) throw planFeatureUnavailable({ feature, plan: entitlements.effectivePlan });
}

/* ------------------------------------------------------------ service */

export interface EntitlementService {
  /** Entitlements as they are (access NONE included); 403 PLAN_UNAVAILABLE when the organization is not visible. */
  read(organizationId: string): Promise<OrganizationEntitlements>;
  /** Entitlements of an organization WITH commercial access; 403 SUBSCRIPTION_REQUIRED otherwise. */
  get(organizationId: string): Promise<OrganizationEntitlements>;
  canUseFeature(organizationId: string, feature: PlanFeatureKey): Promise<boolean>;
  getLimit(organizationId: string, limit: PlanLimitKey): Promise<number | null>;
  usage(organizationId: string, limits?: readonly PlanUsageKey[]): Promise<Partial<PlanUsage>>;
  assertFeatureEnabled(organizationId: string, feature: PlanFeatureKey): Promise<OrganizationEntitlements>;
  /** Reads the current usage when `currentUsage` is omitted. */
  assertWithinLimit(organizationId: string, limit: PlanUsageKey, options?: { currentUsage?: number; adding?: number }): Promise<void>;
}

export function createEntitlementService(source: PlanRepository): EntitlementService {
  async function read(organizationId: string): Promise<OrganizationEntitlements> {
    const entitlements = await source.entitlements(organizationId);
    if (!entitlements) throw new AppError(403, "PLAN_UNAVAILABLE", "The organization's plan cannot be read");
    return entitlements;
  }

  async function get(organizationId: string): Promise<OrganizationEntitlements> {
    const entitlements = await read(organizationId);
    assertCommercialAccess(entitlements);
    return entitlements;
  }

  return {
    read,
    get,
    canUseFeature: async (organizationId, feature) => canUseFeature(await read(organizationId), feature),
    getLimit: async (organizationId, limit) => getLimit(await read(organizationId), limit),
    usage: (organizationId, limits) => source.usage(organizationId, limits),
    async assertFeatureEnabled(organizationId, feature) {
      const entitlements = await get(organizationId);
      assertFeatureEnabled(entitlements, feature);
      return entitlements;
    },
    async assertWithinLimit(organizationId, limit, options = {}) {
      const entitlements = await get(organizationId);
      // Unlimited: no need to measure.
      if (getLimit(entitlements, limit) === null) return;
      const currentUsage = options.currentUsage ?? (await source.usage(organizationId, [limit]))[limit] ?? 0;
      assertWithinLimit(entitlements, limit, currentUsage, options.adding ?? 1);
    }
  };
}

/**
 * Entitlements of the request's active organization, read with the caller's JWT (RLS).
 * A refusal for lack of subscription is logged as subscription.access_denied (no content, no tokens).
 */
export function requestEntitlements(request: FastifyRequest) {
  const service = createEntitlementService(getAuth(request).repos.plans);
  const organizationId = getOrganization(request).id;
  const logged = <T>(operation: Promise<T>): Promise<T> =>
    operation.catch((error: unknown) => {
      if (error instanceof AppError && error.code === "SUBSCRIPTION_REQUIRED") {
        request.log.info(
          {
            event: "subscription.access_denied",
            organizationId,
            subscriptionStatus: (error.details as { subscriptionStatus?: unknown } | undefined)?.subscriptionStatus ?? null,
            operation: `${request.method} ${request.routeOptions.url ?? ""}`,
            reason: "no_active_subscription"
          },
          "operation refused: the organization has no active subscription"
        );
      }
      throw error;
    });
  return {
    read: () => service.read(organizationId),
    get: () => logged(service.get(organizationId)),
    usage: (limits?: readonly PlanUsageKey[]) => service.usage(organizationId, limits),
    assertFeatureEnabled: (feature: PlanFeatureKey) => logged(service.assertFeatureEnabled(organizationId, feature)),
    assertWithinLimit: (limit: PlanUsageKey, options?: { currentUsage?: number; adding?: number }) =>
      logged(service.assertWithinLimit(organizationId, limit, options))
  };
}
