import type { CommercialPlan, OrganizationEntitlements, OrganizationSubscriptionSummary } from "@emailbot/types";

/*
 * Commercial V1 phase 2: which card checkouts an organization may start.
 * Upgrades only (no automatic downgrade in this phase):
 *   no commercial access          -> any plan ("purchase")
 *   higher plan than the current  -> "upgrade" (BASIC -> PRO / BUSINESS, PRO -> BUSINESS)
 *   same plan                     -> allowed only to move a legacy / manually paid plan to card payments
 *   lower plan                    -> refused (downgrades are handled by the EmailBot team)
 *   a checkout already waiting    -> refused (no double charge)
 */

export type CheckoutDecision =
  | { ok: true; kind: "purchase" | "upgrade" }
  | { ok: false; status: 409; code: "CHECKOUT_IN_PROGRESS" | "PLAN_ALREADY_ACTIVE" | "DOWNGRADE_NOT_SUPPORTED"; message: string };

export function decideCheckout(input: {
  entitlements: OrganizationEntitlements;
  subscription: OrganizationSubscriptionSummary | null;
  target: CommercialPlan;
  order: Partial<Record<CommercialPlan, number>>;
  hasPending: boolean;
}): CheckoutDecision {
  if (input.hasPending) {
    return { ok: false, status: 409, code: "CHECKOUT_IN_PROGRESS", message: "A payment is already being confirmed for this organization" };
  }
  const current = input.entitlements.access === "NONE" ? null : input.entitlements.effectivePlan;
  if (!current) return { ok: true, kind: "purchase" };

  const from = input.order[current] ?? 0;
  const to = input.order[input.target] ?? 0;
  if (to > from) return { ok: true, kind: "upgrade" };
  if (to < from) return { ok: false, status: 409, code: "DOWNGRADE_NOT_SUPPORTED", message: "Changing to a lower plan is not available online" };

  // Same plan: only to start paying by card a plan granted as legacy or paid manually.
  const paidByCard = input.entitlements.access === "SUBSCRIPTION" && input.subscription?.paymentMethod === "CULQI";
  return paidByCard
    ? { ok: false, status: 409, code: "PLAN_ALREADY_ACTIVE", message: "This plan is already paid by card" }
    : { ok: true, kind: "purchase" };
}
