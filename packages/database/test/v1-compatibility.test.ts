import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, type TestDatabase, type Tx } from "../src/harness.js";

/*
 * EmailBot V2 guard (docs/v2-implementation.md).
 *
 * V2 is additive: its migrations must not change how V1 data is protected.
 * This suite builds the schema twice - V1 only (migrations up to
 * V1_LAST_MIGRATION) and with every migration - and requires that:
 *   - V1 policies, RLS flags and V1 functions are identical;
 *   - no V1 grant was removed (new column grants are allowed);
 * plus invariants that every present and future table/function must meet.
 *
 * An intentional change to a V1 object must be listed in
 * INTENTIONAL_V1_CHANGES, which makes it visible in review.
 */

const V1_LAST_MIGRATION = "20261003150000_processing_completion.sql";

const V1_TABLES = [
  "audit_logs",
  "categories",
  "email_accounts",
  "email_attachments",
  "email_rules",
  "emails",
  "organization_members",
  "organization_settings",
  "organizations",
  "profiles"
] as const;

/** "schema.function" entries whose V1 definition a V2 migration changes on purpose. */
const INTENTIONAL_V1_CHANGES: readonly string[] = [];

/** SECURITY DEFINER functions the browser (authenticated) may call through PostgREST. */
const AUTHENTICATED_DEFINER_ALLOWLIST = [
  "private.can_view_profile",
  "private.has_organization_role",
  "private.is_organization_member",
  // V2 phase 5: manual deliveries (role checked inside, organization from the email).
  "public.add_manual_delivery",
  "public.create_organization",
  // V2 phase 4: customer Access ID administration (role checked inside, atomic).
  "public.issue_customer_access",
  "public.remove_manual_delivery",
  "public.revoke_customer_access",
  "public.revoke_customer_sessions",
  "public.transfer_organization_ownership"
];

/** Schemas owned by EmailBot (Supabase-managed schemas are out of scope). */
const OWN_SCHEMAS = ["public", "private", "portal"];

const DATA_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

interface Snapshot {
  policies: string[];
  rls: string[];
  functions: Record<string, string>;
  tableGrants: string[];
  columnGrants: string[];
}

async function rows<T>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}

async function snapshotV1(tx: Tx): Promise<Snapshot> {
  const tables = [...V1_TABLES];
  const policies = await rows<{ p: string }>(
    tx,
    `select concat_ws(' | ', tablename, policyname, permissive, cmd, roles::text, coalesce(qual, ''), coalesce(with_check, '')) as p
     from pg_policies where schemaname = 'public' and tablename = any($1) order by 1`,
    [tables]
  );
  const rls = await rows<{ r: string }>(
    tx,
    `select concat_ws(' | ', c.relname, c.relrowsecurity, c.relforcerowsecurity) as r
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1) order by 1`,
    [tables]
  );
  const functions = await rows<{ name: string; def: string }>(
    tx,
    `select n.nspname || '.' || p.proname as name, pg_get_functiondef(p.oid) as def
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind = 'f' order by 1`
  );
  const tableGrants = await rows<{ g: string }>(
    tx,
    `select concat_ws(' | ', table_name, grantee, privilege_type) as g
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'service_role')
     order by 1`,
    [tables]
  );
  const columnGrants = await rows<{ g: string }>(
    tx,
    `select concat_ws(' | ', table_name, column_name, grantee, privilege_type) as g
     from information_schema.column_privileges
     where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'service_role')
     order by 1`,
    [tables]
  );
  return {
    policies: policies.map((row) => row.p),
    rls: rls.map((row) => row.r),
    functions: Object.fromEntries(functions.map((row) => [row.name, row.def])),
    tableGrants: tableGrants.map((row) => row.g),
    columnGrants: columnGrants.map((row) => row.g)
  };
}

const v2Migrations = () => listMigrationFiles().filter((file) => file > V1_LAST_MIGRATION);

let v1: TestDatabase;
let current: TestDatabase;
let before: Snapshot;
let after: Snapshot;

beforeAll(async () => {
  const firstV2 = v2Migrations()[0];
  [v1, current] = await Promise.all([
    createTestDatabase(firstV2 ? { stopBefore: firstV2 } : {}),
    createTestDatabase()
  ]);
  [before, after] = await Promise.all([v1.asAdmin(snapshotV1), current.asAdmin(snapshotV1)]);
});

afterAll(async () => {
  await Promise.all([v1?.close(), current?.close()]);
});

describe("V1 baseline", () => {
  it("V1 ends with the processing-completion migration (V2 migrations sort after it)", () => {
    const files = listMigrationFiles();
    expect(files).toContain(V1_LAST_MIGRATION);
    expect(files.filter((file) => file <= V1_LAST_MIGRATION)).toHaveLength(9);
  });

  it("the snapshot covers every V1 table, policy and function", () => {
    expect(before.rls).toHaveLength(V1_TABLES.length);
    expect(before.policies.length).toBe(31);
    expect(Object.keys(before.functions)).toEqual(
      expect.arrayContaining(["private.is_organization_member", "private.has_organization_role", "private.can_view_profile"])
    );
  });
});

describe("V2 migrations keep V1 protections unchanged", () => {
  it("V1 policies are identical", () => {
    expect(after.policies).toEqual(before.policies);
  });

  it("RLS stays enabled on every V1 table", () => {
    expect(after.rls).toEqual(before.rls);
    // "<table> | relrowsecurity | relforcerowsecurity" (booleans render as t/f).
    for (const entry of after.rls) expect(entry, entry).toMatch(/^[a-z_]+ \| t \| /);
  });

  it("V1 functions are identical, unless explicitly listed as intentional changes", () => {
    for (const [name, definition] of Object.entries(before.functions)) {
      if (INTENTIONAL_V1_CHANGES.includes(name)) continue;
      expect(after.functions[name], name).toBe(definition);
    }
  });

  it("no V1 table or column grant was removed (V2 may only add)", () => {
    expect(before.tableGrants.filter((grant) => !after.tableGrants.includes(grant))).toEqual([]);
    expect(before.columnGrants.filter((grant) => !after.columnGrants.includes(grant))).toEqual([]);
  });

  it("no new table-wide grant on a V1 table (new access must be column-scoped and reviewed)", () => {
    expect(after.tableGrants.filter((grant) => !before.tableGrants.includes(grant))).toEqual([]);
  });
});

describe("invariants for every present and future table and function", () => {
  it("every table in an EmailBot schema has RLS enabled", async () => {
    const withoutRls = await current.asAdmin((tx) =>
      rows<{ t: string }>(
        tx,
        `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`,
        [OWN_SCHEMAS]
      )
    );
    expect(withoutRls).toEqual([]);
  });

  it("anon has no data privilege on any EmailBot table", async () => {
    const granted = await current.asAdmin((tx) =>
      rows<{ g: string }>(
        tx,
        `select n.nspname || '.' || c.relname || ' ' || p.privilege as g
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join unnest($2::text[]) as p(privilege)
         where n.nspname = any($1) and c.relkind in ('r', 'p', 'v')
           and has_table_privilege('anon', c.oid, p.privilege)
         order by 1`,
        [OWN_SCHEMAS, DATA_PRIVILEGES]
      )
    );
    expect(granted).toEqual([]);
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const unpinned = await current.asAdmin((tx) =>
      rows<{ f: string }>(
        tx,
        `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any($1) and p.prosecdef
           and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
         order by 1`,
        [OWN_SCHEMAS]
      )
    );
    expect(unpinned).toEqual([]);
  });

  it("no SECURITY DEFINER function is executable by anon or PUBLIC", async () => {
    const exposed = await current.asAdmin((tx) =>
      rows<{ f: string }>(
        tx,
        `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any($1) and p.prosecdef
           and (has_function_privilege('anon', p.oid, 'EXECUTE')
                or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
         order by 1`,
        [OWN_SCHEMAS]
      )
    );
    expect(exposed).toEqual([]);
  });

  it("authenticated can execute only the allow-listed SECURITY DEFINER functions", async () => {
    const callable = await current.asAdmin((tx) =>
      rows<{ f: string }>(
        tx,
        `select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any($1) and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
         order by 1`,
        [OWN_SCHEMAS]
      )
    );
    expect(callable.map((row) => row.f)).toEqual(AUTHENTICATED_DEFINER_ALLOWLIST);
  });
});
