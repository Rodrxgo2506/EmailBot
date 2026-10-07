import type {
  AdminPlanPrice,
  AdminSubscription,
  AdminSubscriptionActivation,
  BillingPeriod,
  CommercialPlan,
  ManualPaymentMethod,
  SubscriptionAction,
  SubscriptionStatus
} from "@emailbot/types";

/*
 * Commercial V1.1: Super Admin subscription form and actions, kept free of
 * React so it can be unit tested. Dates are calendar days in Lima
 * (America/Lima, UTC-5 all year, no DST): a period "2026-10-06 -> 2026-11-06"
 * starts and ends at 00:00 Lima.
 */

const LIMA_OFFSET = "-05:00";
const OPEN: readonly SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "SUSPENDED"];

/** "YYYY-MM-DD" of `now` in Lima. */
export function limaDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Calendar day -> ISO instant at 00:00 Lima (what the API receives). */
export function limaStartOfDay(date: string): string {
  return `${date}T00:00:00${LIMA_OFFSET}`;
}

/** Same day one month / one year later; the 31st becomes the last day of a shorter month. */
export function addPeriod(date: string, period: BillingPeriod): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const targetYear = period === "YEARLY" ? year + 1 : month === 12 ? year + 1 : year;
  const targetMonth = period === "YEARLY" ? month : month === 12 ? 1 : month + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

/** The open subscription (ACTIVE / PAST_DUE / SUSPENDED), if any. */
export function currentSubscription(subscriptions: AdminSubscription[]): AdminSubscription | null {
  return subscriptions.find((subscription) => OPEN.includes(subscription.status)) ?? null;
}

export function periodEnded(subscription: Pick<AdminSubscription, "currentPeriodEnd">, now: Date = new Date()): boolean {
  return Date.parse(subscription.currentPeriodEnd) <= now.getTime();
}

/** Actions the backend accepts for this subscription now (its state machine). */
export function availableActions(subscription: AdminSubscription, now: Date = new Date()): SubscriptionAction[] {
  if (!OPEN.includes(subscription.status)) return [];
  const ended = periodEnded(subscription, now);
  const actions: SubscriptionAction[] = [];
  if (subscription.status === "ACTIVE" || subscription.status === "PAST_DUE") actions.push("suspend");
  if ((subscription.status === "SUSPENDED" || subscription.status === "PAST_DUE") && !ended) actions.push("reactivate");
  if (ended) actions.push("expire");
  actions.push("cancel");
  return actions;
}

export interface ActivationForm {
  plan: CommercialPlan;
  billingPeriod: BillingPeriod;
  paymentMethod: ManualPaymentMethod;
  amount: string;
  start: string;
  end: string;
  reference: string;
  note: string;
}

export function listPrice(prices: AdminPlanPrice[], plan: CommercialPlan, billingPeriod: BillingPeriod): string {
  return prices.find((price) => price.plan === plan && price.billingPeriod === billingPeriod)?.amount ?? "";
}

/**
 * Defaults: the current plan and period when there is a subscription (renewal),
 * starting when the current period ends if that is in the future; the list
 * price as the amount (editable: it is what the customer actually paid).
 */
export function defaultActivation(current: AdminSubscription | null, prices: AdminPlanPrice[], now: Date = new Date()): ActivationForm {
  const plan = current?.plan ?? "BASIC";
  const billingPeriod = current?.billingPeriod ?? "MONTHLY";
  const today = limaDate(now);
  const start = current && !periodEnded(current, now) ? limaDate(new Date(current.currentPeriodEnd)) : today;
  return {
    plan,
    billingPeriod,
    paymentMethod: "YAPE",
    amount: listPrice(prices, plan, billingPeriod),
    start,
    end: addPeriod(start, billingPeriod),
    reference: "",
    note: ""
  };
}

/** Client-side checks (the API and the database check again); null = valid. */
export function activationProblem(form: ActivationForm): string | null {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(form.amount.trim()) || Number(form.amount) <= 0) return "Indica el importe pagado, por ejemplo 39.90.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.start) || !/^\d{4}-\d{2}-\d{2}$/.test(form.end)) return "Indica las fechas de inicio y vencimiento.";
  if (form.end <= form.start) return "El vencimiento debe ser posterior al inicio.";
  if (form.reference.trim().length > 100) return "La referencia admite hasta 100 caracteres.";
  if (form.note.trim().length > 500) return "La nota admite hasta 500 caracteres.";
  return null;
}

export function toActivation(form: ActivationForm): AdminSubscriptionActivation {
  const reference = form.reference.trim();
  const note = form.note.trim();
  return {
    plan: form.plan,
    billingPeriod: form.billingPeriod,
    paymentMethod: form.paymentMethod,
    amount: form.amount.trim(),
    periodStart: limaStartOfDay(form.start),
    periodEnd: limaStartOfDay(form.end),
    ...(reference ? { reference } : {}),
    ...(note ? { note } : {})
  };
}

export const ACTIVATION_OUTCOME_LABELS = {
  ACTIVATED: "Suscripción activada",
  RENEWED: "Suscripción renovada",
  PLAN_CHANGED: "Plan de la suscripción cambiado"
} as const;

/** Copy of the confirmations: only what the backend really does. */
export const SUBSCRIPTION_ACTION_COPY: Record<SubscriptionAction, { label: string; title: string; description: string; destructive: boolean; success: string }> = {
  suspend: {
    label: "Suspender suscripción",
    title: "¿Suspender la suscripción?",
    description:
      "La organización pierde el acceso comercial (no podrá crear ni conectar nada) hasta que la reactives. No se borra ningún dato. Úsalo por falta de pago o una incidencia.",
    destructive: true,
    success: "Suscripción suspendida"
  },
  reactivate: {
    label: "Reactivar suscripción",
    title: "¿Reactivar la suscripción?",
    description: "Recupera el acceso con el mismo plan hasta el final del periodo ya pagado.",
    destructive: false,
    success: "Suscripción reactivada"
  },
  cancel: {
    label: "Cancelar suscripción",
    title: "¿Cancelar la suscripción?",
    description:
      "Es definitivo: la organización pierde el acceso comercial ahora y la suscripción no se puede reactivar (un pago nuevo crea otra). No se borra ningún dato.",
    destructive: true,
    success: "Suscripción cancelada"
  },
  expire: {
    label: "Marcar como vencida",
    title: "¿Marcar la suscripción como vencida?",
    description: "Su periodo ya terminó sin renovación. Queda vencida (definitivo); un pago nuevo crea otra suscripción. No se borra ningún dato.",
    destructive: true,
    success: "Suscripción vencida"
  }
};
