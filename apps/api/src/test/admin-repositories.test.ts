import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { adminOperations } from "../repositories/supabase/admin-repositories.js";

/*
 * Mapping of the paged admin.* functions (EmailBot V2 phase 6). The SQL
 * returns the total with every row (count(*) over the filtered set), so a
 * page past the end has no rows: the repository must still report the real
 * total. The functions themselves are covered by
 * packages/database/test/platform-admin.test.ts.
 */

const ACTOR = "44444444-4444-4444-8444-444444444444";
const ORG = "11111111-1111-4111-8111-111111111111";

type Args = Record<string, unknown>;

/** Fake service client: admin.<fn>(args) answers from `table`, sliced like the SQL (limit / offset, total on each row). */
function fakeService(table: Record<string, Array<Record<string, unknown>>>) {
  const rpc = vi.fn(async (fn: string, args: Args) => {
    const all = table[fn] ?? [];
    const offset = Number(args.p_offset ?? 0);
    const limit = Number(args.p_limit ?? 25);
    return { data: all.slice(offset, offset + limit).map((row) => ({ ...row, total_count: all.length })), error: null };
  });
  const schema = vi.fn(() => ({ rpc }));
  return { service: { schema } as unknown as SupabaseClient, rpc, schema };
}

const organization = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name: `Org ${n}`,
  slug: `org-${n}`,
  plan: "FREE",
  status: "ACTIVE",
  owner_user_id: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z"
});

const customer = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  display_name: `Cliente ${n}`,
  status: "ACTIVE",
  bot_names: [],
  deliveries_count: 0,
  created_at: "2026-10-01T00:00:00.000Z"
});

describe("admin repositories: paged totals", () => {
  const query = { sort: "created_desc" as const, limit: 2, offset: 0 };

  it("organizations: an in-range page reports the total from its rows (one call)", async () => {
    const { service, rpc } = fakeService({ list_organizations: [1, 2, 3].map(organization) });
    const result = await adminOperations(service).listOrganizations(ACTOR, query);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("organizations: a page past the end keeps the real total, with the same filters", async () => {
    const { service, rpc } = fakeService({ list_organizations: [1, 2, 3].map(organization) });
    const result = await adminOperations(service).listOrganizations(ACTOR, { ...query, search: "org", status: "ACTIVE", plan: "FREE", offset: 10 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(3);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("list_organizations", {
      p_actor_id: ACTOR,
      p_search: "org",
      p_status: "ACTIVE",
      p_plan: "FREE",
      p_sort: "created_desc",
      p_limit: 1,
      p_offset: 0
    });
  });

  it("organizations: no results at all reports 0", async () => {
    const { service } = fakeService({ list_organizations: [] });
    expect((await adminOperations(service).listOrganizations(ACTOR, { ...query, offset: 50 })).total).toBe(0);
    expect((await adminOperations(service).listOrganizations(ACTOR, query)).total).toBe(0);
  });

  it("customers: a page past the end keeps the real total", async () => {
    const { service, rpc } = fakeService({ list_customers: [1, 2, 3, 4, 5].map(customer) });
    const result = await adminOperations(service).listCustomers(ACTOR, ORG, { limit: 25, offset: 25 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(5);
    expect(rpc).toHaveBeenLastCalledWith("list_customers", { p_actor_id: ACTOR, p_organization_id: ORG, p_limit: 1, p_offset: 0 });
  });

  it("customers: an in-range page needs one call", async () => {
    const { service, rpc } = fakeService({ list_customers: [1, 2, 3].map(customer) });
    const result = await adminOperations(service).listCustomers(ACTOR, ORG, { limit: 2, offset: 2 });
    expect(result.items.map((item) => item.displayName)).toEqual(["Cliente 3"]);
    expect(result.total).toBe(3);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
