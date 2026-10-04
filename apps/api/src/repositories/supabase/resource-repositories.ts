import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { CategoryRepository, EmailAccountRepository, RuleRepository, RuleWrite } from "../types.js";
import {
  CATEGORY_COLUMNS,
  EMAIL_ACCOUNT_COLUMNS,
  RULE_COLUMNS,
  toCategory,
  toEmailAccount,
  toRule,
  type Row
} from "./mappers.js";

export function emailAccountRepository(db: SupabaseClient): EmailAccountRepository {
  return {
    async list(organizationId) {
      const rows = unwrap(
        await db
          .from("email_accounts")
          .select(EMAIL_ACCOUNT_COLUMNS)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true })
      ) as Row[];
      return rows.map(toEmailAccount);
    },

    async get(organizationId, id) {
      const row = unwrap(
        await db
          .from("email_accounts")
          .select(EMAIL_ACCOUNT_COLUMNS)
          .eq("organization_id", organizationId)
          .eq("id", id)
          .maybeSingle()
      ) as Row | null;
      return row ? toEmailAccount(row) : null;
    },

    async update(organizationId, id, patch) {
      const row = unwrap(
        await db
          .from("email_accounts")
          .update(patch)
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(EMAIL_ACCOUNT_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toEmailAccount(row) : null;
    },

    async remove(organizationId, id) {
      const rows = unwrap(
        await db.from("email_accounts").delete().eq("organization_id", organizationId).eq("id", id).select("id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}

export function categoryRepository(db: SupabaseClient): CategoryRepository {
  return {
    async list(organizationId) {
      const rows = unwrap(
        await db
          .from("categories")
          .select(CATEGORY_COLUMNS)
          .eq("organization_id", organizationId)
          .order("sort_order", { ascending: true })
          .order("name", { ascending: true })
      ) as Row[];
      return rows.map(toCategory);
    },

    async get(organizationId, id) {
      const row = unwrap(
        await db.from("categories").select(CATEGORY_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle()
      ) as Row | null;
      return row ? toCategory(row) : null;
    },

    async create(organizationId, input) {
      const row = unwrap(
        await db
          .from("categories")
          .insert({ ...input, organization_id: organizationId })
          .select(CATEGORY_COLUMNS)
          .single()
      ) as Row;
      return toCategory(row);
    },

    async update(organizationId, id, patch) {
      const row = unwrap(
        await db
          .from("categories")
          .update(patch)
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(CATEGORY_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toCategory(row) : null;
    },

    async remove(organizationId, id) {
      const rows = unwrap(
        await db.from("categories").delete().eq("organization_id", organizationId).eq("id", id).select("id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}

function toRuleColumns(input: RuleWrite): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (input.name !== undefined) columns.name = input.name;
  if (input.description !== undefined) columns.description = input.description;
  if (input.enabled !== undefined) columns.enabled = input.enabled;
  if (input.priority !== undefined) columns.priority = input.priority;
  if (input.stopProcessing !== undefined) columns.stop_processing = input.stopProcessing;
  if (input.matchMode !== undefined) columns.match_mode = input.matchMode;
  if (input.categoryId !== undefined) columns.category_id = input.categoryId;
  // JSONB documents keep the shape defined by migration 2.
  if (input.conditions !== undefined) columns.conditions = { conditions: input.conditions };
  if (input.actions !== undefined) columns.actions = { actions: input.actions };
  return columns;
}

export function ruleRepository(db: SupabaseClient): RuleRepository {
  return {
    async list(organizationId) {
      const rows = unwrap(
        await db
          .from("email_rules")
          .select(RULE_COLUMNS)
          .eq("organization_id", organizationId)
          .order("priority", { ascending: true })
          .order("created_at", { ascending: true })
      ) as Row[];
      return rows.map(toRule);
    },

    async get(organizationId, id) {
      const row = unwrap(
        await db.from("email_rules").select(RULE_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle()
      ) as Row | null;
      return row ? toRule(row) : null;
    },

    async create(organizationId, userId, input) {
      const row = unwrap(
        await db
          .from("email_rules")
          .insert({ ...toRuleColumns(input), organization_id: organizationId, created_by: userId, updated_by: userId })
          .select(RULE_COLUMNS)
          .single()
      ) as Row;
      return toRule(row);
    },

    async update(organizationId, id, userId, patch) {
      const row = unwrap(
        await db
          .from("email_rules")
          .update({ ...toRuleColumns(patch), updated_by: userId })
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(RULE_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toRule(row) : null;
    },

    async remove(organizationId, id) {
      const rows = unwrap(
        await db.from("email_rules").delete().eq("organization_id", organizationId).eq("id", id).select("id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}
