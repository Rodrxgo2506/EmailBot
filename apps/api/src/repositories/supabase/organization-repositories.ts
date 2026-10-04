import type { OrganizationRole } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { MemberRepository, MembershipRepository, OrganizationRepository } from "../types.js";
import {
  MEMBER_COLUMNS,
  ORGANIZATION_COLUMNS,
  SETTINGS_COLUMNS,
  toMember,
  toOrganization,
  toSettings,
  type Row
} from "./mappers.js";

export function membershipRepository(db: SupabaseClient): MembershipRepository {
  return {
    async listForUser(userId) {
      const rows = unwrap(
        await db
          .from("organization_members")
          .select(`role, organization:organizations(${ORGANIZATION_COLUMNS})`)
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
      ) as Row[];

      return rows
        .filter((row) => row.organization)
        .map((row) => ({ role: row.role as OrganizationRole, organization: toOrganization(row.organization) }));
    },

    async findRole(userId, organizationId) {
      const row = unwrap(
        await db
          .from("organization_members")
          .select("role")
          .eq("user_id", userId)
          .eq("organization_id", organizationId)
          .maybeSingle()
      ) as Row | null;

      return (row?.role as OrganizationRole | undefined) ?? null;
    },

    async findAccess(userId, organizationId) {
      const row = unwrap(
        await db
          .from("organization_members")
          .select("role, organization:organizations(status)")
          .eq("user_id", userId)
          .eq("organization_id", organizationId)
          .maybeSingle()
      ) as Row | null;

      if (!row) return null;
      // Fail closed: a membership whose organization status cannot be read is treated as inactive.
      const organization = Array.isArray(row.organization) ? row.organization[0] : row.organization;
      return { role: row.role as OrganizationRole, organizationStatus: organization?.status ?? "SUSPENDED" };
    }
  };
}

export function organizationRepository(db: SupabaseClient): OrganizationRepository {
  return {
    async create(name, slug) {
      // SECURITY DEFINER RPC: creates the organization and makes auth.uid() its OWNER.
      return unwrap(await db.rpc("create_organization", { p_name: name, p_slug: slug })) as string;
    },

    async get(organizationId) {
      const row = unwrap(
        await db.from("organizations").select(ORGANIZATION_COLUMNS).eq("id", organizationId).maybeSingle()
      ) as Row | null;
      return row ? toOrganization(row) : null;
    },

    async update(organizationId, patch) {
      const row = unwrap(
        await db.from("organizations").update(patch).eq("id", organizationId).select(ORGANIZATION_COLUMNS).maybeSingle()
      ) as Row | null;
      return row ? toOrganization(row) : null;
    },

    async getSettings(organizationId) {
      const row = unwrap(
        await db
          .from("organization_settings")
          .select(SETTINGS_COLUMNS)
          .eq("organization_id", organizationId)
          .maybeSingle()
      ) as Row | null;
      return row ? toSettings(row) : null;
    },

    async updateSettings(organizationId, patch) {
      const row = unwrap(
        await db
          .from("organization_settings")
          .update(patch)
          .eq("organization_id", organizationId)
          .select(SETTINGS_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toSettings(row) : null;
    },

    async transferOwnership(organizationId, newOwnerUserId) {
      // The RPC verifies that auth.uid() is the current OWNER and swaps roles atomically.
      unwrap(
        await db.rpc("transfer_organization_ownership", {
          target_organization_id: organizationId,
          new_owner_user_id: newOwnerUserId
        })
      );
    }
  };
}

export function memberRepository(db: SupabaseClient): MemberRepository {
  return {
    async list(organizationId) {
      const rows = unwrap(
        await db
          .from("organization_members")
          .select(MEMBER_COLUMNS)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true })
      ) as Row[];
      return rows.map(toMember);
    },

    async get(organizationId, memberId) {
      const row = unwrap(
        await db
          .from("organization_members")
          .select(MEMBER_COLUMNS)
          .eq("organization_id", organizationId)
          .eq("id", memberId)
          .maybeSingle()
      ) as Row | null;
      return row ? toMember(row) : null;
    },

    async add(organizationId, userId, role) {
      const row = unwrap(
        await db
          .from("organization_members")
          .insert({ organization_id: organizationId, user_id: userId, role })
          .select(MEMBER_COLUMNS)
          .single()
      ) as Row;
      return toMember(row);
    },

    async updateRole(organizationId, memberId, role) {
      const row = unwrap(
        await db
          .from("organization_members")
          .update({ role })
          .eq("organization_id", organizationId)
          .eq("id", memberId)
          .select(MEMBER_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toMember(row) : null;
    },

    async remove(organizationId, memberId) {
      const rows = unwrap(
        await db
          .from("organization_members")
          .delete()
          .eq("organization_id", organizationId)
          .eq("id", memberId)
          .select("id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}
