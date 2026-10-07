import {
  PLAN_ACCESS,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  PLAN_USAGE_KEYS,
  isCommercialPlan,
  type OrganizationEntitlements,
  type OrganizationPlan,
  type OrganizationSubscriptionSummary,
  type PlanAccess,
  type PlanFeatureKey,
  type PlanLimitKey,
  type PlanUsage,
  type PlanUsageKey,
  type SubscriptionStatus
} from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { PlanRepository } from "../types.js";
import type { Row } from "./mappers.js";

/*
 * Commercial V1 / V1.1: entitlements, usage and subscription through the
 * SECURITY INVOKER functions public.organization_entitlements /
 * organization_usage and the subscriptions table (members read their own
 * organization through RLS). Bound to the caller's JWT or, for the OAuth
 * callback only, to the service role.
 */

/**
 * Rows of organization_entitlements -> entitlements. Fail closed: a limit
 * missing from the catalog is 0 and a missing feature is disabled; unknown
 * keys (added to the database before the code knows them) are ignored; an
 * unknown access or a non-commercial effective plan means no access.
 */
export function toEntitlements(rows: Row[]): OrganizationEntitlements | null {
  const first = rows[0];
  if (!first) return null;

  const effectivePlan = isCommercialPlan(String(first.effective_plan)) ? first.effective_plan : null;
  const access: PlanAccess =
    effectivePlan !== null && (PLAN_ACCESS as readonly string[]).includes(first.access) ? (first.access as PlanAccess) : "NONE";

  const limits = Object.fromEntries(PLAN_LIMIT_KEYS.map((key) => [key, 0])) as Record<PlanLimitKey, number | null>;
  const features = Object.fromEntries(PLAN_FEATURE_KEYS.map((key) => [key, false])) as Record<PlanFeatureKey, boolean>;

  if (access !== "NONE") {
    for (const row of rows) {
      if (row.kind === "LIMIT" && (PLAN_LIMIT_KEYS as readonly string[]).includes(row.key)) {
        limits[row.key as PlanLimitKey] = row.limit_value === null ? null : Number(row.limit_value);
      } else if (row.kind === "FEATURE" && (PLAN_FEATURE_KEYS as readonly string[]).includes(row.key)) {
        features[row.key as PlanFeatureKey] = row.enabled === true;
      }
    }
  }

  return {
    plan: (first.plan ?? null) as OrganizationPlan | null,
    effectivePlan: access === "NONE" ? null : effectivePlan,
    access,
    subscriptionStatus: (first.subscription_status ?? null) as SubscriptionStatus | null,
    limits,
    features
  };
}

/** numeric from PostgREST (JSON number or string) -> "39.90". */
export function toDecimalString(value: unknown): string {
  return typeof value === "string" ? value : Number(value).toFixed(2);
}

const SUBSCRIPTION_COLUMNS =
  "status,payment_method,started_at,current_period_start,current_period_end,canceled_at,suspended_at,expired_at," +
  "price:plan_prices(billing_period,currency,amount,plan:plan_catalog(code))";

export function toSubscriptionSummary(row: Row): OrganizationSubscriptionSummary {
  const price = Array.isArray(row.price) ? row.price[0] : row.price;
  const plan = Array.isArray(price?.plan) ? price.plan[0] : price?.plan;
  return {
    status: row.status,
    plan: plan?.code,
    billingPeriod: price?.billing_period,
    currency: price?.currency,
    amount: toDecimalString(price?.amount),
    paymentMethod: row.payment_method,
    startedAt: row.started_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at ?? null,
    suspendedAt: row.suspended_at ?? null,
    expiredAt: row.expired_at ?? null
  };
}

const OPEN_STATUSES: readonly SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "SUSPENDED"];

export function planRepository(db: SupabaseClient): PlanRepository {
  return {
    async entitlements(organizationId) {
      const rows = unwrap(await db.rpc("organization_entitlements", { p_organization_id: organizationId })) as Row[] | null;
      return toEntitlements(rows ?? []);
    },

    async usage(organizationId, keys = PLAN_USAGE_KEYS) {
      const rows = unwrap(
        await db.rpc("organization_usage", { p_organization_id: organizationId, p_keys: [...keys] })
      ) as Row[] | null;
      const usage: Partial<PlanUsage> = {};
      for (const row of rows ?? []) {
        if ((keys as readonly string[]).includes(row.key)) usage[row.key as PlanUsageKey] = Number(row.used);
      }
      return usage;
    },

    /** The open subscription, or else the most recent one. */
    async subscription(organizationId) {
      const rows = unwrap(
        await db
          .from("subscriptions")
          .select(SUBSCRIPTION_COLUMNS)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false })
          .limit(20)
      ) as Row[];
      const current = rows.find((row) => OPEN_STATUSES.includes(row.status)) ?? rows[0];
      return current ? toSubscriptionSummary(current) : null;
    }
  };
}
