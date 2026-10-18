import { CULQI_INTERVAL_UNIT, CULQI_PLAN_INTERVAL_COUNT, culqiAmountToCents, type CulqiClient, type CulqiPlan } from "@emailbot/shared";
import type { BillingPeriod } from "@emailbot/types";

/*
 * Commercial V1 phase 2: EmailBot price -> Culqi plan (POST /v2/recurrent/plans/create).
 * EmailBot stays the source of the price: the Culqi plan is created FROM the
 * catalog row and verified against it before every checkout.
 *
 * Verified in the Culqi sandbox (plans created and read back): monthly =
 * interval_unit_time 3, yearly = 4, interval_count 1 (one unit between
 * charges), initial_cycles with the same unit and no initial charge (the shared
 * client sends them). interval_count 0 is never used for EmailBot plans.
 *
 * The sandbox rejected a description with punctuation ("(...)." -> 400
 * parameter_error) and accepted plain letters / digits / spaces, so
 * descriptions go through culqiSafeDescription.
 */

const DESCRIPTION_MIN = 5;
const DESCRIPTION_MAX = 200;

/**
 * Culqi-compatible description (deterministic): accents removed (Suscripción -> Suscripcion), anything other than
 * ASCII letters, digits and spaces becomes a space, spaces collapsed, cut at a word boundary to 200 characters.
 * Throws when fewer than 5 characters remain (never padded with invented text).
 */
export function culqiSafeDescription(text: string): string {
  const plain = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let safe = plain;
  if (safe.length > DESCRIPTION_MAX) {
    const cut = safe.slice(0, DESCRIPTION_MAX + 1);
    const lastSpace = cut.lastIndexOf(" ");
    safe = (lastSpace >= DESCRIPTION_MIN ? cut.slice(0, lastSpace) : cut.slice(0, DESCRIPTION_MAX)).trim();
  }
  if (safe.length < DESCRIPTION_MIN) throw new Error(`Culqi plan description too short after sanitizing: "${safe}"`);
  return safe;
}

/** A plan name whose meaning would change in the description (symbols such as "+" or "&") is refused, not rewritten. */
function assertPlainPlanName(planName: string): void {
  if (!/^[\p{L}\p{N} -]+$/u.test(planName)) throw new Error(`Plan name "${planName}" has characters Culqi descriptions do not accept; rename it in the catalog first`);
}

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
  assertPlainPlanName(price.planName);
  return {
    // Culqi: name / short_name 5-50 characters, description 5-200 (plain text, see culqiSafeDescription).
    name: `EmailBot ${price.planName} ${PERIOD_LABEL[price.billingPeriod]}`.slice(0, 50),
    short_name: `emailbot-${price.plan.toLowerCase()}-${price.billingPeriod === "MONTHLY" ? "mensual" : "anual"}`.slice(0, 50),
    description: culqiSafeDescription(`Suscripción ${PERIOD_LABEL[price.billingPeriod]} al plan ${price.planName} de EmailBot IGV incluido`),
    amount: price.amountCents,
    currency: price.currency,
    interval_unit_time: CULQI_INTERVAL_UNIT[price.billingPeriod],
    interval_count: CULQI_PLAN_INTERVAL_COUNT,
    metadata: { emailbot_plan_price_id: price.planPriceId, emailbot_plan: price.plan, emailbot_billing_period: price.billingPeriod }
  };
}

/** Problems of a Culqi plan against the EmailBot price (empty = it matches). */
export function culqiPlanProblems(price: CatalogPrice, plan: CulqiPlan | null): string[] {
  if (!plan) return ["not found at Culqi"];
  const problems: string[] = [];
  if (culqiAmountToCents(plan.amount) !== price.amountCents) problems.push(`amount ${plan.amount} != ${price.amountCents}`);
  if (plan.currency !== price.currency) problems.push(`currency ${plan.currency} != ${price.currency}`);
  if (Number(plan.interval_unit_time) !== CULQI_INTERVAL_UNIT[price.billingPeriod]) problems.push(`interval_unit_time ${plan.interval_unit_time} != ${CULQI_INTERVAL_UNIT[price.billingPeriod]}`);
  // Culqi returns interval_count on GET (verified in the sandbox); an already mapped plan with 0 is reported.
  if (plan.interval_count !== undefined && Number(plan.interval_count) !== CULQI_PLAN_INTERVAL_COUNT) problems.push(`interval_count ${plan.interval_count} != ${CULQI_PLAN_INTERVAL_COUNT}`);
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
