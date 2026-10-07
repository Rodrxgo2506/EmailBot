import type { OrganizationPlanOverview } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/errors";
import { PLAN_LABELS } from "@/lib/labels";
import { formatBytes, hasAccess, isLegacyPlan, planDescription, planFeatures, planTitle, planUsageRows } from "./plan-model";

const GB = 1024 ** 3;

const SUBSCRIPTION = {
  status: "ACTIVE",
  plan: "PRO",
  billingPeriod: "MONTHLY",
  currency: "PEN",
  amount: "39.90",
  paymentMethod: "YAPE",
  startedAt: "2026-10-06T05:00:00.000Z",
  currentPeriodStart: "2026-10-06T05:00:00.000Z",
  currentPeriodEnd: "2099-11-06T05:00:00.000Z",
  canceledAt: null,
  suspendedAt: null,
  expiredAt: null
} as const;

const overview = (plan: "FREE" | "BASIC" | "PRO" | "BUSINESS" = "PRO"): OrganizationPlanOverview => ({
  subscription: plan === "FREE" ? null : { ...SUBSCRIPTION, plan },
  entitlements: {
    plan,
    effectivePlan: plan === "FREE" ? "BASIC" : plan,
    access: plan === "FREE" ? "LEGACY" : "SUBSCRIPTION",
    subscriptionStatus: plan === "FREE" ? null : "ACTIVE",
    limits: { EMAIL_ACCOUNTS: 125, RULES: 30, BOTS: 10, MONTHLY_EMAILS: 15000, MEMBERS: 5, CUSTOMERS: 2500, STORAGE_BYTES: 5 * GB, RETENTION_DAYS: 90 },
    features: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: false, PRIORITY_SUPPORT: true }
  },
  usage: { EMAIL_ACCOUNTS: 125, RULES: 4, BOTS: 0, MONTHLY_EMAILS: 15200, MEMBERS: 2, CUSTOMERS: 1234, STORAGE_BYTES: 1536 * 1024 ** 2 }
});

describe("plan presentation (Commercial V1)", () => {
  it("names the plans commercially; FREE only as legacy", () => {
    expect(PLAN_LABELS).toEqual({ FREE: "Free (legado)", BASIC: "Básico", PRO: "Pro", BUSINESS: "Business" });
    expect(planTitle(overview("PRO"))).toBe("Plan Pro");
    expect(planTitle(overview("FREE"))).toBe("Plan Básico");
    expect(isLegacyPlan(overview("FREE"))).toBe(true);
    expect(isLegacyPlan(overview("BASIC"))).toBe(false);
  });

  it("usage against each limit; at or above the limit is 'reached'", () => {
    const rows = Object.fromEntries(planUsageRows(overview()).map((row) => [row.key, row]));
    expect(rows.EMAIL_ACCOUNTS).toMatchObject({ label: "Cuentas de correo", value: "125 / 125", reached: true });
    expect(rows.RULES).toMatchObject({ value: "4 / 30", reached: false });
    expect(rows.MONTHLY_EMAILS?.reached).toBe(true);
    expect(rows.STORAGE_BYTES).toMatchObject({ value: expect.stringMatching(/^1[.,]5 GB \/ 5 GB$/), reached: false });
    expect(rows.CUSTOMERS?.value).toMatch(/^1[.,\s]?234 \/ 2[.,\s]?500$/);
    expect(Object.keys(rows)).not.toContain("RETENTION_DAYS");
  });

  it("an unlimited limit is shown as such and never reached", () => {
    const data = overview();
    data.entitlements.limits.RULES = null;
    expect(planUsageRows(data).find((row) => row.key === "RULES")).toMatchObject({ value: "4 / ilimitado", reached: false });
  });

  it("only features that exist in the product are presented", () => {
    expect(planFeatures(overview()).map((feature) => feature.key)).toEqual(["GMAIL", "MICROSOFT", "PORTAL"]);
  });

  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
    expect(formatBytes(25 * GB)).toBe("25 GB");
  });
});

describe("plan errors from the API", () => {
  it("a limit names the plan and the limit", () => {
    const error = new ApiError(403, "PLAN_LIMIT_REACHED", "The BASIC plan allows up to 25 (EMAIL_ACCOUNTS)", { limit: "EMAIL_ACCOUNTS", max: 25, used: 25, plan: "BASIC" });
    expect(getErrorMessage(error)).toBe("Alcanzaste el límite de tu plan Básico (cuentas de correo: 25). Para agregar más se necesita un plan superior.");
  });

  it("a feature names the feature and the plan", () => {
    const error = new ApiError(403, "PLAN_FEATURE_UNAVAILABLE", "PORTAL is not included in the BASIC plan", { feature: "PORTAL", plan: "BASIC" });
    expect(getErrorMessage(error)).toBe("Portal de clientes no está incluido en tu plan Básico.");
  });

  it("without usable details, a generic Spanish message (never the English API text)", () => {
    expect(getErrorMessage(new ApiError(403, "PLAN_LIMIT_REACHED", "The plan allows up to 2"))).toBe(
      "Alcanzaste el límite de tu plan. Para agregar más se necesita un plan superior."
    );
    expect(getErrorMessage(new ApiError(403, "PLAN_FEATURE_UNAVAILABLE", "x", { feature: "WHATEVER", plan: "BASIC" }))).toBe(
      "Esta funcionalidad no está incluida en tu plan."
    );
    expect(getErrorMessage(new ApiError(403, "PLAN_UNAVAILABLE", "x"))).toBe("No se pudo leer el plan de tu organización. Inténtalo de nuevo.");
  });
});

describe("subscription (Commercial V1.1): paid service, no free access", () => {
  const none = (subscription: OrganizationPlanOverview["subscription"]): OrganizationPlanOverview => ({
    ...overview("PRO"),
    subscription,
    entitlements: { ...overview("PRO").entitlements, plan: null, effectivePlan: null, access: "NONE", subscriptionStatus: subscription?.status ?? null }
  });

  it("an active subscription: period, price with IGV, method and end date", () => {
    expect(hasAccess(overview("PRO"))).toBe(true);
    expect(planDescription(overview("PRO")).startsWith("Suscripción mensual · S/ 39.90 (IGV incluido) · pagada con Yape · vigente hasta el ")).toBe(true);
  });

  it("no subscription: says EmailBot is paid; no limits are shown as granted", () => {
    const data = none(null);
    expect(hasAccess(data)).toBe(false);
    expect(planTitle(data)).toBe("Sin suscripción activa");
    expect(planDescription(data)).toMatch(/EmailBot es un servicio de pago/);
    expect(planDescription(data)).not.toMatch(/gratis|gratuito|free/i);
  });

  it.each([
    ["SUSPENDED", /suspendida/],
    ["CANCELED", /cancelada/],
    ["EXPIRED", /vencida/]
  ] as const)("%s: data kept, access stopped", (status, text) => {
    const data = none({ ...SUBSCRIPTION, status });
    expect(planDescription(data)).toMatch(text);
    expect(planDescription(data)).toMatch(/Tus datos se conservan/);
  });

  it("ACTIVE but the paid period ended: no access, asks to renew", () => {
    expect(planDescription(none({ ...SUBSCRIPTION, currentPeriodEnd: "2026-10-01T05:00:00.000Z" }))).toMatch(/periodo pagado terminó/);
  });

  it("legacy organizations (never subscribed) are told so", () => {
    expect(planDescription(overview("FREE"))).toMatch(/plan Free, que ya no se ofrece/);
    expect(isLegacyPlan(overview("PRO"))).toBe(false);
  });

  it("subscription errors from the API are explained in Spanish", () => {
    expect(getErrorMessage(new ApiError(403, "SUBSCRIPTION_REQUIRED", "x"))).toMatch(/no tiene una suscripción activa/);
    expect(getErrorMessage(new ApiError(409, "PAYMENT_ALREADY_RECORDED", "x"))).toBe("Ese pago (método y referencia) ya fue registrado.");
  });
});
