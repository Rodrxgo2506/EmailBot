import {
  collectCulqiIds,
  CULQI_CHARGE_SUCCESS_CODE,
  culqiAmountToCents,
  culqiEnvironment,
  culqiPlanMismatch,
  culqiTimestamp,
  CulqiApiError,
  isHandledCulqiEvent,
  mapCulqiSubscriptionStatus,
  serializeError,
  type CulqiCharge,
  type CulqiClient,
  type CulqiPlan,
  type CulqiSubscription
} from "@emailbot/shared";
import type { BillingStore, BillingSubscriptionRow, Logger } from "./ports.js";

/*
 * Commercial V1 phase 2 (Culqi SANDBOX): webhook events and reconciliation.
 *
 * ONE path applies Culqi to EmailBot (syncCulqiSubscription), used by the
 * webhook (CULQI_EVENT), the post-checkout reconciliation (CULQI_RECONCILE),
 * the periodic reconciliation and the expiry of stale checkouts
 * (CULQI_RECONCILE_DUE):
 *
 *   1. the Culqi subscription is read back (GET /v2/recurrent/subscriptions/{id})
 *      and checked against EmailBot (F2): id, environment, mapped plan,
 *      the Culqi plan's amount / currency / interval vs the catalog, metadata;
 *   2. every candidate charge (from the event and from the subscription's
 *      periods) is read back (GET /v2/charges/{id}) and verified (F1): paid,
 *      outcome "succesfull_charge", amount and currency of the catalog, linked
 *      to this subscription (listed in it) or to its card / customer;
 *   3. ONLY a verified paid charge activates, keyed by its charge id: a
 *      webhook and a reconciliation of the same charge apply it once;
 *   4. a declined charge is recorded once (charge id); Culqi statuses only
 *      move the provider side to PAST_DUE / CANCELED / EXPIRED / FAILED.
 *
 * A "subscription created" event or a Culqi status 3 ("Activa") never
 * activates anything by itself. Nothing from the webhook request is trusted.
 */

/** Culqi charges subscriptions in a daily batch: the EmailBot period ends this long after the paid interval. */
export const CULQI_RENEWAL_GRACE_MS = 3 * 24 * 3600_000;
/** F3: subscriptions are re-read from this long before the end of their period (renewal charge window). */
export const CULQI_RECONCILE_WINDOW_MS = CULQI_RENEWAL_GRACE_MS + 24 * 3600_000;
/** F3: and until this long after it (late renewals / retries). */
export const CULQI_RECONCILE_LOOKBACK_MS = 7 * 24 * 3600_000;
/**
 * F4: a checkout whose Culqi subscription has no verified paid charge after
 * this long is cancelled at Culqi and FAILED (confirmation_timeout). 48 h
 * covers Culqi's daily charging batch plus a retry day.
 */
export const CULQI_PENDING_CONFIRMATION_TIMEOUT_MS = 48 * 3600_000;
/** F4: a checkout that never got its Culqi subscription id (interrupted) is FAILED after this long. */
export const CULQI_PENDING_INCOMPLETE_TIMEOUT_MS = 30 * 60_000;
const BATCH = 100;
const MAX_CHARGES = 24;

export interface BillingDeps {
  store: BillingStore;
  /** null = CULQI_SECRET_KEY not configured on the worker. */
  culqi: CulqiClient | null;
  logger: Logger;
  now?: () => number;
}

export type BillingOutcome =
  | "activated"
  | "duplicate"
  | "already_covered"
  | "charge_failed"
  | "status_changed"
  | "pending"
  | "rejected"
  | "ignored"
  | "expired_pending"
  | "not_configured";

/** The checkout has no verified paid charge yet: the reconciliation job is retried later (BullMQ backoff). */
export class CulqiStillPendingError extends Error {
  constructor(readonly billingSubscriptionId: string) {
    super("The Culqi subscription has no verified paid charge yet");
    this.name = "CulqiStillPendingError";
  }
}

const now = (deps: BillingDeps) => (deps.now ? deps.now() : Date.now());

function errorText(error: unknown): string {
  if (error instanceof CulqiApiError) return `${error.operation}: HTTP ${error.status} ${error.code ?? error.type ?? ""}`.trim();
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

/* ------------------------------------------------------------------ F2: the subscription matches EmailBot */

export type Verification = { ok: true } | { ok: false; reason: string };

const planIdOf = (subscription: CulqiSubscription) =>
  (typeof subscription.plan_id === "string" ? subscription.plan_id : null) ?? (typeof subscription.plan?.plan_id === "string" ? subscription.plan.plan_id : null);

export function verifyCulqiSubscription(row: BillingSubscriptionRow, subscription: CulqiSubscription, plan: CulqiPlan | null, environment: string): Verification {
  if (subscription.id !== row.externalSubscriptionId) return { ok: false, reason: "SUBSCRIPTION_ID_MISMATCH" };
  if (culqiEnvironment(subscription.id) !== row.environment || row.environment !== environment) return { ok: false, reason: "ENVIRONMENT_MISMATCH" };
  const planId = planIdOf(subscription);
  if (!planId) return { ok: false, reason: "PLAN_NOT_REPORTED" };
  if (planId !== row.externalPlanId) return { ok: false, reason: "PLAN_MISMATCH" };
  if (!plan) return { ok: false, reason: "PLAN_NOT_FOUND" };
  const planMismatch = culqiPlanMismatch(plan, { planId: row.externalPlanId, environment: row.environment, amountCents: row.amountCents, currency: row.currency, billingPeriod: row.billingPeriod });
  if (planMismatch) return { ok: false, reason: planMismatch };
  const metadata = subscription.metadata ?? {};
  if (metadata.organization_id !== undefined && metadata.organization_id !== row.organizationId) return { ok: false, reason: "ORGANIZATION_MISMATCH" };
  if (metadata.billing_subscription_id !== undefined && metadata.billing_subscription_id !== row.id) return { ok: false, reason: "BILLING_SUBSCRIPTION_MISMATCH" };
  return { ok: true };
}

/* ------------------------------------------------------------------ F1: the charge is a real payment of this subscription */

export type ChargeVerdict = { kind: "PAID" } | { kind: "DECLINED"; code: string } | { kind: "REJECTED"; reason: string };

export function verifyCulqiCharge(row: BillingSubscriptionRow, chargeId: string, charge: CulqiCharge | null, listedInSubscription: boolean): ChargeVerdict {
  if (!charge) return { kind: "REJECTED", reason: "CHARGE_NOT_FOUND" };
  if (charge.id !== chargeId) return { kind: "REJECTED", reason: "CHARGE_ID_MISMATCH" };
  if (culqiEnvironment(charge.id) !== row.environment) return { kind: "REJECTED", reason: "CHARGE_ENVIRONMENT_MISMATCH" };

  // The charge must belong to this subscription: listed in it, or made with its card / customer.
  const sourceId = typeof charge.source?.id === "string" ? charge.source.id : null;
  const sourceCustomer = typeof charge.source?.customer_id === "string" ? charge.source.customer_id : null;
  if (sourceId?.startsWith("crd_") && row.externalCardId && sourceId !== row.externalCardId) return { kind: "REJECTED", reason: "CHARGE_CARD_MISMATCH" };
  if (sourceCustomer && row.externalCustomerId && sourceCustomer !== row.externalCustomerId) return { kind: "REJECTED", reason: "CHARGE_CUSTOMER_MISMATCH" };
  const linkedBySource = (sourceId !== null && sourceId === row.externalCardId) || (sourceCustomer !== null && sourceCustomer === row.externalCustomerId);
  if (!listedInSubscription && !linkedBySource) return { kind: "REJECTED", reason: "CHARGE_NOT_LINKED" };

  const outcome = charge.outcome?.code ?? null;
  if (charge.paid === false || outcome === "card_declined") {
    return { kind: "DECLINED", code: (charge.outcome?.decline_code ?? outcome ?? "charge_declined").slice(0, 100) };
  }
  if (culqiAmountToCents(charge.amount) !== row.amountCents) return { kind: "REJECTED", reason: "CHARGE_AMOUNT_MISMATCH" };
  if (charge.currency_code !== row.currency) return { kind: "REJECTED", reason: "CHARGE_CURRENCY_MISMATCH" };
  if (charge.paid === true && outcome === CULQI_CHARGE_SUCCESS_CODE) return { kind: "PAID" };
  return { kind: "REJECTED", reason: "CHARGE_NOT_CONFIRMED" };
}

/** EmailBot period paid by a charge: one plan interval from the charge, plus the renewal grace. */
export function periodForCharge(charge: CulqiCharge, billingPeriod: BillingSubscriptionRow["billingPeriod"], at: number) {
  const start = culqiTimestamp(charge.creation_date) ?? new Date(at);
  const end = new Date(start.getTime());
  if (billingPeriod === "YEARLY") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return { start: start.toISOString(), end: new Date(end.getTime() + CULQI_RENEWAL_GRACE_MS).toISOString() };
}

/* ------------------------------------------------------------------ the single application path */

interface Trigger {
  eventId: string | null;
  eventType: string | null;
  chargeIds: string[];
}

export interface SyncResult {
  outcome: BillingOutcome;
  /** Why nothing was applied (mismatch, no verified charge...). */
  reason: string | null;
  /** The billing row has a verified paid charge applied (now or before). */
  paid: boolean;
}

async function cancelReplaced(organizationId: string, deps: BillingDeps & { culqi: CulqiClient }): Promise<void> {
  for (const replaced of await deps.store.listUnconfirmedCancellations(organizationId)) {
    // Already gone at Culqi (404) counts as cancelled. Any other error is retried with the job.
    await deps.culqi.cancelSubscription(replaced.externalSubscriptionId);
    await deps.store.markProviderCanceled(replaced.id);
    deps.logger.info({ event: "billing.culqi.replaced_canceled", organizationId, billingSubscriptionId: replaced.id }, "replaced Culqi subscription canceled");
  }
}

export async function syncCulqiSubscription(row: BillingSubscriptionRow, trigger: Trigger, deps: BillingDeps & { culqi: CulqiClient }): Promise<SyncResult> {
  const log = (event: string, extra: Record<string, unknown>, message: string, level: "info" | "warn" = "info") =>
    deps.logger[level]({ event, organizationId: row.organizationId, billingSubscriptionId: row.id, ...extra }, message);
  if (!row.externalSubscriptionId) return { outcome: "ignored", reason: "NO_SUBSCRIPTION_ID", paid: false };

  const subscription = await deps.culqi.getSubscription(row.externalSubscriptionId);
  if (!subscription) return { outcome: "rejected", reason: "SUBSCRIPTION_NOT_FOUND_AT_CULQI", paid: false };
  const plan = await deps.culqi.getPlan(row.externalPlanId);
  const check = verifyCulqiSubscription(row, subscription, plan, deps.culqi.environment);
  if (!check.ok) {
    log("billing.culqi.subscription_rejected", { reason: check.reason }, "Culqi subscription does not match EmailBot: nothing applied", "warn");
    return { outcome: "rejected", reason: check.reason, paid: false };
  }

  const providerStatus = Number.isInteger(subscription.status) ? subscription.status : null;
  const requestId = trigger.eventId ?? `reconcile:${row.id}`;
  const listed = new Set(collectCulqiIds(subscription).chargeIds);
  const candidates = [...new Set([...trigger.chargeIds, ...listed])].slice(0, MAX_CHARGES);

  const charges: Array<{ id: string; charge: CulqiCharge | null }> = [];
  for (const id of candidates) charges.push({ id, charge: await deps.culqi.getCharge(id) });
  // Oldest first: a renewal extends the period of the previous charge.
  charges.sort((a, b) => (culqiTimestamp(a.charge?.creation_date)?.getTime() ?? 0) - (culqiTimestamp(b.charge?.creation_date)?.getTime() ?? 0));

  let applied = false;
  let paid = row.status === "ACTIVE" || row.status === "PAST_DUE";
  let duplicates = 0;
  let declined = 0;
  let rejectedReason: string | null = null;
  for (const { id, charge } of charges) {
    const verdict = verifyCulqiCharge(row, id, charge, listed.has(id));
    if (verdict.kind === "PAID") {
      const period = periodForCharge(charge as CulqiCharge, row.billingPeriod, now(deps));
      if (Date.parse(period.end) <= now(deps)) {
        duplicates += 1; // a charge whose paid period already ended: nothing to apply
        continue;
      }
      const result = await deps.store.activate({
        billingSubscriptionId: row.id,
        activationKey: id,
        externalChargeId: id,
        eventType: trigger.eventType ?? "subscription.charge.reconciled",
        periodStart: period.start,
        periodEnd: period.end,
        currentPeriod: typeof subscription.current_period === "number" ? subscription.current_period : null,
        providerStatus,
        requestId
      });
      log("billing.culqi.charge_applied", { charge: id, outcome: result.outcome }, "verified Culqi charge applied");
      if (result.outcome === "IGNORED") continue;
      paid = true;
      if (result.outcome === "DUPLICATE" || result.outcome === "ALREADY_COVERED") duplicates += 1;
      else applied = true;
    } else if (verdict.kind === "DECLINED") {
      const recorded = await deps.store.recordChargeFailure({
        billingSubscriptionId: row.id,
        externalEventId: id,
        eventType: trigger.eventType === "subscription.charge.failed" || trigger.eventType === "charge.creation.failed" ? trigger.eventType : "subscription.charge.failed",
        externalChargeId: id,
        failureCode: verdict.code,
        failureMessage: null,
        providerStatus,
        requestId
      });
      if (recorded === "RECORDED") declined += 1;
      else duplicates += 1;
    } else {
      rejectedReason = verdict.reason;
      log("billing.culqi.charge_rejected", { charge: id, reason: verdict.reason }, "Culqi charge not applied", "warn");
    }
  }

  // Provider-side status (never an activation): creation failed, cancelled, expired, retrying.
  let statusChanged = false;
  const current = (await deps.store.getBillingSubscription(row.id)) ?? row;
  const mapped = mapCulqiSubscriptionStatus(subscription.status, current.status);
  const setStatus = async (status: "FAILED" | "PAST_DUE" | "CANCELED" | "EXPIRED", failureCode: string | null) => {
    const result = await deps.store.setStatus({
      billingSubscriptionId: row.id,
      status,
      providerStatus,
      cancelReason: status === "CANCELED" ? (current.cancelReason ?? "PROVIDER") : null,
      failureCode,
      failureMessage: null,
      requestId
    });
    statusChanged ||= result === "CHANGED";
  };
  if (trigger.eventType === "subscription.creation.failed" && !paid) await setStatus("FAILED", "subscription_creation_failed");
  if (mapped === "CANCELED" || mapped === "EXPIRED") await setStatus(mapped, null);
  else if (mapped === "PAST_DUE" && !applied) await setStatus("PAST_DUE", "charge_retrying");
  else if (mapped === null) log("billing.culqi.unknown_status", { providerStatus }, "unknown Culqi subscription status", "warn");

  if (applied) await cancelReplaced(row.organizationId, deps);

  // F4: a first charge was declined: the Culqi subscription is stopped so it cannot charge later unnoticed.
  if (declined > 0 && !paid && current.status === "FAILED") {
    await deps.culqi.cancelSubscription(row.externalSubscriptionId);
    await deps.store.markProviderCanceled(row.id);
    log("billing.culqi.failed_subscription_canceled", {}, "Culqi subscription of a declined checkout canceled");
  }

  if (applied) return { outcome: "activated", reason: null, paid: true };
  if (declined > 0) return { outcome: "charge_failed", reason: null, paid };
  if (statusChanged) return { outcome: "status_changed", reason: null, paid };
  if (duplicates > 0) return { outcome: "duplicate", reason: null, paid };
  if (rejectedReason) return { outcome: "rejected", reason: rejectedReason, paid };
  return { outcome: "pending", reason: paid ? null : "NO_VERIFIED_CHARGE", paid };
}

/* ------------------------------------------------------------------ CULQI_EVENT */

/** The webhook event, re-read from Culqi and applied through syncCulqiSubscription. */
export async function handleCulqiEvent(eventId: string, deps: BillingDeps): Promise<BillingOutcome> {
  const stored = await deps.store.getWebhookEvent(eventId);
  if (!stored || stored.status === "PROCESSED" || stored.status === "IGNORED") return "duplicate";

  if (!deps.culqi) {
    await deps.store.updateWebhookEvent(eventId, { status: "FAILED", lastError: "BILLING_NOT_CONFIGURED" });
    deps.logger.error({ event: "billing.culqi.not_configured", eventId }, "Culqi event received but CULQI_SECRET_KEY is not configured on the worker");
    return "not_configured";
  }
  const culqiDeps = { ...deps, culqi: deps.culqi };
  const ignore = async (reason: string, extra: { eventType?: string | null } = {}) => {
    await deps.store.updateWebhookEvent(eventId, { status: "IGNORED", lastError: reason, processed: true, ...extra });
    deps.logger.info({ event: "billing.culqi.event_ignored", eventId, reason }, "Culqi event ignored");
    return "ignored" as const;
  };

  await deps.store.updateWebhookEvent(eventId, { attempts: stored.attempts + 1 });
  try {
    if (culqiEnvironment(eventId) !== deps.culqi.environment) return await ignore("ENVIRONMENT_MISMATCH");

    // The request body is never trusted: the event is read back from Culqi.
    const event = await deps.culqi.getEvent(eventId);
    if (!event || event.id !== eventId) return await ignore("NOT_FOUND_AT_CULQI");
    const eventType = typeof event.type === "string" ? event.type.slice(0, 100) : null;
    if (!eventType || !isHandledCulqiEvent(eventType)) return await ignore("UNHANDLED_EVENT_TYPE", { eventType });

    const ids = collectCulqiIds(event.data);
    let subscriptionId = ids.subscriptionIds[0] ?? null;
    const chargeId = ids.chargeIds[0] ?? null;
    // A charge event may not name its subscription: the charge itself is read back to find it.
    if (!subscriptionId && chargeId) subscriptionId = collectCulqiIds(await deps.culqi.getCharge(chargeId)).subscriptionIds[0] ?? null;
    await deps.store.updateWebhookEvent(eventId, { eventType, externalSubscriptionId: subscriptionId, externalChargeId: chargeId });
    if (!subscriptionId) return await ignore("NO_SUBSCRIPTION");

    const row = await deps.store.findBillingSubscriptionByExternalId(subscriptionId);
    if (!row) return await ignore("UNKNOWN_SUBSCRIPTION");

    const result = await syncCulqiSubscription(row, { eventId, eventType, chargeIds: ids.chargeIds }, culqiDeps);
    if (result.outcome === "rejected") return await ignore(`REJECTED:${result.reason ?? "UNKNOWN"}`, { eventType });
    await deps.store.updateWebhookEvent(eventId, { status: "PROCESSED", lastError: result.reason, processed: true });
    deps.logger.info({ event: "billing.culqi.event_processed", eventId, eventType, outcome: result.outcome, billingSubscriptionId: row.id }, "Culqi event processed");
    return result.outcome;
  } catch (error) {
    await deps.store.updateWebhookEvent(eventId, { status: "FAILED", lastError: errorText(error) }).catch(() => undefined);
    deps.logger.warn({ event: "billing.culqi.event_failed", eventId, err: serializeError(error) }, "Culqi event processing failed; retried");
    throw error;
  }
}

/* ------------------------------------------------------------------ CULQI_RECONCILE (after a checkout) */

/**
 * Re-reads one Culqi subscription after a checkout (works without webhooks).
 * Throws CulqiStillPendingError while there is no verified paid charge, so
 * BullMQ retries with backoff (the periodic job closes it after the timeout).
 */
export async function reconcileCulqiSubscription(billingSubscriptionId: string, deps: BillingDeps): Promise<BillingOutcome> {
  if (!deps.culqi) {
    deps.logger.error({ event: "billing.culqi.not_configured", billingSubscriptionId }, "Culqi reconciliation skipped: CULQI_SECRET_KEY is not configured on the worker");
    return "not_configured";
  }
  const row = await deps.store.getBillingSubscription(billingSubscriptionId);
  if (!row?.externalSubscriptionId || row.status === "CANCELED" || row.status === "EXPIRED") return "ignored";
  const result = await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, { ...deps, culqi: deps.culqi });
  if (row.status === "PENDING" && result.outcome === "pending") throw new CulqiStillPendingError(row.id);
  return result.outcome;
}

/* ------------------------------------------------------------------ CULQI_RECONCILE_DUE (periodic: F3 + F4) */

/** F4: closes a stale checkout. Never cancels a Culqi subscription that has a verified paid charge. */
export async function expireStalePending(row: BillingSubscriptionRow, deps: BillingDeps & { culqi: CulqiClient }): Promise<BillingOutcome> {
  const requestId = `expire:${row.id}`;
  const fail = (failureCode: string) =>
    deps.store.setStatus({ billingSubscriptionId: row.id, status: "FAILED", providerStatus: null, cancelReason: null, failureCode, failureMessage: null, requestId });

  if (!row.externalSubscriptionId) {
    await fail("checkout_incomplete");
    // The Culqi subscription may exist without its id stored (interrupted checkout): its metadata names this row.
    deps.logger.warn({ event: "billing.culqi.checkout_incomplete", organizationId: row.organizationId, billingSubscriptionId: row.id }, "checkout without Culqi subscription id closed; check Culqi for an orphan subscription with this billing_subscription_id");
    return "expired_pending";
  }

  const first = await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, deps);
  if (first.paid) return first.outcome;
  if ((await deps.store.getBillingSubscription(row.id))?.status !== "PENDING") return first.outcome;

  await deps.culqi.cancelSubscription(row.externalSubscriptionId);
  // A charge made just before the cancellation still counts.
  const second = await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, deps);
  if (second.paid) return second.outcome;
  await fail("confirmation_timeout");
  await deps.store.markProviderCanceled(row.id);
  deps.logger.info({ event: "billing.culqi.pending_expired", organizationId: row.organizationId, billingSubscriptionId: row.id, reason: first.reason }, "unconfirmed checkout cancelled at Culqi (confirmation_timeout)");
  return "expired_pending";
}

export async function reconcileDueCulqiSubscriptions(deps: BillingDeps): Promise<{ reconciled: number; expired: number; failed: number }> {
  if (!deps.culqi) return { reconciled: 0, expired: 0, failed: 0 };
  const culqiDeps = { ...deps, culqi: deps.culqi };
  const at = now(deps);
  let reconciled = 0;
  let expired = 0;
  let failed = 0;

  const due = await deps.store.listDueForReconciliation({
    endBefore: new Date(at + CULQI_RECONCILE_WINDOW_MS).toISOString(),
    endAfter: new Date(at - CULQI_RECONCILE_LOOKBACK_MS).toISOString(),
    limit: BATCH
  });
  for (const row of due) {
    try {
      await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, culqiDeps);
      reconciled += 1;
    } catch (error) {
      failed += 1;
      deps.logger.warn({ event: "billing.culqi.reconcile_failed", billingSubscriptionId: row.id, err: serializeError(error) }, "periodic Culqi reconciliation failed; retried next run");
    }
  }

  const stale = await deps.store.listStalePending({
    withSubscriptionCreatedBefore: new Date(at - CULQI_PENDING_CONFIRMATION_TIMEOUT_MS).toISOString(),
    withoutSubscriptionCreatedBefore: new Date(at - CULQI_PENDING_INCOMPLETE_TIMEOUT_MS).toISOString(),
    limit: BATCH
  });
  for (const row of stale) {
    try {
      if ((await expireStalePending(row, culqiDeps)) === "expired_pending") expired += 1;
    } catch (error) {
      failed += 1;
      deps.logger.warn({ event: "billing.culqi.expire_failed", billingSubscriptionId: row.id, err: serializeError(error) }, "stale checkout not closed; retried next run");
    }
  }
  if (reconciled + expired + failed > 0) deps.logger.info({ event: "billing.culqi.reconcile_due", reconciled, expired, failed }, "periodic Culqi reconciliation");
  return { reconciled, expired, failed };
}
