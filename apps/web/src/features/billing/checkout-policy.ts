import type { PaymentMethod, PlanAccess } from "@emailbot/types";

/**
 * The organization may start a card checkout for the plan it already has: a legacy plan or one paid manually
 * (Yape, cash, transfer...) moves to card payments. A plan already paid with Culqi is not offered again. Mirrors the
 * same-plan rule of decideCheckout in the API (apps/api/src/modules/billing/policy.ts), which decides in the end.
 */
export function canPayCurrentPlanByCard(access: PlanAccess, paymentMethod: PaymentMethod | null | undefined): boolean {
  return access !== "NONE" && !(access === "SUBSCRIPTION" && paymentMethod === "CULQI");
}
