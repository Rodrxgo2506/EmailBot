import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogEntry, PLAN_CATALOG } from "@/test/plan-catalog-fixture";
import { comparisonGroups, formatLimit, formatPrice, monthlyPrice, myPlanOptions, planCta, upgradeBenefits, upgradeOptions } from "./plans-model";

describe("plans model (catalog from GET /api/plans)", () => {
  it("prices come from the catalog's decimal strings, in soles", () => {
    expect(PLAN_CATALOG.map((plan) => formatPrice(monthlyPrice(plan)!))).toEqual(["S/ 19.90", "S/ 39.90", "S/ 89.90"]);
    expect(monthlyPrice(catalogEntry("PRO"))).toMatchObject({ currency: "PEN", amountCents: 3990 });
  });

  it("formats limits (storage in GB, unlimited)", () => {
    expect(formatLimit("STORAGE_BYTES", 5 * 1024 ** 3)).toBe("5 GB");
    expect(formatLimit("MONTHLY_EMAILS", 75_000)).toBe("75,000");
    expect(formatLimit("RULES", null)).toBe("Ilimitado");
  });

  it("comparison: only what the product has (no retention, statistics, API or support tiers yet)", () => {
    const groups = comparisonGroups(PLAN_CATALOG);
    expect(groups.map((group) => group.title)).toEqual(["Correo", "Automatización", "Clientes y portal", "Equipo", "Almacenamiento"]);
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.key === "MICROSOFT")?.values).toEqual([false, true, true]);
    expect(rows.find((row) => row.key === "PORTAL")?.values).toEqual([false, true, true]);
    expect(rows.find((row) => row.key === "EMAIL_ACCOUNTS")?.values).toEqual(["25", "125", "250"]);
    expect(rows.map((row) => row.key)).not.toEqual(expect.arrayContaining(["RETENTION_DAYS"]));
    expect(rows.some((row) => ["RETENTION_DAYS", "ADVANCED_STATS", "API", "PRIORITY_SUPPORT"].includes(row.key))).toBe(false);
  });

  it("calls to action: sign-up when anonymous; current / lower / upgrade with a plan; choose without one", () => {
    const pro = catalogEntry("PRO");
    expect(planCta(pro, { authenticated: false }, PLAN_CATALOG)).toEqual({ kind: "REGISTER", label: "Crear cuenta", to: "/register" });
    expect(planCta(pro, { authenticated: true, currentPlan: "PRO" }, PLAN_CATALOG).kind).toBe("CURRENT");
    expect(planCta(pro, { authenticated: true, currentPlan: "BUSINESS" }, PLAN_CATALOG).kind).toBe("LOWER");
    expect(planCta(pro, { authenticated: true, currentPlan: "BASIC" }, PLAN_CATALOG)).toEqual({ kind: "CHOOSE", label: "Mejorar a Pro" });
    expect(planCta(pro, { authenticated: true, currentPlan: null }, PLAN_CATALOG)).toEqual({ kind: "CHOOSE", label: "Elegir Pro" });
  });

  it("the current plan: 'Tu plan actual', or 'Pagar … con tarjeta' when it can move to card payments (never 'Mejorar a')", () => {
    const basic = catalogEntry("BASIC");
    expect(planCta(basic, { authenticated: true, currentPlan: "BASIC", canPayCurrentByCard: true }, PLAN_CATALOG)).toEqual({ kind: "PAY_BY_CARD", label: "Pagar Básico con tarjeta" });
    expect(planCta(basic, { authenticated: true, currentPlan: "BASIC", canPayCurrentByCard: false }, PLAN_CATALOG)).toEqual({ kind: "CURRENT", label: "Tu plan actual" });
    expect(planCta(basic, { authenticated: true, currentPlan: "BASIC" }, PLAN_CATALOG).kind).toBe("CURRENT");
    expect(planCta(catalogEntry("PRO"), { authenticated: true, currentPlan: "BASIC", canPayCurrentByCard: true }, PLAN_CATALOG)).toEqual({ kind: "CHOOSE", label: "Mejorar a Pro" });
    expect(planCta(basic, { authenticated: true, currentPlan: "PRO", canPayCurrentByCard: true }, PLAN_CATALOG).kind).toBe("LOWER");
  });

  it("Mi plan options: the current plan first when it can be paid by card, then the upgrades; every plan without access", () => {
    const summary = (options: ReturnType<typeof myPlanOptions>) => options.map((option) => `${option.plan.code}:${option.action}:${option.label}`);
    expect(summary(myPlanOptions(PLAN_CATALOG, "BASIC", true))).toEqual([
      "BASIC:PAY_BY_CARD:Pagar Básico con tarjeta",
      "PRO:UPGRADE:Mejorar a Pro",
      "BUSINESS:UPGRADE:Mejorar a Business"
    ]);
    expect(summary(myPlanOptions(PLAN_CATALOG, "BASIC", false))).toEqual(["PRO:UPGRADE:Mejorar a Pro", "BUSINESS:UPGRADE:Mejorar a Business"]);
    expect(summary(myPlanOptions(PLAN_CATALOG, "BUSINESS", false))).toEqual([]);
    expect(summary(myPlanOptions(PLAN_CATALOG, "BUSINESS", true))).toEqual(["BUSINESS:PAY_BY_CARD:Pagar Business con tarjeta"]);
    expect(summary(myPlanOptions(PLAN_CATALOG, null, false))).toEqual(["BASIC:CHOOSE:Elegir Básico", "PRO:CHOOSE:Elegir Pro", "BUSINESS:CHOOSE:Elegir Business"]);
  });

  it("upgrade options are the plans above the current one; none for the most complete", () => {
    expect(upgradeOptions(PLAN_CATALOG, "BASIC").map((plan) => plan.code)).toEqual(["PRO", "BUSINESS"]);
    expect(upgradeOptions(PLAN_CATALOG, "PRO").map((plan) => plan.code)).toEqual(["BUSINESS"]);
    expect(upgradeOptions(PLAN_CATALOG, "BUSINESS")).toEqual([]);
    expect(upgradeOptions(PLAN_CATALOG, null)).toHaveLength(3);
  });

  it("upgrade benefits: higher limits and new features only", () => {
    expect(upgradeBenefits(catalogEntry("BASIC"), catalogEntry("PRO"))).toEqual([
      "125 cuentas de correo",
      "15,000 correos procesados al mes",
      "30 reglas",
      "10 bots activos",
      "2,500 clientes activos",
      "5 miembros del equipo",
      "5 GB de almacenamiento de adjuntos",
      "Microsoft (Outlook / 365)",
      "Portal de clientes"
    ]);
    expect(upgradeBenefits(catalogEntry("PRO"), catalogEntry("BUSINESS"))).not.toContain("Portal de clientes");
  });

  it("no payment provider is referenced by the plans feature, and the only endpoint it calls is the public catalog", () => {
    const dir = join(__dirname);
    for (const file of readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/culqi|tokeniz|card_?number/i);
      expect(source.match(/["'`]\/api\/[^"'`]*/g) ?? [], file).toEqual(file === "api.ts" ? ['"/api/plans'] : []);
    }
  });
});
