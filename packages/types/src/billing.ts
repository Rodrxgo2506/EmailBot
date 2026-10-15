import type { BillingPeriod, CommercialPlan } from "./plans.js";

/*
 * Commercial V1 phase 2: Culqi recurring subscriptions (SANDBOX ONLY in this
 * phase). The provider side never grants access by itself: access comes from
 * the EmailBot subscription, activated only on a confirmed payment.
 */

/** Mirrors public.billing_subscription_status (provider side of a Culqi subscription). */
export const BILLING_SUBSCRIPTION_STATUSES = ["PENDING", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED", "FAILED", "REVIEW_REQUIRED"] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

export type BillingEnvironment = "test" | "live";

/** GET /api/billing/config: whether card checkout is available (and in which Culqi environment). */
export interface BillingConfig {
  enabled: boolean;
  environment: BillingEnvironment | null;
}

/** GET /api/billing/checkout: what the browser needs to open Culqi Custom Checkout. Price resolved by the API. */
export interface BillingCheckoutOptions {
  /** Culqi PUBLIC key (pk_test_ in this phase). */
  publicKey: string;
  environment: BillingEnvironment;
  plan: CommercialPlan;
  planName: string;
  billingPeriod: BillingPeriod;
  currency: string;
  /** Major units, decimal string ("39.90"); IGV included. */
  amount: string;
  /** Minor units (céntimos): Culqi Custom Checkout's settings.amount. */
  amountCents: number;
  /** "upgrade" from the current plan, or a first "purchase". */
  kind: "purchase" | "upgrade";
  customerEmail: string | null;
}

/** A Culqi subscription of the organization as its members see it. */
export interface BillingSubscriptionSummary {
  id: string;
  status: BillingSubscriptionStatus;
  plan: CommercialPlan;
  billingPeriod: BillingPeriod;
  environment: BillingEnvironment;
  createdAt: string;
  activatedAt: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  cancelReason: "USER" | "PROVIDER" | "UPGRADED" | null;
  /** Culqi's code / message of a declined charge (no card data). */
  failureCode: string | null;
  failureMessage: string | null;
}

/** POST /api/billing/subscriptions: the Culqi subscription was created; confirmation arrives asynchronously. */
export interface BillingCheckoutResult {
  billingSubscription: BillingSubscriptionSummary;
}
