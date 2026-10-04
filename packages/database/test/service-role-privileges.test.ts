import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, type DefaultPrivilegesProfile, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Migration 7 regression: service_role privileges must be explicit, minimal and
 * identical in every environment. EmailBot Production has different default
 * privileges than the local Supabase stack (service_role only gets Dxtm on new
 * tables), which left the backend without SELECT/INSERT/UPDATE before
 * migration 7.
 */

const MIGRATION_7 = "20261003130000";

const TABLES = [
  "audit_logs",
  "bot_customer_assignments",
  "bots",
  "categories",
  "customer_identifiers",
  "customers",
  "email_accounts",
  "email_attachments",
  "email_rules",
  "emails",
  "organization_members",
  "organization_settings",
  "organizations",
  "profiles"
] as const;

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"] as const;
type Privilege = (typeof PRIVILEGES)[number];

/** Exactly what apps/api (privileged.ts) and apps/worker (supabase-stores.ts) need. */
const SERVICE_ROLE_EXPECTED: Record<(typeof TABLES)[number], Privilege[]> = {
  audit_logs: ["INSERT"],
  // V2 phase 2: no worker access yet (customer resolution is phase 3).
  bot_customer_assignments: [],
  // V2 phase 1: column SELECT (id, organization_id, status) only, checked below.
  bots: [],
  categories: [],
  customer_identifiers: [],
  customers: [],
  email_accounts: ["SELECT", "INSERT", "UPDATE"],
  email_attachments: ["SELECT", "INSERT", "UPDATE"],
  email_rules: ["SELECT"],
  emails: ["SELECT", "INSERT"],
  organization_members: ["SELECT"],
  organization_settings: ["SELECT"],
  organizations: [],
  profiles: ["SELECT"]
};

/** Tables that existed before migration 7 (V2 tables are created later). */
const V2_TABLES: readonly string[] = ["bots", "customers", "customer_identifiers", "bot_customer_assignments"];
const V1_TABLES = TABLES.filter((table) => !V2_TABLES.includes(table));

async function privilegeMatrix(tx: Tx, role: string, tables: readonly string[] = TABLES): Promise<Record<string, Privilege[]>> {
  const matrix: Record<string, Privilege[]> = {};
  for (const table of tables) {
    matrix[table] = [];
    for (const privilege of PRIVILEGES) {
      const row = await one<{ granted: boolean }>(tx, "select has_table_privilege($1, $2, $3) as granted", [
        role,
        `public.${table}`,
        privilege
      ]);
      if (row.granted) matrix[table]?.push(privilege);
    }
  }
  return matrix;
}

async function publicTables(tx: Tx): Promise<string[]> {
  const result = await tx.query<{ relname: string }>(
    "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1"
  );
  return result.rows.map((row) => row.relname);
}

describe("migration 7 exists", () => {
  it("follows the six previous migrations", () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files[6]).toBe(`${MIGRATION_7}_service_role_minimal_grants.sql`);
  });
});

describe("BEFORE migration 7, with production default privileges", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ defaultPrivileges: "production", stopBefore: MIGRATION_7 });
  });
  afterAll(async () => t?.close());

  it("service_role lacks every privilege the backend needs", async () => {
    const matrix = await t.asAdmin((tx) => privilegeMatrix(tx, "service_role", V1_TABLES));
    for (const [table, required] of Object.entries(SERVICE_ROLE_EXPECTED)) {
      for (const privilege of required) {
        expect(matrix[table], `${table} ${privilege}`).not.toContain(privilege);
      }
    }
    // What production hands out instead (Dxtm), which the backend cannot use.
    expect(matrix.emails).toEqual(["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]);
  });

  it("the backend's first query fails with permission denied", async () => {
    await expect(t.asService((tx) => tx.query("select id from public.email_accounts limit 1"))).rejects.toThrow(
      /permission denied for table email_accounts/
    );
    await expect(
      t.asService((tx) => tx.query("insert into public.audit_logs (organization_id, actor_type, action) values (gen_random_uuid(), 'SYSTEM', 'PROCESS')"))
    ).rejects.toThrow(/permission denied for table audit_logs/);
  });
});

describe.each<DefaultPrivilegesProfile>(["production", "local"])("AFTER migration 7 (%s default privileges)", (profile) => {
  let t: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    t = await createTestDatabase({ defaultPrivileges: profile });
    f = await seedTwoTenants(t);
  });
  afterAll(async () => t?.close());

  it("covers every public table (a new table forces a privileges review)", async () => {
    expect(await t.asAdmin(publicTables)).toEqual([...TABLES]);
  });

  it("service_role has exactly the required privileges and nothing more", async () => {
    expect(await t.asAdmin((tx) => privilegeMatrix(tx, "service_role"))).toEqual(SERVICE_ROLE_EXPECTED);
  });

  it("service_role cannot execute EmailBot SECURITY DEFINER functions", async () => {
    const executable = await t.asAdmin((tx) =>
      count(
        tx,
        `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and p.prosecdef and has_function_privilege('service_role', p.oid, 'EXECUTE')`
      )
    );
    expect(executable).toBe(0);
  });

  it("every backend operation works with these grants", async () => {
    await t.asService(async (tx) => {
      // API privileged layer
      await tx.query("select id from public.profiles where email = 'owner@a.test'");
      await tx.query("select role from public.organization_members where organization_id = $1", [f.a.orgId]);
      const account = await one<{ id: string }>(
        tx,
        `insert into public.email_accounts (organization_id, provider, email_address, access_token_encrypted, refresh_token_encrypted)
         values ($1, 'MICROSOFT', 'new@a.test', 'v1.a', 'v1.r') returning id`,
        [f.a.orgId]
      );
      await tx.query("update public.email_accounts set access_token_encrypted = null, status = 'DISCONNECTED' where id = $1", [
        account.id
      ]);
      await tx.query(
        "insert into public.audit_logs (organization_id, actor_type, action, entity_type) values ($1, 'SYSTEM', 'PROCESS', 'email')",
        [f.a.orgId]
      );

      // Worker
      await tx.query("select refresh_token_encrypted, sync_cursor from public.email_accounts where id = $1", [f.a.accountId]);
      await tx.query("update public.email_accounts set sync_cursor = '42', last_synced_at = now() where id = $1", [f.a.accountId]);
      await tx.query("select id, conditions, actions from public.email_rules where organization_id = $1 and enabled", [f.a.orgId]);
      await tx.query("select auto_processing_enabled from public.organization_settings where organization_id = $1", [f.a.orgId]);
      await tx.query("select id from public.emails where email_account_id = $1 and provider_message_id = 'm-2'", [f.a.accountId]);
      const email = await one<{ id: string }>(
        tx,
        `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at)
         values ($1, $2, 'm-2', 's@example.com', now())
         on conflict (email_account_id, provider_message_id) do nothing returning id`,
        [f.a.orgId, f.a.accountId]
      );
      const attachment = await one<{ id: string }>(
        tx,
        "insert into public.email_attachments (organization_id, email_id, filename) values ($1, $2, 'f.pdf') returning id, provider_attachment_id",
        [f.a.orgId, email.id]
      );
      await tx.query(
        "update public.email_attachments set storage_bucket = 'email-attachments', storage_path = $1, storage_uploaded = true where id = $2",
        [`${f.a.orgId}/${email.id}/${attachment.id}/f.pdf`, attachment.id]
      );
    });
  });

  it.each([
    ["DELETE email_accounts", "delete from public.email_accounts"],
    ["UPDATE emails", "update public.emails set is_read = true"],
    ["DELETE emails", "delete from public.emails"],
    ["SELECT audit_logs", "select 1 from public.audit_logs"],
    ["INSERT categories", "insert into public.categories (organization_id, name, slug) values (gen_random_uuid(), 'x', 'x')"],
    ["SELECT organizations.name", "select name from public.organizations"],
    ["SELECT organizations.*", "select * from public.organizations"],
    ["SELECT bots.name", "select name from public.bots"],
    ["INSERT bots", "insert into public.bots (organization_id, name, slug) values (gen_random_uuid(), 'x', 'x')"],
    ["SELECT customers", "select 1 from public.customers"],
    ["SELECT customer_identifiers", "select 1 from public.customer_identifiers"],
    ["SELECT bot_customer_assignments", "select 1 from public.bot_customer_assignments"],
    ["UPDATE organization_members", "update public.organization_members set role = 'VIEWER'"],
    ["TRUNCATE emails", "truncate public.emails"]
  ])("service_role cannot %s", async (_label, sql) => {
    await expect(t.asService((tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
  });

  it("service_role reads only the columns the worker needs: organizations (id, status), bots (id, organization_id, status)", async () => {
    await t.asService(async (tx) => {
      const org = await one<{ status: string }>(tx, "select id, status from public.organizations where id = $1", [f.a.orgId]);
      expect(org.status).toBe("ACTIVE");
      await tx.query(
        `select a.id, o.status from public.email_accounts a join public.organizations o on o.id = a.organization_id where a.id = $1`,
        [f.a.accountId]
      );
      await tx.query("select id, organization_id, status from public.bots");
    });
  });

  it("anon has no privilege on any table and cannot execute SECURITY DEFINER functions", async () => {
    const matrix = await t.asAdmin((tx) => privilegeMatrix(tx, "anon"));
    expect(Object.values(matrix).flat()).toEqual([]);
    const executable = await t.asAdmin((tx) =>
      count(
        tx,
        `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')`
      )
    );
    expect(executable).toBe(0);
  });

  it("authenticated keeps its explicit grants, gets nothing administrative, and stays behind RLS", async () => {
    const matrix = await t.asAdmin((tx) => privilegeMatrix(tx, "authenticated"));
    for (const privileges of Object.values(matrix)) {
      expect(privileges).not.toContain("TRUNCATE");
      expect(privileges).not.toContain("REFERENCES");
      expect(privileges).not.toContain("TRIGGER");
      expect(privileges).not.toContain("MAINTAIN");
    }
    expect(matrix.emails).toEqual(["SELECT", "DELETE"]); // INSERT/UPDATE are column-level grants
    expect(matrix.audit_logs).toEqual(["SELECT"]);

    const withoutRls = await t.asAdmin((tx) =>
      count(
        tx,
        "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity"
      )
    );
    expect(withoutRls).toBe(0);
    expect(await t.asUser(f.a.ownerId, (tx) => count(tx, "select 1 from public.emails where organization_id = $1", [f.b.orgId]))).toBe(0);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select refresh_token_encrypted from public.email_accounts"))).rejects.toThrow(
      /permission denied/
    );
  });

  it("the table owner (postgres) keeps administrative privileges", async () => {
    const owners = await t.asAdmin(async (tx) => {
      const result = await tx.query<{ owner: string; current: string }>(
        `select pg_get_userbyid(c.relowner) as owner, current_user as current
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`
      );
      return result.rows;
    });
    expect(owners).toHaveLength(TABLES.length);
    expect(owners.every((row) => row.owner === row.current)).toBe(true);
    const matrix = await t.asAdmin(async (tx) => privilegeMatrix(tx, (await one<{ u: string }>(tx, "select current_user as u")).u));
    for (const privileges of Object.values(matrix)) expect(privileges).toEqual([...PRIVILEGES]);
  });
});
