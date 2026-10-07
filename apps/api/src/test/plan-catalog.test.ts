import { COMMERCIAL_PLANS, PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS, type CommercialPlan, type PlanCatalogEntry } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { toPlanCatalog } from "../repositories/supabase/plan-repositories.js";
import { createTestApp } from "./helpers.js";
import { V1_FEATURES, V1_LIMITS } from "./plan-fixtures.js";

/*
 * Commercial V1: the public plan catalog (GET /api/plans) behind the pricing
 * page. Read-only, no session, the same for everyone; the values are the
 * database catalog (checked against the migration seed in
 * packages/database/test/plan-catalog.test.ts).
 */

const PRICES: Record<CommercialPlan, { MONTHLY: string; YEARLY: string }> = {
  BASIC: { MONTHLY: "19.90", YEARLY: "199.00" },
  PRO: { MONTHLY: "39.90", YEARLY: "399.00" },
  BUSINESS: { MONTHLY: "89.90", YEARLY: "899.00" }
};

/** One plan_catalog row as PostgREST embeds it (numeric / bigint may come as strings). */
function catalogRow(code: string, sortOrder: number, overrides: Record<string, unknown> = {}) {
  const plan = code as CommercialPlan;
  return {
    code,
    name: code === "BASIC" ? "Básico" : code === "PRO" ? "Pro" : "Business",
    description: null,
    badge: code === "PRO" ? "Más elegido" : null,
    sort_order: sortOrder,
    prices: [
      { billing_period: "YEARLY", currency: "PEN", amount: PRICES[plan]?.YEARLY ?? "1.00", amount_cents: 0, active: true },
      { billing_period: "MONTHLY", currency: "PEN", amount: Number(PRICES[plan]?.MONTHLY ?? 1), amount_cents: Math.round(Number(PRICES[plan]?.MONTHLY ?? 1) * 100), active: true },
      { billing_period: "MONTHLY", currency: "PEN", amount: "9.90", amount_cents: 990, active: false }
    ],
    entitlements: [
      ...PLAN_LIMIT_KEYS.map((key) => ({ key, kind: "LIMIT", limit_value: String(V1_LIMITS[plan]?.[key] ?? 0), enabled: null })),
      ...PLAN_FEATURE_KEYS.map((key) => ({ key, kind: "FEATURE", limit_value: null, enabled: V1_FEATURES[plan]?.[key] ?? false })),
      { key: "FUTURE_LIMIT", kind: "LIMIT", limit_value: 1, enabled: null }
    ],
    ...overrides
  };
}

describe("toPlanCatalog (database rows -> public catalog)", () => {
  it("maps the three commercial plans in sort order, with active prices only (monthly first) and every limit / feature", () => {
    const catalog = toPlanCatalog([catalogRow("BUSINESS", 3), catalogRow("BASIC", 1), catalogRow("PRO", 2)]);

    expect(catalog.map((plan) => plan.code)).toEqual([...COMMERCIAL_PLANS]);
    for (const plan of catalog) {
      expect(plan.prices.map((price) => [price.billingPeriod, price.amount])).toEqual([
        ["MONTHLY", PRICES[plan.code].MONTHLY],
        ["YEARLY", PRICES[plan.code].YEARLY]
      ]);
      expect(plan.prices.every((price) => price.currency === "PEN")).toBe(true);
      expect(plan.limits).toEqual(V1_LIMITS[plan.code]);
      expect(plan.features).toEqual(V1_FEATURES[plan.code]);
      expect(plan.limits).not.toHaveProperty("FUTURE_LIMIT");
    }
    expect(catalog.find((plan) => plan.code === "PRO")).toMatchObject({ badge: "Más elegido", prices: [{ amount: "39.90", amountCents: 3990 }, { amount: "399.00" }] });
  });

  it("fails closed and never offers a legacy plan: missing limit 0, missing feature off, FREE dropped", () => {
    const catalog = toPlanCatalog([catalogRow("FREE", 0), catalogRow("BASIC", 1, { entitlements: [], prices: [] })]);
    expect(catalog.map((plan) => plan.code)).toEqual(["BASIC"]);
    expect(catalog[0]?.limits.EMAIL_ACCOUNTS).toBe(0);
    expect(catalog[0]?.features.GMAIL).toBe(false);
    expect(catalog[0]?.prices).toEqual([]);
  });
});

describe("GET /api/plans (public)", () => {
  it("answers without a session or organization, cacheable, from the database catalog only", async () => {
    const { app, privileged } = await createTestApp({ users: [] });
    const items: PlanCatalogEntry[] = toPlanCatalog([catalogRow("BASIC", 1), catalogRow("PRO", 2), catalogRow("BUSINESS", 3)]);
    privileged.listPlanCatalog.mockResolvedValue(items);

    const response = await app.inject({ method: "GET", url: "/api/plans" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(response.json()).toEqual({ items });
    expect(privileged.listPlanCatalog).toHaveBeenCalledTimes(1);
  });

  it("is read-only: other methods are not routed", async () => {
    const { app, privileged } = await createTestApp({ users: [] });
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/plans", payload: {} });
      expect(response.statusCode, method).toBe(404);
    }
    expect(privileged.listPlanCatalog).not.toHaveBeenCalled();
  });
});
