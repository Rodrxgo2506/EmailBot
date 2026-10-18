import {
  collectCulqiIds,
  CULQI_CHARGE_DECLINED_CODE,
  CULQI_CHARGE_SUCCESS_OUTCOME,
  culqiAmountToCents,
  culqiEnvironment,
  culqiPlanMismatch,
  culqiTimestamp,
  isConfirmedCulqiDecline,
  CulqiApiError,
  CULQI_SUBSCRIPTION_STATUS,
  isHandledCulqiEvent,
  mapCulqiSubscriptionStatus,
  serializeError,
  type CulqiCharge,
  type CulqiClient,
  type CulqiPlan,
  type CulqiSubscription
} from "@emailbot/shared";
import type { BillingStore, BillingSubscriptionRow, Logger, UnconfirmedChargeTrace } from "./ports.js";

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
 *      periods) is read back (GET /v2/charges/{id}) and verified (F1): linked
 *      to this subscription (listed in it) or to its card / customer, amount
 *      and currency of the catalog, then classified (verifyCulqiCharge):
 *        PAID         confirmed sale: captured, outcome venta_exitosa / AUT0000,
 *                     authorization code, nothing refunded, no dispute;
 *        DECLINED     confirmed decline only (isConfirmedCulqiDecline: "card_declined" or an
 *                     observed operacion_denegada code, e.g. DNGE0015, without authorization);
 *        UNCONFIRMED  neither: not applied and NOTHING cancelled, read again later;
 *      `paid` is never used (the sandbox returned paid: false for an approved charge);
 *   3. ONLY a verified paid charge activates, keyed by its charge id: a
 *      webhook and a reconciliation of the same charge apply it once;
 *   4. a declined charge is recorded once (charge id) and only a confirmed
 *      decline cancels the Culqi subscription; Culqi statuses only move the
 *      provider side to PAST_DUE / CANCELED / EXPIRED / FAILED.
 *
 * A "subscription created" event or a Culqi status 3 ("Activa") never
 * activates anything by itself. Nothing from the webhook request is trusted.
 *
 * An UNCONFIRMED checkout is never cancelled automatically: the post-checkout
 * job retries for about CULQI_RECONCILE_RETRY_WINDOW_MS, then the periodic job
 * reads it every hour; after CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS it becomes
 * REVIEW_REQUIRED (no longer blocks a new checkout, alert logged) and is still
 * read daily, so a later confirmed sale or decline resolves it.
 */

/** Culqi charges subscriptions in a daily batch: the EmailBot period ends this long after the paid interval. */
export const CULQI_RENEWAL_GRACE_MS = 3 * 24 * 3600_000;
/** F3: subscriptions are re-read from this long before the end of their period (renewal charge window). */
export const CULQI_RECONCILE_WINDOW_MS = CULQI_RENEWAL_GRACE_MS + 24 * 3600_000;
/** F3: and until this long after it (late renewals / retries). */
export const CULQI_RECONCILE_LOOKBACK_MS = 7 * 24 * 3600_000;
/**
 * F4: a checkout whose Culqi subscription has NO charge at all after this long
 * is cancelled at Culqi and FAILED (confirmation_timeout). 48 h covers Culqi's
 * daily charging batch plus a retry day. A checkout with a charge that is
 * neither confirmed nor declined is never cancelled (see the review delay).
 */
export const CULQI_PENDING_CONFIRMATION_TIMEOUT_MS = 48 * 3600_000;
/** F4: a checkout that never got its Culqi subscription id (interrupted) is FAILED after this long. */
export const CULQI_PENDING_INCOMPLETE_TIMEOUT_MS = 30 * 60_000;
/**
 * The post-checkout reconciliation (CULQI_RECONCILE_JOB_OPTIONS: 10 attempts, exponential backoff) covers about this
 * long; from then on the periodic job (CULQI_RECONCILE_DUE, hourly) reads the PENDING checkouts from the database.
 */
export const CULQI_RECONCILE_RETRY_WINDOW_MS = 2 * 3600_000;
/**
 * A checkout whose charge stays neither confirmed nor declined this long after its creation becomes REVIEW_REQUIRED:
 * it stops blocking new checkouts, nothing is cancelled at Culqi, an alert is logged (billing.culqi.review_required).
 */
export const CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS = 168;
export const CULQI_UNCONFIRMED_REVIEW_AFTER_MS = CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS * 3600_000;
/** REVIEW_REQUIRED checkouts are read again at most this often, while younger than the max age (then manual review only). */
export const CULQI_REVIEW_RECONCILE_INTERVAL_MS = 24 * 3600_000;
export const CULQI_REVIEW_RECONCILE_MAX_AGE_MS = 30 * 24 * 3600_000;
/** failure_code of a REVIEW_REQUIRED checkout (public.billing_mark_culqi_review_required). */
export const CULQI_REVIEW_CODE = "CULQI_UNCONFIRMED_REVIEW";
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
  | "review_required"
  | "review_conflict"
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

export type ChargeVerdict =
  | { kind: "PAID" }
  /** Confirmed decline: recorded, and a declined first charge cancels the Culqi subscription. */
  | { kind: "DECLINED"; code: string }
  /** Not this checkout's charge or not its price (or refunded / disputed): never applied. */
  | { kind: "REJECTED"; reason: string }
  /** Neither a confirmed sale nor a confirmed decline: not applied, nothing cancelled, read again later. */
  | { kind: "UNCONFIRMED"; reason: "CHARGE_STATUS_UNCONFIRMED" };

const hasText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

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

  if (culqiAmountToCents(charge.amount) !== row.amountCents) return { kind: "REJECTED", reason: "CHARGE_AMOUNT_MISMATCH" };
  if (charge.currency_code !== row.currency) return { kind: "REJECTED", reason: "CHARGE_CURRENCY_MISMATCH" };
  const refunded = culqiAmountToCents(charge.amount_refunded);
  if (refunded !== null && refunded > 0) return { kind: "REJECTED", reason: "CHARGE_REFUNDED" };
  if (charge.dispute === true) return { kind: "REJECTED", reason: "CHARGE_DISPUTED" };

  // A confirmed decline only (isConfirmedCulqiDecline: "card_declined", or an observed operacion_denegada code
  // without authorization). `paid` and `capture` are never decline / success signals on their own.
  const outcome = charge.outcome ?? null;
  if (isConfirmedCulqiDecline(charge)) {
    const code = hasText(outcome?.decline_code) ? outcome.decline_code : (outcome?.code ?? CULQI_CHARGE_DECLINED_CODE);
    return { kind: "DECLINED", code: code.slice(0, 100) };
  }

  // A confirmed sale: all the evidence the sandbox returned for an approved, captured subscription charge.
  const confirmedSale =
    charge.capture === true &&
    outcome?.type === CULQI_CHARGE_SUCCESS_OUTCOME.type &&
    outcome.code === CULQI_CHARGE_SUCCESS_OUTCOME.code &&
    hasText(charge.authorization_code) &&
    refunded === 0 &&
    charge.dispute === false;
  return confirmedSale ? { kind: "PAID" } : { kind: "UNCONFIRMED", reason: "CHARGE_STATUS_UNCONFIRMED" };
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
  /** A charge of the subscription is neither confirmed nor declined: the Culqi subscription must not be cancelled. */
  unconfirmed: boolean;
  /** The last such charge (traceability: recorded on the row, included in the review alert). */
  unconfirmedCharge: UnconfirmedChargeTrace | null;
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
  if (!row.externalSubscriptionId) return { outcome: "ignored", reason: "NO_SUBSCRIPTION_ID", paid: false, unconfirmed: false, unconfirmedCharge: null };

  const subscription = await deps.culqi.getSubscription(row.externalSubscriptionId);
  if (!subscription) return { outcome: "rejected", reason: "SUBSCRIPTION_NOT_FOUND_AT_CULQI", paid: false, unconfirmed: false, unconfirmedCharge: null };
  const plan = await deps.culqi.getPlan(row.externalPlanId);
  const check = verifyCulqiSubscription(row, subscription, plan, deps.culqi.environment);
  if (!check.ok) {
    log("billing.culqi.subscription_rejected", { reason: check.reason }, "Culqi subscription does not match EmailBot: nothing applied", "warn");
    return { outcome: "rejected", reason: check.reason, paid: false, unconfirmed: false, unconfirmedCharge: null };
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
  let unconfirmed = 0;
  let lastUnconfirmed: UnconfirmedChargeTrace | null = null;
  let conflict = false;
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
      if (result.outcome === "CONFLICT") {
        // A checkout under review whose organization moved on since it began: never applied automatically.
        conflict = true;
        log(
          "billing.culqi.review_conflict",
          { alert: true, charge: id, plan: row.planCode, culqiSubscriptionId: row.externalSubscriptionId },
          "verified Culqi charge of a checkout under review NOT applied: the organization changed since it began; review it",
          "warn"
        );
        continue;
      }
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
    } else if (verdict.kind === "UNCONFIRMED") {
      unconfirmed += 1;
      lastUnconfirmed = { chargeId: id, outcomeType: charge?.outcome?.type ?? null, outcomeCode: charge?.outcome?.code ?? null, declineCode: charge?.outcome?.decline_code ?? null };
      log(
        "billing.culqi.charge_unconfirmed",
        {
          charge: id,
          reason: verdict.reason,
          outcomeType: charge?.outcome?.type ?? null,
          outcomeCode: charge?.outcome?.code ?? null,
          capture: charge?.capture ?? null,
          paid: charge?.paid ?? null,
          dispute: charge?.dispute ?? null,
          amountRefunded: charge?.amount_refunded ?? null,
          hasAuthorizationCode: hasText(charge?.authorization_code)
        },
        "Culqi charge neither confirmed nor declined: not applied, nothing cancelled; read again by the reconciliation",
        "warn"
      );
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
  if (current.status === "REVIEW_REQUIRED") {
    // Under review, only a verified charge (sale or decline) changes the row: the Culqi status alone never does.
    if (providerStatus !== null) log("billing.culqi.review_provider_status", { providerStatus }, "Culqi status of a checkout under review (row unchanged)");
  } else {
    if (trigger.eventType === "subscription.creation.failed" && !paid) await setStatus("FAILED", "subscription_creation_failed");
    if (mapped === "CANCELED" || mapped === "EXPIRED") await setStatus(mapped, null);
    else if (mapped === "PAST_DUE" && !applied) await setStatus("PAST_DUE", "charge_retrying");
    else if (mapped === null) log("billing.culqi.unknown_status", { providerStatus }, "unknown Culqi subscription status", "warn");
  }

  if (applied) await cancelReplaced(row.organizationId, deps);

  // F4: a first charge was declined: the Culqi subscription is stopped so it cannot charge later unnoticed
  // (unless Culqi already ended it: then nothing is cancelled nor marked).
  const endedAtCulqi = providerStatus === CULQI_SUBSCRIPTION_STATUS.CANCELED || providerStatus === CULQI_SUBSCRIPTION_STATUS.EXPIRED;
  if (declined > 0 && !paid && current.status === "FAILED") {
    if (endedAtCulqi) {
      log("billing.culqi.failed_subscription_already_ended", { providerStatus }, "declined checkout: Culqi subscription already ended, not cancelled again");
    } else {
      await deps.culqi.cancelSubscription(row.externalSubscriptionId);
      await deps.store.markProviderCanceled(row.id);
      log("billing.culqi.failed_subscription_canceled", {}, "Culqi subscription of a declined checkout canceled");
    }
  }

  // Traceability of PENDING / REVIEW_REQUIRED checkouts: last reconciliation and last unconfirmed charge.
  if (!applied && declined === 0 && (current.status === "PENDING" || current.status === "REVIEW_REQUIRED")) {
    await deps.store.recordReconciliation(row.id, { at: new Date(now(deps)).toISOString(), charge: lastUnconfirmed });
  }

  const ambiguous = unconfirmed > 0;
  const trace = { unconfirmedCharge: lastUnconfirmed };
  if (applied) return { outcome: "activated", reason: null, paid: true, unconfirmed: ambiguous, ...trace };
  if (declined > 0) return { outcome: "charge_failed", reason: null, paid, unconfirmed: ambiguous, ...trace };
  if (conflict) return { outcome: "review_conflict", reason: "REVIEW_CONFLICT", paid, unconfirmed: true, ...trace };
  if (statusChanged) return { outcome: "status_changed", reason: null, paid, unconfirmed: ambiguous, ...trace };
  if (duplicates > 0) return { outcome: "duplicate", reason: null, paid, unconfirmed: ambiguous, ...trace };
  // "pending", not "rejected": the post-checkout reconciliation keeps retrying and the periodic job reads it again.
  if (ambiguous) return { outcome: "pending", reason: "CHARGE_STATUS_UNCONFIRMED", paid, unconfirmed: true, ...trace };
  if (rejectedReason) return { outcome: "rejected", reason: rejectedReason, paid, unconfirmed: false, ...trace };
  return { outcome: "pending", reason: paid ? null : "NO_VERIFIED_CHARGE", paid, unconfirmed: false, ...trace };
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

/**
 * PENDING after the post-checkout retries (read every hour from the database):
 *   no Culqi subscription id after 30 min       -> FAILED (checkout_incomplete);
 *   a verified sale / decline                   -> applied by syncCulqiSubscription (ACTIVE / FAILED + cancel);
 *   a charge neither confirmed nor declined     -> kept PENDING (logged) until CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS,
 *                                                  then REVIEW_REQUIRED; NEVER cancelled at Culqi;
 *   no charge at all after 48 h (F4)            -> cancelled at Culqi and FAILED (confirmation_timeout).
 */
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

  const age = now(deps) - Date.parse(row.createdAt);
  const first = await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, deps);
  if (first.paid) return first.outcome;
  if ((await deps.store.getBillingSubscription(row.id))?.status !== "PENDING") return first.outcome;
  // F4 (cancel) applies ONLY to a verified Culqi subscription with no charge at all. A charge that is unconfirmed, or
  // rejected for integrity, or a subscription that does not match: never cancelled automatically, reviewed instead.
  const noChargeAtAll = !first.unconfirmed && first.outcome === "pending" && first.reason === "NO_VERIFIED_CHARGE";
  if (!noChargeAtAll) {
    if (age >= CULQI_UNCONFIRMED_REVIEW_AFTER_MS) return markReviewRequired(row, first.unconfirmedCharge, deps, requestId, first.reason);
    deps.logger.warn(
      { event: "billing.culqi.pending_unconfirmed_charge", organizationId: row.organizationId, billingSubscriptionId: row.id, reason: first.reason, chargeId: first.unconfirmedCharge?.chargeId ?? null },
      "checkout not confirmed nor declined by Culqi: kept PENDING (never cancelled), read again next run"
    );
    return first.outcome;
  }
  // No charge yet: Culqi charges in a daily batch; F4 only after the confirmation timeout.
  if (age < CULQI_PENDING_CONFIRMATION_TIMEOUT_MS) return first.outcome;

  await deps.culqi.cancelSubscription(row.externalSubscriptionId);
  // A charge made just before the cancellation still counts.
  const second = await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, deps);
  if (second.paid) return second.outcome;
  if (second.unconfirmed) {
    // A charge appeared at the last moment and cannot be confirmed: never FAILED on it; a person reviews it.
    await deps.store.markProviderCanceled(row.id);
    return markReviewRequired(row, second.unconfirmedCharge, deps, requestId, second.reason);
  }
  await fail("confirmation_timeout");
  await deps.store.markProviderCanceled(row.id);
  deps.logger.info({ event: "billing.culqi.pending_expired", organizationId: row.organizationId, billingSubscriptionId: row.id, reason: first.reason }, "unconfirmed checkout cancelled at Culqi (confirmation_timeout)");
  return "expired_pending";
}

/** PENDING -> REVIEW_REQUIRED with the operational alert (billing.culqi.review_required). Nothing is cancelled. */
async function markReviewRequired(
  row: BillingSubscriptionRow,
  charge: UnconfirmedChargeTrace | null,
  deps: BillingDeps & { culqi: CulqiClient },
  requestId: string,
  syncReason: string | null
): Promise<BillingOutcome> {
  const result = await deps.store.markReviewRequired({ billingSubscriptionId: row.id, reviewCode: CULQI_REVIEW_CODE, requestId });
  if (result === "IGNORED") return "pending"; // resolved meanwhile (no longer PENDING)
  deps.logger.warn(
    {
      event: "billing.culqi.review_required",
      alert: true,
      reason: CULQI_REVIEW_CODE,
      /** Why it could not be resolved: CHARGE_STATUS_UNCONFIRMED, an integrity rejection (CHARGE_*), a mismatch... */
      syncReason,
      result,
      organizationId: row.organizationId,
      billingSubscriptionId: row.id,
      culqiSubscriptionId: row.externalSubscriptionId,
      chargeId: charge?.chargeId ?? null,
      customerId: row.externalCustomerId,
      cardId: row.externalCardId,
      plan: row.planCode,
      billingPeriod: row.billingPeriod,
      amountCents: row.amountCents,
      currency: row.currency,
      environment: row.environment,
      createdAt: row.createdAt,
      lastReconciledAt: new Date(now(deps)).toISOString(),
      outcomeType: charge?.outcomeType ?? null,
      outcomeCode: charge?.outcomeCode ?? null,
      declineCode: charge?.declineCode ?? null
    },
    "checkout neither confirmed nor declined by Culqi in time: REVIEW_REQUIRED (not cancelled, no longer blocks new checkouts); review it in Culqi"
  );
  return "review_required";
}

/**
 * A REVIEW_REQUIRED checkout read again (at most daily, for CULQI_REVIEW_RECONCILE_MAX_AGE_MS): a confirmed sale is
 * activated unless the organization moved on (CONFLICT: kept for review), a confirmed decline ends it FAILED (and the
 * Culqi subscription is cancelled if still alive); otherwise nothing changes.
 */
export async function reconcileReviewRequired(row: BillingSubscriptionRow, deps: BillingDeps & { culqi: CulqiClient }): Promise<BillingOutcome> {
  const result = await syncCulqiSubscription(row, { eventId: null, eventType: null, chargeIds: [] }, deps);
  deps.logger.info(
    { event: "billing.culqi.review_reconciled", organizationId: row.organizationId, billingSubscriptionId: row.id, outcome: result.outcome, reason: result.reason },
    "checkout under review read again"
  );
  return result.outcome;
}

export interface DueReconciliationResult {
  reconciled: number;
  expired: number;
  /** PENDING checkouts that became REVIEW_REQUIRED in this run. */
  reviewRequired: number;
  /** REVIEW_REQUIRED checkouts read again in this run. */
  reviewed: number;
  failed: number;
}

export async function reconcileDueCulqiSubscriptions(deps: BillingDeps): Promise<DueReconciliationResult> {
  if (!deps.culqi) return { reconciled: 0, expired: 0, reviewRequired: 0, reviewed: 0, failed: 0 };
  const culqiDeps = { ...deps, culqi: deps.culqi };
  const at = now(deps);
  let reconciled = 0;
  let expired = 0;
  let reviewRequired = 0;
  let reviewed = 0;
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
    // After the post-checkout retries: every PENDING checkout with a Culqi subscription is read hourly.
    withSubscriptionCreatedBefore: new Date(at - CULQI_RECONCILE_RETRY_WINDOW_MS).toISOString(),
    withoutSubscriptionCreatedBefore: new Date(at - CULQI_PENDING_INCOMPLETE_TIMEOUT_MS).toISOString(),
    limit: BATCH
  });
  for (const row of stale) {
    try {
      const outcome = await expireStalePending(row, culqiDeps);
      if (outcome === "expired_pending") expired += 1;
      else if (outcome === "review_required") reviewRequired += 1;
    } catch (error) {
      failed += 1;
      deps.logger.warn({ event: "billing.culqi.expire_failed", billingSubscriptionId: row.id, err: serializeError(error) }, "stale checkout not closed; retried next run");
    }
  }
  // REVIEW_REQUIRED checkouts within their review window, at most once per interval each.
  const reviews = await deps.store.listReviewRequired({
    createdAfter: new Date(at - CULQI_REVIEW_RECONCILE_MAX_AGE_MS).toISOString(),
    reconciledBefore: new Date(at - CULQI_REVIEW_RECONCILE_INTERVAL_MS).toISOString(),
    limit: BATCH
  });
  for (const row of reviews) {
    try {
      await reconcileReviewRequired(row, culqiDeps);
      reviewed += 1;
    } catch (error) {
      failed += 1;
      deps.logger.warn({ event: "billing.culqi.review_reconcile_failed", billingSubscriptionId: row.id, err: serializeError(error) }, "checkout under review not read; retried next run");
    }
  }

  if (reconciled + expired + reviewRequired + reviewed + failed > 0) {
    deps.logger.info({ event: "billing.culqi.reconcile_due", reconciled, expired, reviewRequired, reviewed, failed }, "periodic Culqi reconciliation");
  }
  return { reconciled, expired, reviewRequired, reviewed, failed };
}
