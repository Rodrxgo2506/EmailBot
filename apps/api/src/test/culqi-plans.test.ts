import { describe, expect, it, vi } from "vitest";
import { culqiPlanPayload, culqiPlanProblems, syncCulqiPlans, type CatalogPrice } from "../modules/billing/culqi-plans.js";

/*
 * Commercial V1 phase 2: the Culqi plans are created FROM the EmailBot catalog
 * (6 prices: BASIC / PRO / BUSINESS x monthly / yearly) and checked against it.
 */

const CATALOG: CatalogPrice[] = [
  { planPriceId: "p1", plan: "BASIC", planName: "Básico", billingPeriod: "MONTHLY", currency: "PEN", amountCents: 1990 },
  { planPriceId: "p2", plan: "BASIC", planName: "Básico", billingPeriod: "YEARLY", currency: "PEN", amountCents: 19900 },
  { planPriceId: "p3", plan: "PRO", planName: "Pro", billingPeriod: "MONTHLY", currency: "PEN", amountCents: 3990 },
  { planPriceId: "p4", plan: "PRO", planName: "Pro", billingPeriod: "YEARLY", currency: "PEN", amountCents: 39900 },
  { planPriceId: "p5", plan: "BUSINESS", planName: "Business", billingPeriod: "MONTHLY", currency: "PEN", amountCents: 8990 },
  { planPriceId: "p6", plan: "BUSINESS", planName: "Business", billingPeriod: "YEARLY", currency: "PEN", amountCents: 89900 }
];

describe("EmailBot price -> Culqi plan", () => {
  it("monthly = interval_unit_time 3, yearly = 4; amount in céntimos from the catalog; open-ended (interval_count 0)", () => {
    expect(CATALOG.map((price) => [price.plan, price.billingPeriod, culqiPlanPayload(price).amount, culqiPlanPayload(price).interval_unit_time])).toEqual([
      ["BASIC", "MONTHLY", 1990, 3],
      ["BASIC", "YEARLY", 19900, 4],
      ["PRO", "MONTHLY", 3990, 3],
      ["PRO", "YEARLY", 39900, 4],
      ["BUSINESS", "MONTHLY", 8990, 3],
      ["BUSINESS", "YEARLY", 89900, 4]
    ]);
    const payload = culqiPlanPayload(CATALOG[2] as CatalogPrice);
    expect(payload).toMatchObject({ name: "EmailBot Pro mensual", short_name: "emailbot-pro-mensual", currency: "PEN", interval_count: 0, metadata: { emailbot_plan_price_id: "p3" } });
    for (const price of CATALOG) {
      const value = culqiPlanPayload(price);
      expect(value.name.length).toBeGreaterThanOrEqual(5);
      expect(value.short_name.length).toBeLessThanOrEqual(50);
    }
  });

  it("verification: amount, currency and interval must match the catalog", () => {
    const pro = CATALOG[2] as CatalogPrice;
    expect(culqiPlanProblems(pro, { id: "pln_test_A", amount: 3990, currency: "PEN", interval_unit_time: 3 })).toEqual([]);
    expect(culqiPlanProblems(pro, { id: "pln_test_A", amount: 2990, currency: "USD", interval_unit_time: 4 })).toEqual([
      "amount 2990 != 3990",
      "currency USD != PEN",
      "interval_unit_time 4 != 3"
    ]);
    expect(culqiPlanProblems(pro, null)).toEqual(["not found at Culqi"]);
  });

  it("dry run creates nothing; apply creates only the missing plans and stores each mapping", async () => {
    const culqi = {
      getPlan: vi.fn(async () => ({ id: "pln_test_PROM", amount: 3990, currency: "PEN", interval_unit_time: 3 })),
      createPlan: vi.fn(async (input: { short_name: string }) => ({ id: `pln_test_${input.short_name.replace(/-/g, "")}` }))
    };
    const save = vi.fn(async () => undefined);
    const mapped = new Map([["p3", "pln_test_PROM"]]);

    const dry = await syncCulqiPlans({ prices: CATALOG, mapped, culqi, apply: false, save });
    expect(dry.map((item) => item.action)).toEqual(["CREATE", "CREATE", "OK", "CREATE", "CREATE", "CREATE"]);
    expect(culqi.createPlan).not.toHaveBeenCalled();

    const applied = await syncCulqiPlans({ prices: CATALOG, mapped, culqi, apply: true, save });
    expect(applied.map((item) => item.action)).toEqual(["CREATED", "CREATED", "OK", "CREATED", "CREATED", "CREATED"]);
    expect(culqi.createPlan).toHaveBeenCalledTimes(5);
    expect(save).toHaveBeenCalledWith("p1", "pln_test_emailbotbasicmensual");
  });
});
