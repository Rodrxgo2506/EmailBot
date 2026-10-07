import {
  collectCulqiIds,
  culqiEnvironment,
  culqiTimestamp,
  CulqiApiError,
  isHandledCulqiEvent,
  mapCulqiSubscriptionStatus,
  serializeError,
  type CulqiClient,
  type CulqiSubscription
} from "@emailbot/shared";
import type { BillingStore, BillingSubscriptionRow, Logger } from "./ports.js";

/*
 * Commercial V1 phase 2 (Culqi SANDBOX): webhook events and reconciliation.
 *
 * Nothing the webhook request contains is trusted: the event is re-read from
 * Culqi's API by its id (GET /v2/events/{id}, secret key) and the subscription
 * it mentions is re-read too (GET /v2/recurrent/subscriptions/{id}). EmailBot
 * applies the subscription's CURRENT state, so duplicated or out-of-order
 * events converge to the same result:
 *
 *   Culqi status 3 (Activa) or a verified subscription.charge.succeeded
 *     -> public.billing_activate_culqi_subscription, keyed by
 *        (subscription, billing cycle): a webhook and a reconciliation of the
 *        same cycle are applied once; an older cycle never shortens the period.
 *   subscription.charge.failed -> declined charge recorded once (event id);
 *        billing row FAILED (first charge) or PAST_DUE (renewal); access unchanged.
 *   4 (Cancelada) / 6 (Vencida) -> CANCELED / EXPIRED (provider side only).
 *   1 / 2 / 5 without a failure -> still waiting.
 *
 * Culqi charges subscriptions in a daily batch, so the EmailBot period ends
 * CULQI_RENEWAL_GRACE_MS after Culqi's next billing date: the renewal has time
 * to arrive before the expiration sweep (provisional policy, see docs).
 */

export const CULQI_RENEWAL_GRACE_MS = 3 * 24 * 3600_000;

const PERIOD_MS = { MONTHLY: 31 * 24 * 3600_000, YEARLY: 366 * 24 * 3600_000 } as const;

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
  | "ignored"
  | "not_configured";

/** The subscription has not been charged yet: the reconciliation job is retried later (BullMQ backoff). */
export class CulqiStillPendingError extends Error {
  constructor(readonly billingSubscriptionId: string) {
    super("The Culqi subscription has not been charged yet");
    this.name = "CulqiStillPendingError";
  }
}

const now = (deps: BillingDeps) => (deps.now ? deps.now() : Date.now());

function errorText(error: unknown): string {
  if (error instanceof CulqiApiError) return `${error.operation}: HTTP ${error.status} ${error.code ?? error.type ?? ""}`.trim();
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

/** One key per (Culqi subscription, billing cycle): the cycle is identified by Culqi's next billing date. */
export function activationKey(subscription: CulqiSubscription): string {
  const cycle = culqiTimestamp(subscription.next_billing_date)?.getTime() ?? `p${subscription.current_period ?? 0}`;
  return `culqi:${subscription.id}:${cycle}`;
}

/** EmailBot period for a confirmed charge: until Culqi's next billing date + grace (or one plan interval). */
export function confirmedPeriod(subscription: CulqiSubscription, billingPeriod: BillingSubscriptionRow["billingPeriod"], at: number) {
  const next = culqiTimestamp(subscription.next_billing_date)?.getTime();
  const end = (next !== undefined && next > at ? next : at + PERIOD_MS[billingPeriod]) + CULQI_RENEWAL_GRACE_MS;
  return { start: new Date(at).toISOString(), end: new Date(end).toISOString() };
}

async function cancelReplaced(organizationId: string, deps: BillingDeps & { culqi: CulqiClient }): Promise<void> {
  for (const replaced of await deps.store.listUnconfirmedCancellations(organizationId)) {
    // Already gone at Culqi (404) counts as canceled. Any other error is retried with the job.
    await deps.culqi.cancelSubscription(replaced.externalSubscriptionId);
    await deps.store.markProviderCanceled(replaced.id);
    deps.logger.info({ event: "billing.culqi.replaced_canceled", organizationId, billingSubscriptionId: replaced.id }, "replaced Culqi subscription canceled");
  }
}

interface Trigger {
  eventId: string | null;
  eventType: string | null;
  chargeId: string | null;
}

async function applySubscriptionState(
  row: BillingSubscriptionRow,
  subscription: CulqiSubscription,
  trigger: Trigger,
  deps: BillingDeps & { culqi: CulqiClient }
): Promise<BillingOutcome> {
  const requestId = trigger.eventId ?? `reconcile:${row.id}`;
  const providerStatus = Number.isInteger(subscription.status) ? subscription.status : null;
  const base = { billingSubscriptionId: row.id, providerStatus, requestId };

  if (trigger.eventId && (trigger.eventType === "subscription.charge.failed" || trigger.eventType === "charge.creation.failed")) {
    const recorded = await deps.store.recordChargeFailure({
      ...base,
      externalEventId: trigger.eventId,
      eventType: trigger.eventType,
      externalChargeId: trigger.chargeId,
      // Culqi does not document the failure fields of the event data: a generic code (no card data).
      failureCode: "charge_failed",
      failureMessage: null
    });
    return recorded === "DUPLICATE" ? "duplicate" : "charge_failed";
  }

  if (trigger.eventType === "subscription.creation.failed") {
    await deps.store.setStatus({ ...base, status: "FAILED", cancelReason: null, failureCode: "subscription_creation_failed", failureMessage: null });
    return "status_changed";
  }

  const mapped = mapCulqiSubscriptionStatus(subscription.status, row.status);
  const verifiedCharge = trigger.eventType === "subscription.charge.succeeded" && mapped !== "CANCELED" && mapped !== "EXPIRED";

  if (mapped === "ACTIVE" || verifiedCharge) {
    const at = now(deps);
    const period = confirmedPeriod(subscription, row.billingPeriod, at);
    const result = await deps.store.activate({
      ...base,
      activationKey: activationKey(subscription),
      eventType: trigger.eventType ?? "subscription.charge.reconciled",
      periodStart: period.start,
      periodEnd: period.end,
      currentPeriod: typeof subscription.current_period === "number" ? subscription.current_period : null,
      externalChargeId: trigger.chargeId
    });
    deps.logger.info(
      { event: "billing.culqi.activation", outcome: result.outcome, organizationId: row.organizationId, billingSubscriptionId: row.id },
      "Culqi payment applied"
    );
    await cancelReplaced(row.organizationId, deps);
    if (result.outcome === "DUPLICATE") return "duplicate";
    if (result.outcome === "ALREADY_COVERED") return "already_covered";
    if (result.outcome === "IGNORED") return "ignored";
    return "activated";
  }

  if (mapped === "PAST_DUE" || mapped === "CANCELED" || mapped === "EXPIRED") {
    const changed = await deps.store.setStatus({
      ...base,
      status: mapped,
      cancelReason: mapped === "CANCELED" ? (row.cancelReason ?? "PROVIDER") : null,
      failureCode: mapped === "PAST_DUE" ? "charge_retrying" : null,
      failureMessage: null
    });
    return changed === "CHANGED" ? "status_changed" : "ignored";
  }

  if (mapped === null) {
    deps.logger.warn({ event: "billing.culqi.unknown_status", billingSubscriptionId: row.id, providerStatus }, "unknown Culqi subscription status");
    return "ignored";
  }
  return "pending";
}

/** CULQI_EVENT: the webhook event, re-read from Culqi and applied once. */
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
    const subscriptionId = ids.subscriptionIds[0] ?? null;
    const chargeId = ids.chargeIds[0] ?? null;
    await deps.store.updateWebhookEvent(eventId, { eventType, externalSubscriptionId: subscriptionId, externalChargeId: chargeId });
    if (!subscriptionId) return await ignore("NO_SUBSCRIPTION");

    const row = await deps.store.findBillingSubscriptionByExternalId(subscriptionId);
    if (!row) return await ignore("UNKNOWN_SUBSCRIPTION");

    const subscription = await deps.culqi.getSubscription(subscriptionId);
    if (!subscription) return await ignore("SUBSCRIPTION_NOT_FOUND_AT_CULQI");

    const outcome = await applySubscriptionState(row, subscription, { eventId, eventType, chargeId }, culqiDeps);
    await deps.store.updateWebhookEvent(eventId, { status: "PROCESSED", lastError: null, processed: true });
    deps.logger.info({ event: "billing.culqi.event_processed", eventId, eventType, outcome, billingSubscriptionId: row.id }, "Culqi event processed");
    return outcome;
  } catch (error) {
    await deps.store.updateWebhookEvent(eventId, { status: "FAILED", lastError: errorText(error) }).catch(() => undefined);
    deps.logger.warn({ event: "billing.culqi.event_failed", eventId, err: serializeError(error) }, "Culqi event processing failed; retried");
    throw error;
  }
}

/**
 * CULQI_RECONCILE: re-reads one Culqi subscription after a checkout (works
 * without webhooks). Throws CulqiStillPendingError while Culqi has not charged
 * it, so BullMQ retries with backoff.
 */
export async function reconcileCulqiSubscription(billingSubscriptionId: string, deps: BillingDeps): Promise<BillingOutcome> {
  if (!deps.culqi) {
    deps.logger.error({ event: "billing.culqi.not_configured", billingSubscriptionId }, "Culqi reconciliation skipped: CULQI_SECRET_KEY is not configured on the worker");
    return "not_configured";
  }
  const culqiDeps = { ...deps, culqi: deps.culqi };
  const row = await deps.store.getBillingSubscription(billingSubscriptionId);
  if (!row?.externalSubscriptionId || row.status === "CANCELED" || row.status === "EXPIRED") return "ignored";
  if (row.status === "ACTIVE") {
    await cancelReplaced(row.organizationId, culqiDeps);
    return "duplicate";
  }

  const subscription = await deps.culqi.getSubscription(row.externalSubscriptionId);
  if (!subscription) return "ignored";
  const outcome = await applySubscriptionState(row, subscription, { eventId: null, eventType: null, chargeId: null }, culqiDeps);
  if (outcome === "pending") throw new CulqiStillPendingError(row.id);
  return outcome;
}
