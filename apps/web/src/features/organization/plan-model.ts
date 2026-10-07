import {
  PLAN_USAGE_KEYS,
  type OrganizationPlanOverview,
  type PlanFeatureKey,
  type PlanUsageKey
} from "@emailbot/types";
import {
  BILLING_PERIOD_LABELS,
  formatPen,
  PAYMENT_METHOD_LABELS,
  PLAN_FEATURE_LABELS,
  PLAN_LABELS,
  PLAN_LIMIT_LABELS,
  SUBSCRIPTION_STATUS_LABELS
} from "@/lib/labels";
import { formatDate } from "@/lib/utils";

/*
 * Commercial V1 / V1.1: how the plan and the subscription of the organization
 * are presented (Settings > Plan). EmailBot is a paid service: nothing here
 * presents any plan as free.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const integer = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 });

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${decimal.format(bytes / GB)} GB`;
  if (bytes >= MB) return `${decimal.format(bytes / MB)} MB`;
  if (bytes >= 1024) return `${decimal.format(bytes / 1024)} KB`;
  return `${integer.format(bytes)} B`;
}

function formatAmount(key: PlanUsageKey, value: number): string {
  return key === "STORAGE_BYTES" ? formatBytes(value) : integer.format(value);
}

export interface PlanUsageRow {
  key: PlanUsageKey;
  label: string;
  /** "3 / 10", "3 / ilimitado". */
  value: string;
  /** Nothing more can be added (usage at or above the limit). */
  reached: boolean;
}

export function planUsageRows({ entitlements, usage }: OrganizationPlanOverview): PlanUsageRow[] {
  return PLAN_USAGE_KEYS.map((key) => {
    const limit = entitlements.limits[key];
    const used = usage[key] ?? 0;
    return {
      key,
      label: PLAN_LIMIT_LABELS[key],
      value: `${formatAmount(key, used)} / ${limit === null ? "ilimitado" : formatAmount(key, limit)}`,
      reached: limit !== null && used >= limit
    };
  });
}

/**
 * Features shown to members: only those the product has and the API enforces.
 * ADVANCED_STATS, API and PRIORITY_SUPPORT are catalog entitlements without a
 * product behind them yet, and RETENTION_DAYS is not applied yet (nothing
 * deletes emails by age), so none of them is presented as if it existed.
 */
export const VISIBLE_PLAN_FEATURES = ["GMAIL", "MICROSOFT", "PORTAL"] as const satisfies readonly PlanFeatureKey[];

export function planFeatures({ entitlements }: OrganizationPlanOverview): Array<{ key: PlanFeatureKey; label: string; enabled: boolean }> {
  return VISIBLE_PLAN_FEATURES.map((key) => ({ key, label: PLAN_FEATURE_LABELS[key], enabled: entitlements.features[key] }));
}

export function hasAccess({ entitlements }: OrganizationPlanOverview): boolean {
  return entitlements.access !== "NONE" && entitlements.effectivePlan !== null;
}

/** Title of the plan card; a legacy FREE organization shows the plan whose limits apply. */
export function planTitle(data: OrganizationPlanOverview): string {
  const plan = data.entitlements.effectivePlan;
  return hasAccess(data) && plan ? `Plan ${PLAN_LABELS[plan]}` : "Sin suscripción activa";
}

export function isLegacyPlan({ entitlements }: OrganizationPlanOverview): boolean {
  return entitlements.access === "LEGACY";
}

/** One sentence on where the access comes from (or why there is none). */
export function planDescription(data: OrganizationPlanOverview): string {
  const { entitlements, subscription } = data;
  if (entitlements.access === "SUBSCRIPTION" && subscription) {
    return (
      `Suscripción ${BILLING_PERIOD_LABELS[subscription.billingPeriod].toLowerCase()} · ${formatPen(subscription.amount)} (IGV incluido) · ` +
      `pagada con ${PAYMENT_METHOD_LABELS[subscription.paymentMethod]} · vigente hasta el ${formatDate(subscription.currentPeriodEnd)}. ` +
      "El cambio de plan lo realiza el equipo de EmailBot."
    );
  }
  if (entitlements.access === "LEGACY") {
    return entitlements.plan === "FREE"
      ? "Tu organización se creó con el plan Free, que ya no se ofrece: se aplican los límites del plan Básico hasta que contrates un plan."
      : "Plan asignado por el equipo de EmailBot antes de las suscripciones. Se mantiene hasta que contrates una suscripción.";
  }
  if (!subscription) {
    return "Tu organización no tiene una suscripción. EmailBot es un servicio de pago: para usarlo necesitas contratar un plan (Básico, Pro o Business). Tus datos se conservan.";
  }
  if (subscription.status === "ACTIVE") {
    return `Tu periodo pagado terminó el ${formatDate(subscription.currentPeriodEnd)}. Tus datos se conservan; renueva tu plan para seguir usando EmailBot.`;
  }
  return `Tu suscripción está ${SUBSCRIPTION_STATUS_LABELS[subscription.status].toLowerCase()}. Tus datos se conservan, pero no puedes usar las funciones del producto hasta reactivarla.`;
}
