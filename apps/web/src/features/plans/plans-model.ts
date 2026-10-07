import type { CommercialPlan, PlanCatalogEntry, PlanCatalogPrice, PlanFeatureKey, PlanLimitKey } from "@emailbot/types";
import { formatBytes } from "@/features/organization/plan-model";
import { formatPen, PLAN_FEATURE_LABELS } from "@/lib/labels";

/*
 * Commercial V1: how the public plan catalog (GET /api/plans, the database
 * catalog) is presented on /planes and in Settings > Mi plan. Prices, limits
 * and features are never written here: they come from the catalog.
 *
 * Only what the product has is presented. RETENTION_DAYS (nothing deletes
 * emails by age), ADVANCED_STATS, API and PRIORITY_SUPPORT are catalog
 * entitlements without a product behind them yet (docs/commercial-plans.md),
 * so they are not sold here either.
 *
 * Online purchase does not exist yet: every "choose / upgrade" action opens
 * the "Próximamente" notice (PlanCta kind CHOOSE). The payments phase replaces
 * that single action with the checkout; the page does not change.
 */

/** Limits shown, with the wording of the offer (what the API counts). */
export const CATALOG_LIMITS = ["EMAIL_ACCOUNTS", "MONTHLY_EMAILS", "RULES", "BOTS", "CUSTOMERS", "MEMBERS", "STORAGE_BYTES"] as const satisfies readonly PlanLimitKey[];
export type CatalogLimitKey = (typeof CATALOG_LIMITS)[number];

/** Features shown (the product has them and the API enforces them). */
export const CATALOG_FEATURES = ["GMAIL", "MICROSOFT", "PORTAL"] as const satisfies readonly PlanFeatureKey[];
export type CatalogFeatureKey = (typeof CATALOG_FEATURES)[number];

export const CATALOG_LIMIT_LABELS: Record<CatalogLimitKey, string> = {
  EMAIL_ACCOUNTS: "Cuentas de correo",
  MONTHLY_EMAILS: "Correos procesados al mes",
  RULES: "Reglas",
  BOTS: "Bots activos",
  CUSTOMERS: "Clientes activos",
  MEMBERS: "Miembros del equipo",
  STORAGE_BYTES: "Almacenamiento de adjuntos"
};

/** How a limit reads in a sentence: "5 cuentas de correo", "5 GB de almacenamiento de adjuntos". */
const LIMIT_NOUNS: Record<CatalogLimitKey, { one: string; other: string }> = {
  EMAIL_ACCOUNTS: { one: "cuenta de correo", other: "cuentas de correo" },
  MONTHLY_EMAILS: { one: "correo procesado al mes", other: "correos procesados al mes" },
  RULES: { one: "regla", other: "reglas" },
  BOTS: { one: "bot activo", other: "bots activos" },
  CUSTOMERS: { one: "cliente activo", other: "clientes activos" },
  MEMBERS: { one: "miembro del equipo", other: "miembros del equipo" },
  STORAGE_BYTES: { one: "de almacenamiento de adjuntos", other: "de almacenamiento de adjuntos" }
};

export function limitPhrase(key: CatalogLimitKey, value: number | null): string {
  if (value === null) return `${CATALOG_LIMIT_LABELS[key]}: ilimitado`;
  return `${formatLimit(key, value)} ${value === 1 ? LIMIT_NOUNS[key].one : LIMIT_NOUNS[key].other}`;
}

const integer = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });

export function formatLimit(key: PlanLimitKey, value: number | null): string {
  if (value === null) return "Ilimitado";
  return key === "STORAGE_BYTES" ? formatBytes(value) : integer.format(value);
}

export function monthlyPrice(plan: PlanCatalogEntry): PlanCatalogPrice | null {
  return plan.prices.find((price) => price.billingPeriod === "MONTHLY" && price.currency === "PEN") ?? null;
}

export function yearlyPrice(plan: PlanCatalogEntry): PlanCatalogPrice | null {
  return plan.prices.find((price) => price.billingPeriod === "YEARLY" && price.currency === "PEN") ?? null;
}

/** "S/ 39.90" (decimal string from the catalog, never recomputed with floats). */
export function formatPrice(price: PlanCatalogPrice): string {
  return formatPen(price.amount);
}

/** Card / "includes" lines of a plan: every shown limit, then the shown features. */
export function planHighlights(plan: PlanCatalogEntry): Array<{ key: CatalogLimitKey | CatalogFeatureKey; label: string; included: boolean }> {
  return [
    ...CATALOG_LIMITS.map((key) => ({ key, label: limitPhrase(key, plan.limits[key]), included: plan.limits[key] !== 0 })),
    ...CATALOG_FEATURES.map((key) => ({ key, label: PLAN_FEATURE_LABELS[key], included: plan.features[key] }))
  ];
}

export interface ComparisonRow {
  key: CatalogLimitKey | CatalogFeatureKey;
  label: string;
  /** Per plan, in catalog order: a formatted limit, or true / false for a feature. */
  values: Array<string | boolean>;
}

export interface ComparisonGroup {
  title: string;
  rows: ComparisonRow[];
}

const GROUPS: Array<{ title: string; keys: Array<CatalogLimitKey | CatalogFeatureKey> }> = [
  { title: "Correo", keys: ["EMAIL_ACCOUNTS", "GMAIL", "MICROSOFT", "MONTHLY_EMAILS"] },
  { title: "Automatización", keys: ["RULES", "BOTS"] },
  { title: "Clientes y portal", keys: ["CUSTOMERS", "PORTAL"] },
  { title: "Equipo", keys: ["MEMBERS"] },
  { title: "Almacenamiento", keys: ["STORAGE_BYTES"] }
];

const isFeature = (key: string): key is CatalogFeatureKey => (CATALOG_FEATURES as readonly string[]).includes(key);

export function comparisonGroups(plans: readonly PlanCatalogEntry[]): ComparisonGroup[] {
  return GROUPS.map((group) => ({
    title: group.title,
    rows: group.keys.map((key) =>
      isFeature(key)
        ? { key, label: PLAN_FEATURE_LABELS[key], values: plans.map((plan) => plan.features[key]) }
        : { key, label: CATALOG_LIMIT_LABELS[key], values: plans.map((plan) => formatLimit(key, plan.limits[key])) }
    )
  }));
}

/** The viewer: anonymous, or a member whose organization has (or lacks) a plan. */
export type Viewer = { authenticated: false } | { authenticated: true; currentPlan: CommercialPlan | null };

export type PlanCta =
  /** Anonymous visitor: the existing sign-up. */
  | { kind: "REGISTER"; label: string; to: "/register" }
  /** The organization's plan: shown, not actionable. */
  | { kind: "CURRENT"; label: string }
  /** Choose / upgrade: today the "Próximamente" notice; later the checkout. */
  | { kind: "CHOOSE"; label: string }
  /** A plan below the current one (downgrades are handled by the EmailBot team). */
  | { kind: "LOWER"; label: string };

export function planCta(plan: PlanCatalogEntry, viewer: Viewer, catalog: readonly PlanCatalogEntry[]): PlanCta {
  if (!viewer.authenticated) return { kind: "REGISTER", label: "Crear cuenta", to: "/register" };
  if (viewer.currentPlan === null) return { kind: "CHOOSE", label: `Elegir ${plan.name}` };
  if (plan.code === viewer.currentPlan) return { kind: "CURRENT", label: "Tu plan actual" };
  const current = catalog.find((entry) => entry.code === viewer.currentPlan);
  if (current && plan.sortOrder < current.sortOrder) return { kind: "LOWER", label: "Incluido en tu plan" };
  return { kind: "CHOOSE", label: `Mejorar a ${plan.name}` };
}

/** Plans above the current one (all of them without a plan); [] = the most complete plan already. */
export function upgradeOptions(catalog: readonly PlanCatalogEntry[], currentPlan: CommercialPlan | null): PlanCatalogEntry[] {
  const current = catalog.find((entry) => entry.code === currentPlan);
  return current ? catalog.filter((entry) => entry.sortOrder > current.sortOrder) : [...catalog];
}

/** What the target plan adds over the current one (higher limits, new features). */
export function upgradeBenefits(current: PlanCatalogEntry | null, target: PlanCatalogEntry): string[] {
  const benefits: string[] = [];
  for (const key of CATALOG_LIMITS) {
    const from = current?.limits[key] ?? 0;
    const to = target.limits[key];
    if (to === null ? from !== null : from !== null && to > from) benefits.push(limitPhrase(key, to));
  }
  for (const key of CATALOG_FEATURES) {
    if (target.features[key] && !current?.features[key]) benefits.push(PLAN_FEATURE_LABELS[key]);
  }
  return benefits;
}
