import type {
  AdminActivityItem,
  AdminAuditEntry,
  AdminBot,
  AdminCustomer,
  AdminEmailAccount,
  AdminMember,
  AdminOrganizationDetail,
  AdminOrganizationSummary,
  AdminStats
} from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { AdminOperations } from "../types.js";
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
      const rows = unwrap(
        await admin().rpc("list_organizations", {
          p_actor_id: actorId,
          p_search: query.search ?? null,
          p_status: query.status ?? null,
          p_plan: query.plan ?? null,
          p_sort: query.sort,
          p_limit: query.limit,
          p_offset: query.offset
        })
      ) as Row[];
      return { items: rows.map(toSummary), total: count(rows[0]?.total_count) };
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
          p_plan: input.plan,
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
          p_plan: patch.plan ?? null,
          p_status: patch.status ?? null,
          p_request_id: requestId
        })
      ) as Row[];
      return rows.length > 0;
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
      const rows = unwrap(
        await admin().rpc("list_customers", { p_actor_id: actorId, p_organization_id: organizationId, p_limit: page.limit, p_offset: page.offset })
      ) as Row[];
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
        total: count(rows[0]?.total_count)
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
