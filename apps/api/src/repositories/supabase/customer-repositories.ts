import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type {
  BotCustomerAssignmentRepository,
  CustomerIdentifierRepository,
  CustomerIdentifierWrite,
  CustomerRepository,
  CustomerWrite
} from "../types.js";
import {
  ASSIGNMENT_COLUMNS,
  CUSTOMER_COLUMNS,
  IDENTIFIER_COLUMNS,
  toAssignment,
  toCustomer,
  toCustomerIdentifier,
  type Row
} from "./mappers.js";

/*
 * Customers, identifiers and bot assignments (EmailBot V2, phase 2). Every
 * query runs as the caller (RLS) AND filters by the active organization.
 */

/**
 * Characters with a meaning in PostgREST filter syntax or LIKE patterns are
 * dropped from search terms, so a term can never add filters or wildcards.
 */
export function sanitizeSearchTerm(term: string): string {
  return term
    .replace(/[,()"'\\*%:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identifier matches considered by a customer search (bounded). */
const SEARCH_IDENTIFIER_LIMIT = 200;

function toCustomerColumns(input: CustomerWrite): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (input.displayName !== undefined) columns.display_name = input.displayName;
  if (input.status !== undefined) columns.status = input.status;
  if (input.externalRef !== undefined) columns.external_ref = input.externalRef;
  if (input.notes !== undefined) columns.notes = input.notes;
  return columns;
}

export function customerRepository(db: SupabaseClient): CustomerRepository {
  return {
    async list(organizationId, query) {
      const from = (query.page - 1) * query.pageSize;
      let request = db.from("customers").select(CUSTOMER_COLUMNS, { count: "exact" }).eq("organization_id", organizationId);
      if (query.status) request = request.eq("status", query.status);

      const term = query.search ? sanitizeSearchTerm(query.search) : "";
      if (term) {
        const matches = unwrap(
          await db
            .from("customer_identifiers")
            .select("customer_id")
            .eq("organization_id", organizationId)
            .ilike("normalized_value", `%${term.toLowerCase()}%`)
            .limit(SEARCH_IDENTIFIER_LIMIT)
        ) as Row[];
        const ids = [...new Set(matches.map((row) => row.customer_id as string))];
        const filters = [`display_name.ilike."*${term}*"`, `external_ref.ilike."*${term}*"`];
        if (ids.length > 0) filters.push(`id.in.(${ids.join(",")})`);
        request = request.or(filters.join(","));
      }

      const result = await request
        .order("display_name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + query.pageSize - 1);
      const rows = unwrap(result) as Row[];
      return { items: rows.map(toCustomer), page: query.page, pageSize: query.pageSize, total: result.count ?? rows.length };
    },

    async get(organizationId, id) {
      const row = unwrap(
        await db.from("customers").select(CUSTOMER_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle()
      ) as Row | null;
      return row ? toCustomer(row) : null;
    },

    async create(organizationId, userId, input) {
      const row = unwrap(
        await db
          .from("customers")
          .insert({ ...toCustomerColumns(input), organization_id: organizationId, created_by: userId })
          .select(CUSTOMER_COLUMNS)
          .single()
      ) as Row;
      return toCustomer(row);
    },

    async update(organizationId, id, patch) {
      const row = unwrap(
        await db
          .from("customers")
          .update(toCustomerColumns(patch))
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(CUSTOMER_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toCustomer(row) : null;
    }
  };
}

function toIdentifierColumns(input: CustomerIdentifierWrite): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (input.value !== undefined) columns.value = input.value;
  if (input.normalizedValue !== undefined) columns.normalized_value = input.normalizedValue;
  if (input.botId !== undefined) columns.bot_id = input.botId;
  if (input.active !== undefined) columns.active = input.active;
  return columns;
}

export function customerIdentifierRepository(db: SupabaseClient): CustomerIdentifierRepository {
  const scoped = (organizationId: string, customerId: string) =>
    db.from("customer_identifiers").select(IDENTIFIER_COLUMNS).eq("organization_id", organizationId).eq("customer_id", customerId);

  return {
    async list(organizationId, customerId) {
      const rows = unwrap(
        await scoped(organizationId, customerId).order("type", { ascending: true }).order("normalized_value", { ascending: true })
      ) as Row[];
      return rows.map(toCustomerIdentifier);
    },

    async get(organizationId, customerId, id) {
      const row = unwrap(await scoped(organizationId, customerId).eq("id", id).maybeSingle()) as Row | null;
      return row ? toCustomerIdentifier(row) : null;
    },

    async create(organizationId, customerId, input) {
      const row = unwrap(
        await db
          .from("customer_identifiers")
          .insert({
            organization_id: organizationId,
            customer_id: customerId,
            type: input.type,
            value: input.value,
            normalized_value: input.normalizedValue,
            bot_id: input.botId,
            active: input.active
          })
          .select(IDENTIFIER_COLUMNS)
          .single()
      ) as Row;
      return toCustomerIdentifier(row);
    },

    async update(organizationId, customerId, id, patch) {
      const row = unwrap(
        await db
          .from("customer_identifiers")
          .update(toIdentifierColumns(patch))
          .eq("organization_id", organizationId)
          .eq("customer_id", customerId)
          .eq("id", id)
          .select(IDENTIFIER_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toCustomerIdentifier(row) : null;
    },

    async remove(organizationId, customerId, id) {
      const rows = unwrap(
        await db
          .from("customer_identifiers")
          .delete()
          .eq("organization_id", organizationId)
          .eq("customer_id", customerId)
          .eq("id", id)
          .select("id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}

const WITH_CUSTOMER = `${ASSIGNMENT_COLUMNS},customer:customers(id,display_name,status,external_ref)`;
const WITH_BOT = `${ASSIGNMENT_COLUMNS},bot:bots(id,name,slug,status)`;

export function botCustomerRepository(db: SupabaseClient): BotCustomerAssignmentRepository {
  return {
    async listForBot(organizationId, botId) {
      const rows = unwrap(
        await db
          .from("bot_customer_assignments")
          .select(WITH_CUSTOMER)
          .eq("organization_id", organizationId)
          .eq("bot_id", botId)
          .order("created_at", { ascending: true })
      ) as Row[];
      return rows.map(toAssignment);
    },

    async listForCustomer(organizationId, customerId) {
      const rows = unwrap(
        await db
          .from("bot_customer_assignments")
          .select(WITH_BOT)
          .eq("organization_id", organizationId)
          .eq("customer_id", customerId)
          .order("created_at", { ascending: true })
      ) as Row[];
      return rows.map(toAssignment);
    },

    async get(organizationId, botId, customerId) {
      const row = unwrap(
        await db
          .from("bot_customer_assignments")
          .select(WITH_CUSTOMER)
          .eq("organization_id", organizationId)
          .eq("bot_id", botId)
          .eq("customer_id", customerId)
          .maybeSingle()
      ) as Row | null;
      return row ? toAssignment(row) : null;
    },

    async create(organizationId, userId, botId, customerId, active) {
      const row = unwrap(
        await db
          .from("bot_customer_assignments")
          .insert({ organization_id: organizationId, bot_id: botId, customer_id: customerId, active, created_by: userId })
          .select(WITH_CUSTOMER)
          .single()
      ) as Row;
      return toAssignment(row);
    },

    async update(organizationId, botId, customerId, active) {
      const row = unwrap(
        await db
          .from("bot_customer_assignments")
          .update({ active })
          .eq("organization_id", organizationId)
          .eq("bot_id", botId)
          .eq("customer_id", customerId)
          .select(WITH_CUSTOMER)
          .maybeSingle()
      ) as Row | null;
      return row ? toAssignment(row) : null;
    },

    async remove(organizationId, botId, customerId) {
      const rows = unwrap(
        await db
          .from("bot_customer_assignments")
          .delete()
          .eq("organization_id", organizationId)
          .eq("bot_id", botId)
          .eq("customer_id", customerId)
          .select("bot_id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}
