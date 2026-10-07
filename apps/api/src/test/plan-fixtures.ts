import {
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type CommercialPlan,
  type OrganizationEntitlements,
  type OrganizationPlan,
  type PlanFeatureKey,
  type PlanLimitKey,
  type SubscriptionStatus
} from "@emailbot/types";

/*
 * Approved Commercial V1 catalog, as the API receives it from
 * public.organization_entitlements (the database is the source; the
 * migration seed is checked against the same values in
 * packages/database/test/plan-catalog.test.ts).
 */

const GB = 1024 ** 3;

export const V1_LIMITS: Record<CommercialPlan, Record<PlanLimitKey, number>> = {
  BASIC: {
    EMAIL_ACCOUNTS: 2,
    RULES: 10,
    BOTS: 2,
    MONTHLY_EMAILS: 2_000,
    MEMBERS: 2,
    CUSTOMERS: 500,
    STORAGE_BYTES: 1 * GB,
    RETENTION_DAYS: 30
  },
  PRO: {
    EMAIL_ACCOUNTS: 5,
    RULES: 30,
    BOTS: 10,
    MONTHLY_EMAILS: 15_000,
    MEMBERS: 5,
    CUSTOMERS: 2_500,
    STORAGE_BYTES: 5 * GB,
    RETENTION_DAYS: 90
  },
  BUSINESS: {
    EMAIL_ACCOUNTS: 20,
    RULES: 100,
    BOTS: 50,
    MONTHLY_EMAILS: 75_000,
    MEMBERS: 20,
    CUSTOMERS: 10_000,
    STORAGE_BYTES: 25 * GB,
    RETENTION_DAYS: 365
  }
};

export const V1_FEATURES: Record<CommercialPlan, Record<PlanFeatureKey, boolean>> = {
  BASIC: { GMAIL: true, MICROSOFT: false, ADVANCED_STATS: false, PORTAL: false, API: false, PRIORITY_SUPPORT: false },
  PRO: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: false, PRIORITY_SUPPORT: true },
  BUSINESS: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: true, PRIORITY_SUPPORT: true }
};

/**
 * Entitlements of a plan reached through an ACTIVE subscription; a legacy
 * plan value (FREE, or any plan of an organization that never subscribed)
 * comes with access LEGACY (FREE is entitled as BASIC).
 */
export function entitlementsFor(plan: OrganizationPlan, access: "SUBSCRIPTION" | "LEGACY" = plan === "FREE" ? "LEGACY" : "SUBSCRIPTION"): OrganizationEntitlements {
  const effectivePlan: CommercialPlan = plan === "FREE" ? "BASIC" : plan;
  return {
    plan,
    effectivePlan,
    access,
    subscriptionStatus: access === "SUBSCRIPTION" ? "ACTIVE" : null,
    limits: { ...V1_LIMITS[effectivePlan] },
    features: { ...V1_FEATURES[effectivePlan] }
  };
}

/** No commercial access: never subscribed (new organization) or the subscription is not ACTIVE. */
export function noAccess(subscriptionStatus: SubscriptionStatus | null = null): OrganizationEntitlements {
  return {
    plan: null,
    effectivePlan: null,
    access: "NONE",
    subscriptionStatus,
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((key) => [key, 0])) as Record<PlanLimitKey, number>,
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((key) => [key, false])) as Record<PlanFeatureKey, boolean>
  };
}
