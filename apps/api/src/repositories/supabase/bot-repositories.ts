import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { BotRepository, BotWrite } from "../types.js";
import { BOT_COLUMNS, toBot, type Row } from "./mappers.js";

/* Bots (EmailBot V2). Runs as the caller: RLS limits writes to OWNER/ADMIN of the organization. */

function toBotColumns(input: BotWrite): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (input.name !== undefined) columns.name = input.name;
  if (input.slug !== undefined) columns.slug = input.slug;
  if (input.description !== undefined) columns.description = input.description;
  if (input.status !== undefined) columns.status = input.status;
  if (input.customerResolution !== undefined) columns.customer_resolution = input.customerResolution;
  if (input.portalSettings !== undefined) columns.portal_settings = input.portalSettings;
  return columns;
}

export function botRepository(db: SupabaseClient): BotRepository {
  return {
    async list(organizationId) {
      const rows = unwrap(
        await db.from("bots").select(BOT_COLUMNS).eq("organization_id", organizationId).order("name", { ascending: true })
      ) as Row[];
      return rows.map(toBot);
    },

    async get(organizationId, id) {
      const row = unwrap(
        await db.from("bots").select(BOT_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle()
      ) as Row | null;
      return row ? toBot(row) : null;
    },

    async create(organizationId, userId, input) {
      const row = unwrap(
        await db
          .from("bots")
          .insert({ ...toBotColumns(input), organization_id: organizationId, created_by: userId, updated_by: userId })
          .select(BOT_COLUMNS)
          .single()
      ) as Row;
      return toBot(row);
    },

    async update(organizationId, id, userId, patch) {
      const row = unwrap(
        await db
          .from("bots")
          .update({ ...toBotColumns(patch), updated_by: userId })
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(BOT_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toBot(row) : null;
    },

    async remove(organizationId, id) {
      const rows = unwrap(
        await db.from("bots").delete().eq("organization_id", organizationId).eq("id", id).select("id")
      ) as Row[];
      return rows.length > 0;
    },

    async hasEmails(organizationId, id) {
      const rows = unwrap(
        await db.from("emails").select("id").eq("organization_id", organizationId).eq("bot_id", id).limit(1)
      ) as Row[];
      return rows.length > 0;
    },

    async hasCustomerLinks(organizationId, id) {
      const [assignments, identifiers] = await Promise.all([
        db.from("bot_customer_assignments").select("bot_id").eq("organization_id", organizationId).eq("bot_id", id).limit(1),
        db.from("customer_identifiers").select("id").eq("organization_id", organizationId).eq("bot_id", id).limit(1)
      ]);
      return (unwrap(assignments) as Row[]).length > 0 || (unwrap(identifiers) as Row[]).length > 0;
    }
  };
}
