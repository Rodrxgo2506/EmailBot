import { isCommercialPlan, type BillingSubscriptionSummary, type CommercialPlan } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { BillingRepository } from "../types.js";
import type { Row } from "./mappers.js";
import { toDecimalString } from "./plan-repositories.js";

/*
 * Commercial V1 phase 2 (Culqi SANDBOX): billing_* tables through the SERVICE
 * ROLE (no Data API access for members). Every query is scoped by the
 * organization the route already resolved and authorized.
 */

const PROVIDER = "CULQI";

const SUMMARY_COLUMNS =
  "id,status,environment,created_at,activated_at,current_period_end,canceled_at,cancel_reason,failure_code,failure_message," +
  "price:plan_prices(billing_period,plan:plan_catalog(code))";

export function toBillingSummary(row: Row): BillingSubscriptionSummary {
  const price = Array.isArray(row.price) ? row.price[0] : row.price;
  const plan = Array.isArray(price?.plan) ? price.plan[0] : price?.plan;
  return {
    id: row.id,
    status: row.status,
    plan: plan?.code,
    billingPeriod: price?.billing_period,
    environment: row.environment,
    createdAt: row.created_at,
    activatedAt: row.activated_at ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    canceledAt: row.canceled_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    failureCode: row.failure_code ?? null,
    failureMessage: row.failure_message ?? null
  };
}

export function billingRepository(service: SupabaseClient): BillingRepository {
  return {
    async resolvePrice(plan, billingPeriod) {
      const rows = unwrap(
        await service
          .from("plan_prices")
          .select("id,billing_period,currency,amount,amount_cents,active,plan:plan_catalog!inner(code,name,sort_order,active)")
          .eq("billing_period", billingPeriod)
          .eq("active", true)
          .eq("plan.code", plan)
          .eq("plan.active", true)
      ) as Row[];
      const row = rows[0];
      const catalog = Array.isArray(row?.plan) ? row.plan[0] : row?.plan;
      if (!row || !catalog || catalog.code !== plan) return null;
      return {
        planPriceId: row.id,
        plan,
        planName: catalog.name,
        billingPeriod,
        currency: row.currency,
        amount: toDecimalString(row.amount),
        amountCents: Number(row.amount_cents),
        sortOrder: Number(catalog.sort_order)
      };
    },

    async planOrder() {
      const rows = unwrap(await service.from("plan_catalog").select("code,sort_order").eq("active", true)) as Row[];
      const order: Partial<Record<CommercialPlan, number>> = {};
      for (const row of rows) if (isCommercialPlan(String(row.code))) order[row.code as CommercialPlan] = Number(row.sort_order);
      return order;
    },

    async providerPlanId(planPriceId, environment) {
      const row = unwrap(
        await service
          .from("billing_provider_plans")
          .select("external_plan_id")
          .eq("plan_price_id", planPriceId)
          .eq("provider", PROVIDER)
          .eq("environment", environment)
          .maybeSingle()
      ) as Row | null;
      return row?.external_plan_id ?? null;
    },

    async customerId(organizationId, environment) {
      const row = unwrap(
        await service
          .from("billing_customers")
          .select("external_customer_id")
          .eq("organization_id", organizationId)
          .eq("provider", PROVIDER)
          .eq("environment", environment)
          .maybeSingle()
      ) as Row | null;
      return row?.external_customer_id ?? null;
    },

    async saveCustomer(organizationId, environment, externalCustomerId, createdBy) {
      unwrap(
        await service
          .from("billing_customers")
          .upsert(
            { organization_id: organizationId, provider: PROVIDER, environment, external_customer_id: externalCustomerId, created_by: createdBy },
            { onConflict: "organization_id,provider,environment", ignoreDuplicates: true }
          )
      );
      return (await this.customerId(organizationId, environment)) ?? externalCustomerId;
    },

    async hasPending(organizationId) {
      const rows = unwrap(
        await service.from("billing_subscriptions").select("id").eq("organization_id", organizationId).eq("status", "PENDING").limit(1)
      ) as Row[];
      return rows.length > 0;
    },

    async createPending(input) {
      const result = await service
        .from("billing_subscriptions")
        .insert({
          organization_id: input.organizationId,
          plan_price_id: input.planPriceId,
          provider: PROVIDER,
          environment: input.environment,
          status: "PENDING",
          external_customer_id: input.externalCustomerId,
          external_plan_id: input.externalPlanId,
          created_by: input.createdBy
        })
        .select("id")
        .single();
      // billing_subscriptions_one_pending: another checkout of this organization is waiting for Culqi.
      if (result.error?.code === "23505") return null;
      return (unwrap(result) as Row).id as string;
    },

    async attachCulqiSubscription(id, input) {
      unwrap(
        await service
          .from("billing_subscriptions")
          .update({
            external_card_id: input.externalCardId,
            external_subscription_id: input.externalSubscriptionId,
            provider_status: input.providerStatus
          })
          .eq("id", id)
      );
    },

    async markFailed(id, failureCode, failureMessage, requestId) {
      unwrap(
        await service.rpc("billing_set_culqi_status", {
          p_billing_subscription_id: id,
          p_status: "FAILED",
          p_provider_status: null,
          p_cancel_reason: null,
          p_failure_code: failureCode,
          p_failure_message: failureMessage,
          p_request_id: requestId
        })
      );
    },

    async get(organizationId, id) {
      const row = unwrap(
        await service.from("billing_subscriptions").select(SUMMARY_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle()
      ) as Row | null;
      return row ? toBillingSummary(row) : null;
    },

    async current(organizationId) {
      const rows = unwrap(
        await service
          .from("billing_subscriptions")
          .select(SUMMARY_COLUMNS)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false })
          .limit(1)
      ) as Row[];
      return rows[0] ? toBillingSummary(rows[0]) : null;
    },

    async recordWebhookEvent(environment, externalEventId) {
      const inserted = unwrap(
        await service
          .from("billing_webhook_events")
          .upsert({ provider: PROVIDER, environment, external_event_id: externalEventId }, { onConflict: "provider,external_event_id", ignoreDuplicates: true })
          .select("status,attempts")
      ) as Row[];
      if (inserted.length > 0) return { isNew: true, status: "RECEIVED", attempts: 0 };
      const existing = unwrap(
        await service.from("billing_webhook_events").select("status,attempts").eq("provider", PROVIDER).eq("external_event_id", externalEventId).single()
      ) as Row;
      return { isNew: false, status: String(existing.status), attempts: Number(existing.attempts) };
    }
  };
}
