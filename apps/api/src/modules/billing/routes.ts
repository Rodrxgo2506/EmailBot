import {
  CulqiApiError,
  culqiPlanMismatch,
  createCulqiClient,
  culqiEnvironment,
  culqiEventJobId,
  culqiReconcileJobId,
  safeEqual,
  serializeError,
  type CulqiClient
} from "@emailbot/shared";
import type { BillingCheckoutOptions, BillingCheckoutResult, BillingConfig, BillingSubscriptionSummary } from "@emailbot/types";
import { billingCheckoutQuerySchema, billingSubscriptionCreateSchema, culqiWebhookBodySchema } from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../deps.js";
import { AppError, badRequest, conflict, notFound, serviceUnavailable, unauthorized, unprocessable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import type { BillingPrice } from "../../repositories/types.js";
import { requestEntitlements } from "../plans/entitlements.js";
import { decideCheckout } from "./policy.js";

/*
 * Commercial V1 phase 2: Culqi recurring subscriptions, SANDBOX ONLY (the
 * configuration refuses live keys). See docs/billing-culqi.md.
 *
 *   GET  /api/billing/config          card checkout available? (every member)
 *   GET  /api/billing/checkout        price + public key for Culqi Custom Checkout (organization:update)
 *   POST /api/billing/subscriptions   card token -> Culqi customer, card, subscription (organization:update)
 *   GET  /api/billing/subscriptions/current   latest Culqi subscription (every member)
 *   POST /webhooks/culqi              event id only; processed by the worker (re-read from Culqi)
 *
 * The browser never decides the price: it sends plan + period (+ token); the
 * amount comes from the EmailBot catalog and the Culqi plan is checked
 * against it. Access is granted only when the worker confirms the payment.
 */

const billingDisabled = () => serviceUnavailable("Card payments are not available yet", "BILLING_NOT_CONFIGURED");

function culqiClient(deps: AppDeps): CulqiClient {
  const config = deps.config.culqi;
  if (!config) throw billingDisabled();
  return createCulqiClient({ secretKey: config.secretKey, fetch: deps.fetch, baseUrl: config.apiUrl });
}

/** Price + Culqi plan of the requested plan / period, and whether this organization may buy it. */
async function prepareCheckout(request: FastifyRequest, deps: AppDeps, plan: BillingPrice["plan"], billingPeriod: BillingPrice["billingPeriod"]) {
  const environment = culqiEnvironment(deps.config.culqi?.secretKey ?? "");
  if (!deps.config.culqi || environment !== "test") throw billingDisabled();
  const organizationId = getOrganization(request).id;

  const price = await deps.billing.resolvePrice(plan, billingPeriod);
  if (!price) throw badRequest("This plan is not available", "PLAN_NOT_AVAILABLE");

  const [entitlements, subscription, order, hasPending] = await Promise.all([
    requestEntitlements(request).read(),
    getAuth(request).repos.plans.subscription(organizationId),
    deps.billing.planOrder(),
    deps.billing.hasPending(organizationId)
  ]);
  const decision = decideCheckout({ entitlements, subscription, target: plan, order, hasPending });
  if (!decision.ok) throw new AppError(decision.status, decision.code, decision.message);

  const externalPlanId = await deps.billing.providerPlanId(price.planPriceId, environment);
  if (!externalPlanId) {
    request.log.error({ event: "billing.culqi.plan_not_mapped", plan, billingPeriod, environment }, "no Culqi plan mapped to this EmailBot price");
    throw serviceUnavailable("This plan cannot be paid by card yet", "BILLING_PLAN_NOT_MAPPED");
  }
  return { price, externalPlanId, environment, kind: decision.kind, organizationId };
}

function toCulqiError(request: FastifyRequest, error: unknown, operation: string): AppError {
  if (error instanceof AppError) return error;
  request.log.warn({ event: "billing.culqi.call_failed", operation, err: serializeError(error) }, "Culqi call failed");
  if (error instanceof CulqiApiError && error.isClientError) {
    // Culqi refused the card / data (declined, invalid token...): no card data in the message.
    return new AppError(402, "PAYMENT_DECLINED", "The payment provider rejected the card or the data", { providerCode: error.code ?? error.type });
  }
  return new AppError(502, "PAYMENT_PROVIDER_ERROR", "The payment provider is not available right now. Try again later.");
}

export function billingRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const member = { preHandler: [app.authenticate, app.requireOrganization] };
    const manage = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("organization:update")] };

    app.get("/billing/config", member, async (): Promise<BillingConfig> => {
      const environment = deps.config.culqi ? culqiEnvironment(deps.config.culqi.secretKey) : null;
      return { enabled: environment === "test", environment: environment === "test" ? "test" : null };
    });

    app.get("/billing/checkout", manage, async (request): Promise<BillingCheckoutOptions> => {
      const query = parseWith(billingCheckoutQuerySchema, request.query, "query");
      const prepared = await prepareCheckout(request, deps, query.plan, query.billingPeriod);
      return {
        publicKey: deps.config.culqi?.publicKey as string,
        environment: prepared.environment,
        plan: prepared.price.plan,
        planName: prepared.price.planName,
        billingPeriod: prepared.price.billingPeriod,
        currency: prepared.price.currency,
        amount: prepared.price.amount,
        amountCents: prepared.price.amountCents,
        kind: prepared.kind,
        customerEmail: getAuth(request).user.email
      };
    });

    app.post(
      "/billing/subscriptions",
      { ...manage, config: { rateLimit: RATE_LIMITS.billingCheckout } },
      async (request, reply): Promise<BillingCheckoutResult> => {
        const input = parseWith(billingSubscriptionCreateSchema, request.body);
        const user = getAuth(request).user;
        if (!user.email) throw badRequest("Your account needs a verified e-mail to pay", "EMAIL_REQUIRED");
        const prepared = await prepareCheckout(request, deps, input.plan, input.billingPeriod);
        const { price, externalPlanId, environment, organizationId } = prepared;
        const culqi = culqiClient(deps);

        // The Culqi plan must be exactly the EmailBot price (amount, currency, period): never charge another amount.
        const culqiPlan = await culqi.getPlan(externalPlanId).catch((error: unknown) => {
          throw toCulqiError(request, error, "getPlan");
        });
        const planMismatch = culqiPlan
          ? culqiPlanMismatch(culqiPlan, { planId: externalPlanId, environment, amountCents: price.amountCents, currency: price.currency, billingPeriod: price.billingPeriod })
          : "PLAN_NOT_FOUND";
        if (planMismatch) {
          request.log.error({ event: "billing.culqi.plan_mismatch", reason: planMismatch, plan: price.plan, billingPeriod: price.billingPeriod, externalPlanId }, "Culqi plan does not match the EmailBot price");
          throw serviceUnavailable("This plan cannot be paid by card yet", "BILLING_PLAN_MISMATCH");
        }

        // F5: the checkout is reserved atomically (one PENDING per organization, unique index) BEFORE anything is
        // created at Culqi, so two concurrent requests never create two customers / cards / subscriptions.
        const billingId = await deps.billing.createPending({
          organizationId,
          planPriceId: price.planPriceId,
          environment,
          externalPlanId,
          createdBy: user.id
        });
        if (!billingId) throw conflict("A payment is already being confirmed for this organization", "CHECKOUT_IN_PROGRESS");
        const fail = async (code: string, message: string | null) => {
          await deps.billing.markFailed(billingId, code, message, request.id).catch((error: unknown) => {
            request.log.error({ event: "billing.culqi.mark_failed_error", billingSubscriptionId: billingId, err: serializeError(error) }, "could not mark the checkout as failed");
          });
        };
        const failWith = async (error: unknown, fallback: string) =>
          fail(error instanceof CulqiApiError ? (error.code ?? error.type ?? fallback) : fallback, error instanceof CulqiApiError ? error.merchantMessage : null);

        // Customer (one per organization and environment), only while the reservation is held.
        let customerId: string;
        try {
          const stored = await deps.billing.customerId(organizationId, environment);
          if (stored) {
            customerId = stored;
          } else {
            const customer = {
              first_name: input.customer.firstName,
              last_name: input.customer.lastName,
              email: user.email,
              address: input.customer.address,
              address_city: input.customer.addressCity,
              country_code: input.customer.countryCode,
              phone_number: input.customer.phoneNumber,
              metadata: { organization_id: organizationId }
            };
            let created: string;
            try {
              created = (await culqi.createCustomer(customer)).id;
            } catch (error) {
              // Culqi already knows this e-mail (e.g. the same person pays for another organization): reuse it.
              const existing = error instanceof CulqiApiError && error.isClientError ? await culqi.findCustomerByEmail(user.email).catch(() => null) : null;
              if (!existing) throw error;
              created = existing.id;
            }
            customerId = await deps.billing.saveCustomer(organizationId, environment, created, user.id);
          }
          await deps.billing.attachCustomer(billingId, customerId);
        } catch (error) {
          await failWith(error, "customer_error");
          if (error instanceof AppError) throw error;
          throw toCulqiError(request, error, "createCustomer");
        }

        let cardId: string;
        try {
          const card = await culqi.createCard({ customer_id: customerId, token_id: input.tokenId, metadata: { organization_id: organizationId } });
          if (card.kind === "REVIEW_3DS") {
            await fail("three_ds_required", null);
            throw unprocessable("The card requires 3-D Secure authentication, which is not available yet", "THREE_DS_REQUIRED");
          }
          cardId = card.id;
        } catch (error) {
          if (error instanceof AppError) throw error;
          await failWith(error, "card_error");
          throw toCulqiError(request, error, "createCard");
        }

        let culqiSubscription;
        try {
          culqiSubscription = await culqi.createSubscription({
            card_id: cardId,
            plan_id: externalPlanId,
            tyc: input.acceptTerms,
            metadata: { organization_id: organizationId, billing_subscription_id: billingId }
          });
        } catch (error) {
          await failWith(error, "subscription_error");
          throw toCulqiError(request, error, "createSubscription");
        }

        try {
          await deps.billing.attachCulqiSubscription(billingId, {
            externalCardId: cardId,
            externalSubscriptionId: culqiSubscription.id,
            providerStatus: Number.isInteger(culqiSubscription.status) ? culqiSubscription.status : null
          });
        } catch (error) {
          // Never leave a Culqi subscription EmailBot does not know about: cancel it (best effort) and free the slot.
          request.log.error({ event: "billing.culqi.attach_failed", billingSubscriptionId: billingId, err: serializeError(error) }, "Culqi subscription not stored; cancelling it");
          await culqi.cancelSubscription(culqiSubscription.id).catch((cancelError: unknown) => {
            request.log.error({ event: "billing.culqi.orphan_subscription", billingSubscriptionId: billingId, err: serializeError(cancelError) }, "orphan Culqi subscription: cancel it manually");
          });
          await fail("attach_failed", null);
          throw error;
        }
        await app.audit(request, {
          action: "CREATE",
          entityType: "billing_subscription",
          entityId: billingId,
          metadata: { event: "billing.checkout.started", provider: "CULQI", environment, plan: price.plan, billingPeriod: price.billingPeriod, kind: prepared.kind }
        });

        // Confirmation is asynchronous (webhook); the worker also re-reads the subscription in case no webhook arrives.
        await deps.queue
          .enqueueEmailEvent({ type: "CULQI_RECONCILE", billingSubscriptionId: billingId }, { jobId: culqiReconcileJobId(billingId) })
          .catch((error: unknown) => request.log.warn({ event: "billing.culqi.reconcile_enqueue_failed", billingSubscriptionId: billingId, err: serializeError(error) }, "reconciliation not queued; the webhook confirms"));

        const summary = (await deps.billing.get(organizationId, billingId)) as BillingSubscriptionSummary;
        reply.status(202);
        return { billingSubscription: summary };
      }
    );

    app.get("/billing/subscriptions/current", member, async (request): Promise<{ billingSubscription: BillingSubscriptionSummary | null }> => {
      return { billingSubscription: await deps.billing.current(getOrganization(request).id) };
    });
  };
}

/** POST /webhooks/culqi: authenticates (optional URL token), deduplicates, enqueues. Never processes inline. */
export function culqiWebhookRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    app.post("/webhooks/culqi", { config: { rateLimit: RATE_LIMITS.webhook } }, async (request, reply) => {
      const culqi = deps.config.culqi;
      if (!culqi) throw notFound("Route");

      if (culqi.webhookToken) {
        const token = (request.query as Record<string, unknown> | undefined)?.token;
        if (typeof token !== "string" || !safeEqual(token, culqi.webhookToken)) {
          request.log.warn({ event: "billing.culqi.webhook_rejected", reason: "invalid_token" }, "Culqi webhook rejected");
          throw unauthorized("Invalid webhook token");
        }
      }

      const body = culqiWebhookBodySchema.safeParse(request.body);
      if (!body.success) {
        request.log.warn({ event: "billing.culqi.webhook_rejected", reason: "malformed" }, "malformed Culqi webhook");
        throw badRequest("Malformed event", "INVALID_EVENT");
      }
      const eventId = body.data.id;
      const environment = culqiEnvironment(eventId);
      if (!environment || environment !== culqiEnvironment(culqi.secretKey)) {
        // Acknowledged so Culqi does not retry it, never processed: this API only serves the sandbox.
        request.log.warn({ event: "billing.culqi.webhook_ignored", reason: "environment" }, "Culqi webhook from another environment ignored");
        return reply.status(200).send({ received: true });
      }

      const recorded = await deps.billing.recordWebhookEvent(environment, eventId);
      if (!recorded.isNew && (recorded.status === "PROCESSED" || recorded.status === "IGNORED")) {
        return reply.status(200).send({ received: true, duplicate: true });
      }
      // A redelivery of an event whose processing failed gets a new job (the failed one is retained by BullMQ).
      const jobId = recorded.status === "FAILED" ? `${culqiEventJobId(eventId)}-${recorded.attempts}` : culqiEventJobId(eventId);
      try {
        await deps.queue.enqueueEmailEvent({ type: "CULQI_EVENT", eventId }, { jobId });
      } catch (error) {
        request.log.error({ event: "billing.culqi.enqueue_failed", err: serializeError(error) }, "Culqi event not queued; Culqi will retry");
        throw serviceUnavailable("Event queue unavailable");
      }
      request.log.info({ event: "billing.culqi.webhook_accepted", type: body.data.type?.slice(0, 100) ?? null, duplicate: !recorded.isNew }, "Culqi event accepted");
      return reply.status(200).send({ received: true });
    });
  };
}
