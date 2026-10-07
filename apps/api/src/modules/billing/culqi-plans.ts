import { CULQI_INTERVAL_UNIT, type CulqiClient, type CulqiPlan } from "@emailbot/shared";
import type { BillingPeriod } from "@emailbot/types";

/*
 * Commercial V1 phase 2: EmailBot price -> Culqi plan (POST /v2/recurrent/plans/create).
 * EmailBot stays the source of the price: the Culqi plan is created FROM the
 * catalog row and verified against it before every checkout.
 *
 * interval_count: Culqi documents it as "Cantidad de intervalos entre cada
 * cargo. Si envía el 0 se cobrará de forma indefinida", so 0 is sent for an
 * open-ended monthly / yearly subscription. To be confirmed in the sandbox
 * (docs/billing-culqi.md, "Puntos a confirmar").
 */

export interface CatalogPrice {
  planPriceId: string;
  plan: string;
  planName: string;
  billingPeriod: BillingPeriod;
  currency: string;
  amountCents: number;
}

const PERIOD_LABEL: Record<BillingPeriod, string> = { MONTHLY: "mensual", YEARLY: "anual" };

export function culqiPlanPayload(price: CatalogPrice) {
  return {
    // Culqi: name / short_name 5-50 characters, description 5-200.
    name: `EmailBot ${price.planName} ${PERIOD_LABEL[price.billingPeriod]}`.slice(0, 50),
    short_name: `emailbot-${price.plan.toLowerCase()}-${price.billingPeriod === "MONTHLY" ? "mensual" : "anual"}`.slice(0, 50),
    description: `Suscripción ${PERIOD_LABEL[price.billingPeriod]} al plan ${price.planName} de EmailBot (IGV incluido).`.slice(0, 200),
    amount: price.amountCents,
    currency: price.currency,
    interval_unit_time: CULQI_INTERVAL_UNIT[price.billingPeriod],
    interval_count: 0,
    metadata: { emailbot_plan_price_id: price.planPriceId, emailbot_plan: price.plan, emailbot_billing_period: price.billingPeriod }
  };
}

/** Problems of a Culqi plan against the EmailBot price (empty = it matches). */
export function culqiPlanProblems(price: CatalogPrice, plan: CulqiPlan | null): string[] {
  if (!plan) return ["not found at Culqi"];
  const problems: string[] = [];
  if (Number(plan.amount) !== price.amountCents) problems.push(`amount ${plan.amount} != ${price.amountCents}`);
  if (plan.currency !== price.currency) problems.push(`currency ${plan.currency} != ${price.currency}`);
  if (Number(plan.interval_unit_time) !== CULQI_INTERVAL_UNIT[price.billingPeriod]) problems.push(`interval_unit_time ${plan.interval_unit_time} != ${CULQI_INTERVAL_UNIT[price.billingPeriod]}`);
  return problems;
}

export type PlanSyncAction =
  | { price: CatalogPrice; action: "OK"; externalPlanId: string }
  | { price: CatalogPrice; action: "MISMATCH"; externalPlanId: string; problems: string[] }
  | { price: CatalogPrice; action: "CREATE" }
  | { price: CatalogPrice; action: "CREATED"; externalPlanId: string };

/**
 * One action per active EmailBot price. `apply` creates the missing Culqi plans
 * (and calls `save` for each); without it nothing is created (dry run).
 */
export async function syncCulqiPlans(input: {
  prices: CatalogPrice[];
  mapped: Map<string, string>;
  culqi: Pick<CulqiClient, "getPlan" | "createPlan">;
  apply: boolean;
  save(planPriceId: string, externalPlanId: string): Promise<void>;
}): Promise<PlanSyncAction[]> {
  const actions: PlanSyncAction[] = [];
  for (const price of input.prices) {
    const existing = input.mapped.get(price.planPriceId);
    if (existing) {
      const problems = culqiPlanProblems(price, await input.culqi.getPlan(existing));
      actions.push(problems.length === 0 ? { price, action: "OK", externalPlanId: existing } : { price, action: "MISMATCH", externalPlanId: existing, problems });
      continue;
    }
    if (!input.apply) {
      actions.push({ price, action: "CREATE" });
      continue;
    }
    const created = await input.culqi.createPlan(culqiPlanPayload(price));
    await input.save(price.planPriceId, created.id);
    actions.push({ price, action: "CREATED", externalPlanId: created.id });
  }
  return actions;
}
