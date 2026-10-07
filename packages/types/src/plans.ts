import type { OrganizationPlan } from "./enums.js";

/*
 * Commercial V1: plans, limits and features (EmailBot commercial phase 1).
 *
 * The VALUES (prices, limits, which plan has which feature) live only in the
 * database (public.plan_catalog / plan_prices / plan_entitlements, seeded by
 * supabase/migrations/20261006120100_plan_catalog.sql) and reach the code
 * through public.organization_entitlements(). This file only names the keys
 * the code knows: a new limit or feature is a new key here plus new rows.
 */

/** Plans sold since Commercial V1 (public.plan_catalog). There is no free plan. */
export const COMMERCIAL_PLANS = ["BASIC", "PRO", "BUSINESS"] as const;
export type CommercialPlan = (typeof COMMERCIAL_PLANS)[number];

/** Pre Commercial V1 value kept by old organizations; entitled as BASIC, never assigned again. */
export const LEGACY_PLANS = ["FREE"] as const satisfies readonly OrganizationPlan[];

export function isCommercialPlan(plan: string): plan is CommercialPlan {
  return (COMMERCIAL_PLANS as readonly string[]).includes(plan);
}

export const BILLING_PERIODS = ["MONTHLY", "YEARLY"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** Quantitative limits (plan_entitlements kind LIMIT). Storage in bytes, retention in days. */
export const PLAN_LIMIT_KEYS = [
  "EMAIL_ACCOUNTS",
  "RULES",
  "BOTS",
  "MONTHLY_EMAILS",
  "MEMBERS",
  "CUSTOMERS",
  "STORAGE_BYTES",
  "RETENTION_DAYS"
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** Boolean features (plan_entitlements kind FEATURE). */
export const PLAN_FEATURE_KEYS = ["GMAIL", "MICROSOFT", "ADVANCED_STATS", "PORTAL", "API", "PRIORITY_SUPPORT"] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];

/** Limits with a measured usage (public.organization_usage). RETENTION_DAYS is a duration, not a count. */
export const PLAN_USAGE_KEYS = [
  "EMAIL_ACCOUNTS",
  "RULES",
  "BOTS",
  "MONTHLY_EMAILS",
  "MEMBERS",
  "CUSTOMERS",
  "STORAGE_BYTES"
] as const satisfies readonly PlanLimitKey[];
export type PlanUsageKey = (typeof PLAN_USAGE_KEYS)[number];

/*
 * Commercial V1.1: EmailBot is a paid service. The commercial access of an
 * organization comes from its subscription (public.subscriptions), never
 * from organizations.plan (a cache written only by the subscription logic).
 */

/** Mirrors public.subscription_status. Open = ACTIVE / PAST_DUE / SUSPENDED; CANCELED / EXPIRED are terminal. */
export const SUBSCRIPTION_STATUSES = ["ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELED", "EXPIRED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Mirrors public.payment_method. */
export const PAYMENT_METHODS = ["CULQI", "YAPE", "CASH", "TRANSFER", "MANUAL"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Payments the Super Admin registers by hand (CULQI only comes from the payment provider). */
export const MANUAL_PAYMENT_METHODS = ["YAPE", "CASH", "TRANSFER", "MANUAL"] as const satisfies readonly PaymentMethod[];
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

/** Mirrors public.subscription_origin. */
export const SUBSCRIPTION_ORIGINS = ["ADMIN", "CULQI"] as const;
export type SubscriptionOrigin = (typeof SUBSCRIPTION_ORIGINS)[number];

/** Super Admin actions on a subscription (POST /api/admin/subscriptions/:id/:action). */
export const SUBSCRIPTION_ACTIONS = ["suspend", "reactivate", "cancel", "expire"] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

/**
 * Where the entitlements come from:
 *  - SUBSCRIPTION: an ACTIVE subscription whose period has not ended;
 *  - LEGACY: an organization created before subscriptions that never had one (FREE -> BASIC);
 *  - NONE: no commercial access (no subscription, or not ACTIVE, or its period ended).
 */
export const PLAN_ACCESS = ["SUBSCRIPTION", "LEGACY", "NONE"] as const;
export type PlanAccess = (typeof PLAN_ACCESS)[number];

/** What an organization may do. A limit of null means unlimited; with access NONE every limit is 0 and every feature off. */
export interface OrganizationEntitlements {
  /** Stored organizations.plan cache (may be the legacy FREE, or null). */
  plan: OrganizationPlan | null;
  /** Plan whose entitlements apply; null when access is NONE. */
  effectivePlan: CommercialPlan | null;
  access: PlanAccess;
  /** Status of the open (or else latest) subscription; null = never subscribed. */
  subscriptionStatus: SubscriptionStatus | null;
  limits: Record<PlanLimitKey, number | null>;
  features: Record<PlanFeatureKey, boolean>;
}

export type PlanUsage = Record<PlanUsageKey, number>;

/** The organization's current (open, or else latest) subscription as its members see it. */
export interface OrganizationSubscriptionSummary {
  status: SubscriptionStatus;
  plan: CommercialPlan;
  billingPeriod: BillingPeriod;
  currency: string;
  /** List price of the plan price, major units as a decimal string ("39.90"); IGV included. */
  amount: string;
  paymentMethod: PaymentMethod;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  canceledAt: string | null;
  suspendedAt: string | null;
  expiredAt: string | null;
}

/** GET /api/organizations/current/plan */
export interface OrganizationPlanOverview {
  entitlements: OrganizationEntitlements;
  usage: PlanUsage;
  subscription: OrganizationSubscriptionSummary | null;
}

/* ------------------------------------------------------------ Super Admin */

export interface AdminPlanPrice {
  id: string;
  plan: CommercialPlan;
  planName: string;
  billingPeriod: BillingPeriod;
  currency: string;
  /** Decimal string ("39.90"), IGV included. */
  amount: string;
  amountCents: number;
}

export interface AdminSubscription extends Omit<OrganizationSubscriptionSummary, "amount"> {
  id: string;
  /** List price of the plan price (decimal string). */
  listAmount: string;
  origin: SubscriptionOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPaymentEvent {
  id: string;
  subscriptionId: string | null;
  eventType: string;
  paymentMethod: PaymentMethod;
  /** Decimal string or null. */
  amount: string | null;
  currency: string;
  status: "RECEIVED" | "PROCESSED" | "IGNORED" | "FAILED";
  /** Provider event id, or "<method>:<reference>" for a manual payment. */
  reference: string | null;
  note: string | null;
  occurredAt: string;
  processedAt: string | null;
}

/** POST /api/admin/organizations/:id/subscription/activate */
export interface AdminSubscriptionActivation {
  plan: CommercialPlan;
  billingPeriod: BillingPeriod;
  paymentMethod: ManualPaymentMethod;
  /** Amount received, decimal string in PEN ("39.90"). */
  amount: string;
  periodStart: string;
  periodEnd: string;
  reference?: string | undefined;
  note?: string | undefined;
}

export type SubscriptionActivationOutcome = "ACTIVATED" | "RENEWED" | "PLAN_CHANGED";

/** Details of a 403 PLAN_LIMIT_REACHED error. */
export interface PlanLimitErrorDetails {
  limit: PlanUsageKey;
  max: number;
  used: number;
  plan: CommercialPlan;
}

/** Details of a 403 PLAN_FEATURE_UNAVAILABLE error. */
export interface PlanFeatureErrorDetails {
  feature: PlanFeatureKey;
  plan: CommercialPlan;
}
