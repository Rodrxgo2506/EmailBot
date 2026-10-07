import type {
  AdminActivityItem,
  AdminAuditEntry,
  AdminBot,
  AdminCustomer,
  AdminEmailAccount,
  AdminMember,
  AdminOrganizationDetail,
  AdminOrganizationSummary,
  AdminPaymentEvent,
  AdminPlanPrice,
  AdminStats,
  AdminSubscription
} from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { AdminOperations } from "../types.js";
import { toDecimalString } from "./plan-repositories.js";
import type { Row } from "./mappers.js";

/*
 * Platform administration (EmailBot V2 phase 6). SERVICE ROLE, but ONLY the
 * admin.* functions: no table access (the service role has none on these
 * tables), every function re-checks the actor in the database and returns
 * an explicit list of metadata columns. Routes call this after
 * requirePlatformAdmin.
 */

const count = (value: unknown): number => Number(value ?? 0);

function toSummary(row: Row): AdminOrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    owner: row.owner_user_id ? { userId: row.owner_user_id, email: row.owner_email ?? null, fullName: row.owner_name ?? null } : null,
    membersCount: count(row.members_count),
    botsCount: count(row.bots_count),
    customersCount: count(row.customers_count),
    emailAccountsCount: count(row.email_accounts_count),
    processedEmailsCount: count(row.processed_emails_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * The paged admin.* functions return the total with every row (count(*)
 * over the filtered set). A page past the end has no rows, so the total is
 * read again from the first row of the same filtered set: the response keeps
 * the real total instead of 0.
 */
async function totalOf(rows: Row[], offset: number, firstRow: () => Promise<Row[]>): Promise<number> {
  if (rows.length > 0 || offset <= 0) return count(rows[0]?.total_count);
  return count((await firstRow())[0]?.total_count);
}

export function adminOperations(service: SupabaseClient): AdminOperations {
  const admin = () => service.schema("admin");

  return {
    async isPlatformAdmin(userId) {
      return (unwrap(await admin().rpc("is_platform_admin", { p_user_id: userId })) as boolean | null) === true;
    },

    async stats(actorId) {
      const stats = unwrap(await admin().rpc("platform_stats", { p_actor_id: actorId })) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, count(value)])) as unknown as AdminStats;
    },

    async listOrganizations(actorId, query) {
      const page = async (limit: number, offset: number) =>
        unwrap(
          await admin().rpc("list_organizations", {
            p_actor_id: actorId,
            p_search: query.search ?? null,
            p_status: query.status ?? null,
            p_plan: query.plan ?? null,
            p_sort: query.sort,
            p_limit: limit,
            p_offset: offset
          })
        ) as Row[];
      const rows = await page(query.limit, query.offset);
      return { items: rows.map(toSummary), total: await totalOf(rows, query.offset, () => page(1, 0)) };
    },

    async getOrganization(actorId, organizationId) {
      const rows = unwrap(await admin().rpc("get_organization", { p_actor_id: actorId, p_organization_id: organizationId })) as Row[];
      const row = rows[0];
      if (!row) return null;
      return {
        ...toSummary(row),
        rulesCount: count(row.rules_count),
        emailsCount: count(row.emails_count),
        deliveriesCount: count(row.deliveries_count)
      } satisfies AdminOrganizationDetail;
    },

    async createOrganization(actorId, input) {
      return unwrap(
        await admin().rpc("create_organization", {
          p_actor_id: actorId,
          p_name: input.name,
          p_slug: input.slug,
          p_plan: null,
          p_owner_user_id: input.ownerUserId,
          p_request_id: input.requestId
        })
      ) as string;
    },

    async updateOrganization(actorId, organizationId, patch, requestId) {
      const rows = unwrap(
        await admin().rpc("update_organization", {
          p_actor_id: actorId,
          p_organization_id: organizationId,
          p_plan: null,
          p_status: patch.status,
          p_request_id: requestId
        })
      ) as Row[];
      return rows.length > 0;
    },

    async listPlanPrices(actorId) {
      const rows = unwrap(await admin().rpc("list_plan_prices", { p_actor_id: actorId })) as Row[];
      return rows.map(
        (row): AdminPlanPrice => ({
          id: row.plan_price_id,
          plan: row.plan,
          planName: row.plan_name,
          billingPeriod: row.billing_period,
          currency: row.currency,
          amount: toDecimalString(row.amount),
          amountCents: Number(row.amount_cents)
        })
      );
    },

    async listSubscriptions(actorId, organizationId) {
      const rows = unwrap(await admin().rpc("list_subscriptions", { p_actor_id: actorId, p_organization_id: organizationId })) as Row[];
      return rows.map(
        (row): AdminSubscription => ({
          id: row.id,
          status: row.status,
          plan: row.plan,
          billingPeriod: row.billing_period,
          currency: row.currency,
          listAmount: toDecimalString(row.list_amount),
          paymentMethod: row.payment_method,
          origin: row.origin,
          startedAt: row.started_at,
          currentPeriodStart: row.current_period_start,
          currentPeriodEnd: row.current_period_end,
          canceledAt: row.canceled_at ?? null,
          suspendedAt: row.suspended_at ?? null,
          expiredAt: row.expired_at ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        })
      );
    },

    async listPaymentEvents(actorId, organizationId, limit) {
      const rows = unwrap(
        await admin().rpc("list_payment_events", { p_actor_id: actorId, p_organization_id: organizationId, p_limit: limit })
      ) as Row[];
      return rows.map(
        (row): AdminPaymentEvent => ({
          id: row.id,
          subscriptionId: row.subscription_id ?? null,
          eventType: row.event_type,
          paymentMethod: row.payment_method,
          amount: row.amount === null || row.amount === undefined ? null : toDecimalString(row.amount),
          currency: row.currency,
          status: row.status,
          reference: row.reference ?? null,
          note: row.note ?? null,
          occurredAt: row.occurred_at,
          processedAt: row.processed_at ?? null
        })
      );
    },

    async activateSubscription(actorId, organizationId, input, requestId) {
      const rows = unwrap(
        await admin().rpc("activate_subscription", {
          p_actor_id: actorId,
          p_organization_id: organizationId,
          p_plan: input.plan,
          p_billing_period: input.billingPeriod,
          p_payment_method: input.paymentMethod,
          // Decimal string: PostgreSQL parses it as numeric (never a float on the way).
          p_amount: input.amount,
          p_period_start: input.periodStart,
          p_period_end: input.periodEnd,
          p_reference: input.reference ?? null,
          p_note: input.note ?? null,
          p_request_id: requestId
        })
      ) as Row[];
      const row = rows[0];
      if (!row) throw new Error("admin.activate_subscription returned no row");
      return { subscriptionId: row.subscription_id, outcome: row.outcome };
    },

    async updateSubscriptionStatus(actorId, subscriptionId, action, reason, requestId) {
      const rows = unwrap(
        await admin().rpc("update_subscription_status", {
          p_actor_id: actorId,
          p_subscription_id: subscriptionId,
          p_action: action.toUpperCase(),
          p_reason: reason,
          p_request_id: requestId
        })
      ) as Row[];
      const row = rows[0];
      return row ? { subscriptionId: row.subscription_id, organizationId: row.organization_id, status: row.status } : null;
    },

    async listMembers(actorId, organizationId) {
      const rows = unwrap(await admin().rpc("list_members", { p_actor_id: actorId, p_organization_id: organizationId })) as Row[];
      return rows.map(
        (row): AdminMember => ({ userId: row.user_id, email: row.email ?? null, fullName: row.full_name ?? null, role: row.role, joinedAt: row.joined_at })
      );
    },

    async listBots(actorId, organizationId) {
      const rows = unwrap(await admin().rpc("list_bots", { p_actor_id: actorId, p_organization_id: organizationId })) as Row[];
      return rows.map(
        (row): AdminBot => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          rulesCount: count(row.rules_count),
          activeCustomersCount: count(row.active_customers_count),
          deliveriesCount: count(row.deliveries_count),
          createdAt: row.created_at
        })
      );
    },

    async listCustomers(actorId, organizationId, page) {
      const fetchPage = async (limit: number, offset: number) =>
        unwrap(
          await admin().rpc("list_customers", { p_actor_id: actorId, p_organization_id: organizationId, p_limit: limit, p_offset: offset })
        ) as Row[];
      const rows = await fetchPage(page.limit, page.offset);
      return {
        items: rows.map(
          (row): AdminCustomer => ({
            id: row.id,
            displayName: row.display_name,
            status: row.status,
            bots: (row.bot_names as string[] | null) ?? [],
            deliveriesCount: count(row.deliveries_count),
            createdAt: row.created_at
          })
        ),
        total: await totalOf(rows, page.offset, () => fetchPage(1, 0))
      };
    },

    async listEmailAccounts(actorId, organizationId) {
      const rows = unwrap(await admin().rpc("list_email_accounts", { p_actor_id: actorId, p_organization_id: organizationId })) as Row[];
      return rows.map(
        (row): AdminEmailAccount => ({
          id: row.id,
          provider: row.provider,
          emailAddress: row.email_address,
          status: row.status,
          lastSyncedAt: row.last_synced_at ?? null,
          lastErrorCode: row.last_error_code ?? null,
          watchExpiresAt: row.watch_expires_at ?? null,
          watchErrorCode: row.watch_error_code ?? null,
          createdAt: row.created_at
        })
      );
    },

    async listActivity(actorId, query) {
      const rows = unwrap(
        await admin().rpc("list_activity", {
          p_actor_id: actorId,
          p_organization_id: query.organizationId ?? null,
          p_limit: query.limit,
          p_offset: query.offset
        })
      ) as Row[];
      return rows.map(
        (row): AdminActivityItem => ({
          id: row.id,
          organization: { id: row.organization_id, name: row.organization_name },
          actorType: row.actor_type,
          action: row.action,
          entityType: row.entity_type ?? null,
          event: row.event ?? null,
          createdAt: row.created_at
        })
      );
    },

    async listAudit(actorId, query) {
      const rows = unwrap(
        await admin().rpc("list_audit", {
          p_actor_id: actorId,
          p_organization_id: query.organizationId ?? null,
          p_limit: query.limit,
          p_offset: query.offset
        })
      ) as Row[];
      return rows.map(
        (row): AdminAuditEntry => ({
          id: row.id,
          actor: { userId: row.actor_user_id ?? null, email: row.actor_email ?? null },
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id ?? null,
          organization: row.organization_id ? { id: row.organization_id, name: row.organization_name ?? null } : null,
          metadata: (row.metadata as Record<string, unknown> | null) ?? {},
          createdAt: row.created_at
        })
      );
    }
  };
}
