import { createCulqiClient } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { culqiPlanPayload, culqiPlanProblems, culqiSafeDescription, syncCulqiPlans, type CatalogPrice } from "../modules/billing/culqi-plans.js";

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
  it("monthly = interval_unit_time 3, yearly = 4; amount in céntimos from the catalog; every 1 unit (interval_count 1)", () => {
    expect(CATALOG.map((price) => [price.plan, price.billingPeriod, culqiPlanPayload(price).amount, culqiPlanPayload(price).interval_unit_time])).toEqual([
      ["BASIC", "MONTHLY", 1990, 3],
      ["BASIC", "YEARLY", 19900, 4],
      ["PRO", "MONTHLY", 3990, 3],
      ["PRO", "YEARLY", 39900, 4],
      ["BUSINESS", "MONTHLY", 8990, 3],
      ["BUSINESS", "YEARLY", 89900, 4]
    ]);
    const payload = culqiPlanPayload(CATALOG[2] as CatalogPrice);
    expect(payload).toMatchObject({ name: "EmailBot Pro mensual", short_name: "emailbot-pro-mensual", currency: "PEN", interval_count: 1, metadata: { emailbot_plan_price_id: "p3" } });
    for (const price of CATALOG) {
      const value = culqiPlanPayload(price);
      expect(value.name.length).toBeGreaterThanOrEqual(5);
      expect(value.short_name.length).toBeLessThanOrEqual(50);
    }
  });

  it("all 6 plans charge every 1 unit (never interval_count 0); the unit follows the period", () => {
    for (const price of CATALOG) {
      const payload = culqiPlanPayload(price);
      expect(payload.interval_count).toBe(1);
      expect(payload.interval_unit_time).toBe(price.billingPeriod === "MONTHLY" ? 3 : 4);
    }
    expect(CATALOG.some((price) => culqiPlanPayload(price).interval_count === 0)).toBe(false);
  });

  it.each([
    ["MONTHLY", 3],
    ["YEARLY", 4]
  ] as const)("%s: the body sent to POST /v2/recurrent/plans/create has initial_cycles in the same unit, no initial charge", async (period, unit) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "pln_test_ABCDEF1234567890", slug: "s" }), { status: 201 });
    });
    const client = createCulqiClient({ secretKey: "sk_test_abcdefgh12345678", fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "https://culqi.example" });
    const price = CATALOG.find((item) => item.plan === "BASIC" && item.billingPeriod === period) as CatalogPrice;
    await client.createPlan(culqiPlanPayload(price));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://culqi.example/v2/recurrent/plans/create");
    expect(bodies[0]).toMatchObject({
      amount: price.amountCents,
      currency: "PEN",
      interval_unit_time: unit,
      interval_count: 1,
      initial_cycles: { count: 0, has_initial_charge: false, amount: 0, interval_unit_time: unit }
    });
  });

  it("descriptions: plain letters / digits / spaces, 5-200 characters, no punctuation", () => {
    expect(culqiPlanPayload(CATALOG[0] as CatalogPrice).description).toBe("Suscripcion mensual al plan Basico de EmailBot IGV incluido");
    expect(culqiPlanPayload(CATALOG[5] as CatalogPrice).description).toBe("Suscripcion anual al plan Business de EmailBot IGV incluido");
    for (const price of CATALOG) {
      const { description } = culqiPlanPayload(price);
      expect(description).toMatch(/^[A-Za-z0-9 ]+$/);
      expect(description.length).toBeGreaterThanOrEqual(5);
      expect(description.length).toBeLessThanOrEqual(200);
      expect(description).not.toMatch(/[().]/);
    }
  });

  it("a plan name with symbols is refused instead of being silently rewritten", () => {
    expect(() => culqiPlanPayload({ ...(CATALOG[2] as CatalogPrice), planName: "Pro+" })).toThrow(/rename it in the catalog/);
    expect(() => culqiPlanPayload({ ...(CATALOG[2] as CatalogPrice), planName: "Pro Plus" })).not.toThrow();
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
    expect(culqiPlanProblems(pro, { id: "pln_test_A", amount: 3990, currency: "PEN", interval_unit_time: 3, interval_count: 1 })).toEqual([]);
    expect(culqiPlanProblems(pro, { id: "pln_test_A", amount: 3990, currency: "PEN", interval_unit_time: 3, interval_count: 0 })).toEqual(["interval_count 0 != 1"]);
  });
});

describe("culqiSafeDescription (Culqi rejected punctuation in the sandbox)", () => {
  it("the description Culqi rejected becomes plain text; the one it accepted is unchanged", () => {
    expect(culqiSafeDescription("Plan temporal de prueba EmailBot (sandbox). No usar en checkout.")).toBe("Plan temporal de prueba EmailBot sandbox No usar en checkout");
    expect(culqiSafeDescription("Plan temporal de prueba EmailBot sandbox")).toBe("Plan temporal de prueba EmailBot sandbox");
  });

  it("the previous EmailBot description is no longer sent literally", () => {
    expect(culqiSafeDescription("Suscripción mensual al plan Básico de EmailBot (IGV incluido).")).toBe("Suscripcion mensual al plan Basico de EmailBot IGV incluido");
  });

  it("accents removed, symbols to spaces, spaces collapsed, deterministic", () => {
    expect(culqiSafeDescription("  Año   ñandú, «Pro»/Business!  ")).toBe("Ano nandu Pro Business");
    expect(culqiSafeDescription("Plan\tPRO\n2026")).toBe("Plan PRO 2026");
    expect(culqiSafeDescription("Plan Pro: 39.90")).toBe(culqiSafeDescription("Plan Pro: 39.90"));
  });

  it("at most 200 characters, cut at a word boundary", () => {
    const long = Array.from({ length: 60 }, (_, index) => `palabra${index}`).join(" ");
    const safe = culqiSafeDescription(long);
    expect(safe.length).toBeLessThanOrEqual(200);
    expect(long.startsWith(safe)).toBe(true);
    expect(long.charAt(safe.length)).toBe(" ");
    expect(culqiSafeDescription("x".repeat(250))).toHaveLength(200);
  });

  it("fewer than 5 characters left -> error (never padded)", () => {
    expect(() => culqiSafeDescription("(!).")).toThrow(/too short/);
    expect(() => culqiSafeDescription("Pro.")).toThrow(/too short/);
    expect(culqiSafeDescription("Pro 1")).toBe("Pro 1");
  });

  it("the mapped BÁSICO mensual plan returned by Culqi as 1989.9999999999998 céntimos is OK, not MISMATCH", async () => {
    const basic = CATALOG[0] as CatalogPrice;
    const culqiBasic = { id: "pln_test_R4OkGMwJmYgatc1y", amount: 1989.9999999999998, currency: "PEN", interval_unit_time: 3, interval_count: 1 };
    expect(culqiPlanProblems(basic, culqiBasic)).toEqual([]);
    expect(culqiPlanProblems(basic, { ...culqiBasic, amount: 1989 })).toEqual(["amount 1989 != 1990"]);

    const culqi = { getPlan: vi.fn(async () => culqiBasic), createPlan: vi.fn() };
    const actions = await syncCulqiPlans({ prices: [basic], mapped: new Map([["p1", culqiBasic.id]]), culqi, apply: false, save: vi.fn() });
    expect(actions).toEqual([{ price: basic, action: "OK", externalPlanId: "pln_test_R4OkGMwJmYgatc1y" }]);
    expect(culqi.createPlan).not.toHaveBeenCalled();
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
