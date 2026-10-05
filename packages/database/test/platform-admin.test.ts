import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 6: platform administrators.
 *
 * - public.platform_admins / public.platform_audit_logs: no Data API access
 *   for any role (RLS without policies, no grants).
 * - private.is_platform_admin: platform_admins is the only source of truth.
 * - admin.*: SECURITY DEFINER, EXECUTE for service_role only, every call
 *   re-checks the actor, metadata only (no e-mail content, credentials,
 *   identifiers, Access IDs or sessions), writes audited atomically.
 * - Existing organization RLS is untouched (v1-compatibility.test.ts) and
 *   gets no platform-admin exception: the admin user sees nothing through it.
 */

let t: TestDatabase;
let f: Fixtures;
let platformAdmin: string;
let botA: string;
let customerA: string;
let processedEmailA: string;
let sequence = 0;
const hex = (label: string) => createHash("sha256").update(`${label}-${++sequence}`).digest("hex");

const ADMIN_FUNCTIONS = [
  "admin.create_organization",
  "admin.get_organization",
  "admin.is_platform_admin",
  "admin.list_activity",
  "admin.list_audit",
  "admin.list_bots",
  "admin.list_customers",
  "admin.list_email_accounts",
  "admin.list_members",
  "admin.list_organizations",
  "admin.platform_stats",
  "admin.update_organization"
];

/** Every guarded admin.* call with harmless arguments for a given actor. */
const guardedCalls = (orgId: string): Array<[string, (actor: string) => [string, unknown[]]]> => [
  ["platform_stats", (actor) => ["select admin.platform_stats($1)", [actor]]],
  ["list_organizations", (actor) => ["select * from admin.list_organizations($1, null, null, null, null, 25, 0)", [actor]]],
  ["get_organization", (actor) => ["select * from admin.get_organization($1, $2)", [actor, orgId]]],
  ["create_organization", (actor) => ["select admin.create_organization($1, 'Nueva', 'nueva', 'FREE', $1, null)", [actor]]],
  ["update_organization", (actor) => ["select * from admin.update_organization($1, $2, null, 'SUSPENDED', null)", [actor, orgId]]],
  ["list_members", (actor) => ["select * from admin.list_members($1, $2)", [actor, orgId]]],
  ["list_bots", (actor) => ["select * from admin.list_bots($1, $2)", [actor, orgId]]],
  ["list_customers", (actor) => ["select * from admin.list_customers($1, $2, 25, 0)", [actor, orgId]]],
  ["list_email_accounts", (actor) => ["select * from admin.list_email_accounts($1, $2)", [actor, orgId]]],
  ["list_activity", (actor) => ["select * from admin.list_activity($1, null, 25, 0)", [actor]]],
  ["list_audit", (actor) => ["select * from admin.list_audit($1, null, 25, 0)", [actor]]]
];

const asService = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  t.asService(async (tx) => (await tx.query<T>(sql, params)).rows);

const listOrganizations = (options: { search?: string | null; status?: string | null; plan?: string | null; sort?: string | null; limit?: number; offset?: number } = {}) =>
  asService<Record<string, unknown>>("select * from admin.list_organizations($1, $2, $3, $4, $5, $6, $7)", [
    platformAdmin,
    options.search ?? null,
    options.status ?? null,
    options.plan ?? null,
    options.sort ?? null,
    options.limit ?? 25,
    options.offset ?? 0
  ]);

const platformAudit = (organizationId: string) =>
  t.asAdmin(async (tx) =>
    (
      await tx.query<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown>; request_id: string | null }>(
        "select action, actor_user_id, metadata, request_id from public.platform_audit_logs where organization_id = $1 order by created_at, id",
        [organizationId]
      )
    ).rows
  );

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  platformAdmin = await t.createUser("root@platform.test");
  await t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [platformAdmin]));

  await t.asAdmin(async (tx) => {
    botA = (await one<{ id: string }>(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix') returning id", [f.a.orgId])).id;
    customerA = (await one<{ id: string }>(tx, "insert into public.customers (organization_id, display_name, external_ref, notes) values ($1, 'Juan', 'EXT-1', 'nota privada') returning id", [f.a.orgId])).id;
    await tx.query("insert into public.customer_identifiers (organization_id, customer_id, type, value, normalized_value) values ($1, $2, 'EMAIL', 'juan@cliente.test', 'juan@cliente.test')", [f.a.orgId, customerA]);
    await tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [f.a.orgId, botA, customerA]);
    await tx.query("update public.email_rules set bot_id = $1 where id = $2", [botA, f.a.ruleId]);
    processedEmailA = (
      await one<{ id: string }>(
        tx,
        `insert into public.emails (organization_id, email_account_id, provider_message_id, bot_id, subject, sender_email, text_body, html_body, extracted_data, received_at, processing_status)
         values ($1, $2, 'admin-1', $3, 'Tu código secreto', 'info@netflix.example', 'CUERPO-PRIVADO 4821', '<p>CUERPO-PRIVADO</p>', '{"code":"4821"}', now(), 'PROCESSED') returning id`,
        [f.a.orgId, f.a.accountId, botA]
      )
    ).id;
    await tx.query("insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution) values ($1, $2, $3, $4, 'AUTOMATIC')", [
      f.a.orgId,
      processedEmailA,
      customerA,
      botA
    ]);
    await tx.query("insert into public.audit_logs (organization_id, actor_type, action, entity_type, description, metadata) values ($1, 'SYSTEM', 'PROCESS', 'email', 'Asunto privado', '{\"event\":\"email.processed\",\"subject\":\"privado\"}')", [f.a.orgId]);
  });
});

afterAll(async () => {
  await t?.close();
});

describe("platform_admins table", () => {
  it("one row per user (unique user_id)", async () => {
    await expect(t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [platformAdmin]))).rejects.toThrow(
      /platform_admins_user_unique/
    );
  });

  it("only existing users can be platform admins (foreign key to profiles)", async () => {
    await expect(
      t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ('99999999-9999-4999-8999-999999999999')"))
    ).rejects.toThrow(/foreign key/);
  });

  it("deleting the user removes the privilege (cascade)", async () => {
    const temporary = await t.createUser("temporary@platform.test");
    await t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [temporary]));
    const before = await asService<{ ok: boolean }>("select admin.is_platform_admin($1) as ok", [temporary]);
    expect(before[0]?.ok).toBe(true);
    await t.asAdmin((tx) => tx.query("delete from auth.users where id = $1", [temporary]));
    const after = await asService<{ ok: boolean }>("select admin.is_platform_admin($1) as ok", [temporary]);
    expect(after[0]?.ok).toBe(false);
  });

  it.each([
    ["authenticated (the platform admin itself)", () => t.asUser(platformAdmin, (tx) => tx.query("select user_id from public.platform_admins"))],
    ["authenticated INSERT (self-promotion)", () => t.asUser(f.a.ownerId, (tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [f.a.ownerId]))],
    ["anon", () => t.asAnon((tx) => tx.query("select user_id from public.platform_admins"))],
    ["service_role", () => t.asService((tx) => tx.query("select user_id from public.platform_admins"))],
    ["authenticated on platform_audit_logs", () => t.asUser(platformAdmin, (tx) => tx.query("select action from public.platform_audit_logs"))],
    ["service_role INSERT on platform_audit_logs", () =>
      t.asService((tx) => tx.query("insert into public.platform_audit_logs (action, target_type) values ('organization.created', 'organization')"))]
  ])("no Data API access: %s", async (_label, run) => {
    await expect(run()).rejects.toThrow(/permission denied/);
  });

  it("RLS is enabled on both tables", async () => {
    const rows = await t.asAdmin((tx) =>
      tx.query<{ relname: string; relrowsecurity: boolean }>(
        "select relname, relrowsecurity from pg_class where relname in ('platform_admins', 'platform_audit_logs') and relnamespace = 'public'::regnamespace order by 1"
      )
    );
    expect(rows.rows).toEqual([
      { relname: "platform_admins", relrowsecurity: true },
      { relname: "platform_audit_logs", relrowsecurity: true }
    ]);
  });
});

describe("is_platform_admin", () => {
  it("is true only for users in platform_admins (auth.uid() by default)", async () => {
    const check = (userId: string | null) =>
      t.asAdmin(async (tx) => {
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
        return (await one<{ ok: boolean }>(tx, "select private.is_platform_admin() as ok")).ok;
      });
    expect(await check(platformAdmin)).toBe(true);
    for (const user of [f.a.ownerId, f.a.adminId, f.a.operatorId, f.a.viewerId, f.b.ownerId, f.outsiderId]) {
      expect(await check(user)).toBe(false);
    }
    expect(await check(null)).toBe(false);
  });

  it("is not executable by any API role (only inside admin.* functions)", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const fn of ["private.is_platform_admin(uuid)", "private.assert_platform_admin(uuid)"]) {
        const row = await t.asAdmin((tx) => one<{ ok: boolean }>(tx, "select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn]));
        expect(row.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("organization roles do not grant platform access", async () => {
    const result = await asService<{ ok: boolean }>("select admin.is_platform_admin($1) as ok", [f.a.ownerId]);
    expect(result[0]?.ok).toBe(false);
  });
});

describe("admin.* privileges", () => {
  it("every function is SECURITY DEFINER, pins search_path and is executable by service_role only", async () => {
    const rows = await t.asAdmin((tx) =>
      tx.query<{ f: string; definer: boolean; pinned: boolean; anon: boolean; authenticated: boolean; service: boolean; public_exec: boolean }>(
        `select n.nspname || '.' || p.proname as f, p.prosecdef as definer,
                exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""') as pinned,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'admin' order by 1`
      )
    );
    expect(rows.rows.map((row) => row.f)).toEqual(ADMIN_FUNCTIONS);
    for (const row of rows.rows) {
      expect(row, row.f).toMatchObject({ definer: true, pinned: true, anon: false, authenticated: false, service: true, public_exec: false });
    }
  });

  it("the browser roles cannot reach the admin schema", async () => {
    await expect(t.asUser(platformAdmin, (tx) => tx.query("select admin.platform_stats($1)", [platformAdmin]))).rejects.toThrow(
      /permission denied for schema admin/
    );
    await expect(t.asAnon((tx) => tx.query("select admin.is_platform_admin($1)", [platformAdmin]))).rejects.toThrow(
      /permission denied for schema admin/
    );
  });

  it.each(["owner of org A", "VIEWER of org A", "outsider", "unknown user", "no actor"])(
    "every guarded function rejects a non-admin actor (%s) with 42501",
    async (label) => {
      const actor = {
        "owner of org A": f.a.ownerId,
        "VIEWER of org A": f.a.viewerId,
        outsider: f.outsiderId,
        "unknown user": "99999999-9999-4999-8999-999999999999",
        "no actor": null
      }[label];
      for (const [name, call] of guardedCalls(f.a.orgId)) {
        const [sql, params] = call(actor as string);
        await expect(t.asService((tx) => tx.query(sql, params)), name).rejects.toMatchObject({ code: "42501" });
      }
      const org = await t.asAdmin((tx) => one<{ status: string }>(tx, "select status from public.organizations where id = $1", [f.a.orgId]));
      expect(org.status).toBe("ACTIVE");
      expect(await t.asAdmin((tx) => count(tx, "select 1 from public.organizations where slug = 'nueva'"))).toBe(0);
    }
  );
});

describe("stats", () => {
  it("matches the real counts and returns numbers only", async () => {
    const [row] = await asService<{ stats: Record<string, number> }>("select admin.platform_stats($1) as stats", [platformAdmin]);
    const expected = await t.asAdmin(async (tx) => ({
      totalOrganizations: await count(tx, "select 1 from public.organizations"),
      activeOrganizations: await count(tx, "select 1 from public.organizations where status = 'ACTIVE'"),
      totalMembers: await count(tx, "select 1 from public.organization_members"),
      totalBots: await count(tx, "select 1 from public.bots"),
      totalCustomers: await count(tx, "select 1 from public.customers"),
      totalEmailAccounts: await count(tx, "select 1 from public.email_accounts"),
      totalEmails: await count(tx, "select 1 from public.emails"),
      totalProcessedEmails: await count(tx, "select 1 from public.emails where processing_status = 'PROCESSED'"),
      totalDeliveries: await count(tx, "select 1 from public.email_deliveries where removed_at is null")
    }));
    expect(row?.stats).toMatchObject(expected);
    expect(Object.keys(row?.stats ?? {}).sort()).toEqual(
      [
        "activeEmailAccounts",
        "activeOrganizations",
        "cancelledOrganizations",
        "suspendedOrganizations",
        "totalBots",
        "totalCustomers",
        "totalDeliveries",
        "totalEmailAccounts",
        "totalEmails",
        "totalMembers",
        "totalOrganizations",
        "totalProcessedEmails"
      ].sort()
    );
    for (const value of Object.values(row?.stats ?? {})) expect(typeof value).toBe("number");
  });
});

describe("organizations list", () => {
  it("returns metadata with owner and counts, and nothing else", async () => {
    const rows = await listOrganizations();
    const a = rows.find((row) => row.id === f.a.orgId);
    expect(Object.keys(a ?? {}).sort()).toEqual(
      [
        "bots_count",
        "created_at",
        "customers_count",
        "email_accounts_count",
        "id",
        "members_count",
        "name",
        "owner_email",
        "owner_name",
        "owner_user_id",
        "plan",
        "processed_emails_count",
        "slug",
        "status",
        "total_count",
        "updated_at"
      ].sort()
    );
    expect(a).toMatchObject({
      name: "Org A",
      slug: "org-a",
      plan: "FREE",
      status: "ACTIVE",
      owner_user_id: f.a.ownerId,
      owner_email: "owner@a.test"
    });
    expect(Number(a?.members_count)).toBe(4);
    expect(Number(a?.bots_count)).toBe(1);
    expect(Number(a?.customers_count)).toBe(1);
    expect(Number(a?.email_accounts_count)).toBe(1);
    expect(Number(a?.processed_emails_count)).toBe(1);
    const b = rows.find((row) => row.id === f.b.orgId);
    expect(Number(b?.bots_count)).toBe(0);
    expect(JSON.stringify(rows)).not.toMatch(/CUERPO-PRIVADO|4821|v1\.iv\.tag|EXT-1|nota privada/);
  });

  it("searches name, slug and owner e-mail; LIKE wildcards are literal", async () => {
    expect((await listOrganizations({ search: "org a" })).map((row) => row.id)).toEqual([f.a.orgId]);
    expect((await listOrganizations({ search: "ORG-B" })).map((row) => row.id)).toEqual([f.b.orgId]);
    expect((await listOrganizations({ search: "owner@b" })).map((row) => row.id)).toEqual([f.b.orgId]);
    expect(await listOrganizations({ search: "%" })).toEqual([]);
    expect(await listOrganizations({ search: "org_a" })).toEqual([]);
    expect(await listOrganizations({ search: "no-match" })).toEqual([]);
  });

  it("filters by status and plan", async () => {
    await t.asAdmin((tx) => tx.query("update public.organizations set plan = 'PRO' where id = $1", [f.b.orgId]));
    try {
      expect((await listOrganizations({ plan: "PRO" })).map((row) => row.id)).toEqual([f.b.orgId]);
      expect((await listOrganizations({ status: "SUSPENDED" })).map((row) => row.id)).toEqual([]);
      expect((await listOrganizations({ status: "ACTIVE", plan: "FREE" })).map((row) => row.id)).toContain(f.a.orgId);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.organizations set plan = 'FREE' where id = $1", [f.b.orgId]));
    }
  });

  it("sorts only by the whitelist and paginates with a total", async () => {
    expect((await listOrganizations({ sort: "name_asc" })).map((row) => row.name)).toEqual(["Org A", "Org B"]);
    expect((await listOrganizations({ sort: "name_desc" })).map((row) => row.name)).toEqual(["Org B", "Org A"]);
    const first = await listOrganizations({ sort: "name_asc", limit: 1, offset: 0 });
    const second = await listOrganizations({ sort: "name_asc", limit: 1, offset: 1 });
    expect(first.map((row) => row.name)).toEqual(["Org A"]);
    expect(second.map((row) => row.name)).toEqual(["Org B"]);
    expect(Number(first[0]?.total_count)).toBe(2);
    expect(await listOrganizations({ sort: "name_asc", limit: 1, offset: 5 })).toEqual([]);
    await expect(listOrganizations({ sort: "name; drop table public.organizations" })).rejects.toMatchObject({ code: "22023" });
    await expect(listOrganizations({ sort: "slug" })).rejects.toMatchObject({ code: "22023" });
  });

  it("clamps the page size to 100", async () => {
    const rows = await listOrganizations({ limit: 100_000 });
    expect(rows.length).toBeLessThanOrEqual(100);
  });
});

describe("organization detail and metadata", () => {
  it("detail has summary counts; unknown ids return nothing", async () => {
    const [detail] = await asService<Record<string, unknown>>("select * from admin.get_organization($1, $2)", [platformAdmin, f.a.orgId]);
    expect(detail).toMatchObject({ id: f.a.orgId, owner_email: "owner@a.test" });
    expect(Number(detail?.rules_count)).toBe(1);
    expect(Number(detail?.emails_count)).toBe(2);
    expect(Number(detail?.processed_emails_count)).toBe(1);
    expect(Number(detail?.deliveries_count)).toBe(1);
    expect(await asService("select * from admin.get_organization($1, $2)", [platformAdmin, "99999999-9999-4999-8999-999999999999"])).toEqual([]);
  });

  it("members: name, e-mail, role, joined date; only the requested organization", async () => {
    const rows = await asService<Record<string, unknown>>("select * from admin.list_members($1, $2)", [platformAdmin, f.a.orgId]);
    expect(rows.map((row) => row.role)).toEqual(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["email", "full_name", "joined_at", "role", "user_id"]);
    expect(rows.map((row) => row.email)).not.toContain("owner@b.test");
  });

  it("bots: status and counts", async () => {
    const rows = await asService<Record<string, unknown>>("select * from admin.list_bots($1, $2)", [platformAdmin, f.a.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: botA, name: "Netflix", status: "ACTIVE" });
    expect(Number(rows[0]?.rules_count)).toBe(1);
    expect(Number(rows[0]?.active_customers_count)).toBe(1);
    expect(Number(rows[0]?.deliveries_count)).toBe(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain("portal_settings");
    expect(Object.keys(rows[0] ?? {})).not.toContain("customer_resolution");
    expect(await asService("select * from admin.list_bots($1, $2)", [platformAdmin, f.b.orgId])).toEqual([]);
  });

  it("customers: name, status, bots and deliveries; never identifiers, references, notes, Access IDs or sessions", async () => {
    const rows = await asService<Record<string, unknown>>("select * from admin.list_customers($1, $2, 25, 0)", [platformAdmin, f.a.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: customerA, display_name: "Juan", status: "ACTIVE", bot_names: ["Netflix"] });
    expect(Number(rows[0]?.deliveries_count)).toBe(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["bot_names", "created_at", "deliveries_count", "display_name", "id", "status", "total_count"]);
    expect(JSON.stringify(rows)).not.toMatch(/juan@cliente|EXT-1|nota privada/);
    expect(await asService("select * from admin.list_customers($1, $2, 25, 0)", [platformAdmin, f.b.orgId])).toEqual([]);
  });

  it("email accounts: connection state, never credentials", async () => {
    const rows = await asService<Record<string, unknown>>("select * from admin.list_email_accounts($1, $2)", [platformAdmin, f.a.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: f.a.accountId, provider: "GMAIL", email_address: "inbox@a.test", status: "ACTIVE" });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ["created_at", "email_address", "id", "last_error_code", "last_synced_at", "provider", "status", "watch_error_code", "watch_expires_at"].sort()
    );
    expect(JSON.stringify(rows)).not.toMatch(/v1\.iv\.tag/);
  });

  it("activity: event names across organizations, never descriptions or metadata values", async () => {
    const rows = await asService<Record<string, unknown>>("select * from admin.list_activity($1, null, 50, 0)", [platformAdmin]);
    const processed = rows.find((row) => row.event === "email.processed");
    expect(processed).toMatchObject({ organization_id: f.a.orgId, organization_name: "Org A", action: "PROCESS", entity_type: "email" });
    expect(Object.keys(processed ?? {}).sort()).toEqual(
      ["action", "actor_type", "created_at", "entity_type", "event", "id", "organization_id", "organization_name"].sort()
    );
    expect(JSON.stringify(rows)).not.toMatch(/Asunto privado|privado/);
    const onlyB = await asService<Record<string, unknown>>("select * from admin.list_activity($1, $2, 50, 0)", [platformAdmin, f.b.orgId]);
    expect(onlyB.every((row) => row.organization_id === f.b.orgId)).toBe(true);
    const page = await asService("select * from admin.list_activity($1, null, 1, 0)", [platformAdmin]);
    expect(page).toHaveLength(1);
  });
});

describe("create organization", () => {
  it("creates the organization, its OWNER and its settings atomically, and audits it", async () => {
    const owner = await t.createUser("new-owner@c.test");
    const [created] = await asService<{ id: string }>("select admin.create_organization($1, '  Cliente Nuevo  ', 'cliente-nuevo', 'PRO', $2, 'req-1') as id", [
      platformAdmin,
      owner
    ]);
    const id = created?.id as string;
    const state = await t.asAdmin(async (tx) => ({
      org: await one<{ name: string; plan: string; status: string }>(tx, "select name, plan, status from public.organizations where id = $1", [id]),
      owners: await count(tx, "select 1 from public.organization_members where organization_id = $1 and role = 'OWNER' and user_id = $2", [id, owner]),
      settings: await count(tx, "select 1 from public.organization_settings where organization_id = $1", [id])
    }));
    expect(state).toEqual({ org: { name: "Cliente Nuevo", plan: "PRO", status: "ACTIVE" }, owners: 1, settings: 1 });
    expect(await platformAudit(id)).toEqual([
      { action: "organization.created", actor_user_id: platformAdmin, metadata: { plan: "PRO", ownerUserId: owner }, request_id: "req-1" }
    ]);
    // The new OWNER sees the organization through the normal RLS; the platform admin does not.
    expect(await t.asUser(owner, (tx) => count(tx, "select 1 from public.organizations where id = $1", [id]))).toBe(1);
    expect(await t.asUser(platformAdmin, (tx) => count(tx, "select 1 from public.organizations where id = $1", [id]))).toBe(0);
  });

  it.each([
    ["unknown owner", "select admin.create_organization($1, 'Fallida', 'fallida', 'FREE', '99999999-9999-4999-8999-999999999999', null)", /Owner user does not exist/],
    ["duplicated slug", "select admin.create_organization($1, 'Fallida', 'org-a', 'FREE', $1, null)", /duplicate key|organizations_slug_key/],
    ["invalid slug", "select admin.create_organization($1, 'Fallida', 'No Valido', 'FREE', $1, null)", /Invalid organization slug/],
    ["name too short", "select admin.create_organization($1, 'x', 'fallida', 'FREE', $1, null)", /between 2 and 120/]
  ])("leaves nothing behind on failure: %s", async (_label, sql, error) => {
    const before = await t.asAdmin((tx) => count(tx, "select 1 from public.organizations"));
    const auditBefore = await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs"));
    await expect(t.asService((tx) => tx.query(sql, [platformAdmin]))).rejects.toThrow(error);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.organizations"))).toBe(before);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs"))).toBe(auditBefore);
  });
});

describe("update organization (plan, status) and suspension", () => {
  const update = (orgId: string, plan: string | null, status: string | null, requestId: string | null = null) =>
    asService<Record<string, unknown>>("select * from admin.update_organization($1, $2, $3, $4, $5)", [platformAdmin, orgId, plan, status, requestId]);

  async function snapshot(orgId: string) {
    return t.asAdmin(async (tx) => ({
      emails: await count(tx, "select 1 from public.emails where organization_id = $1", [orgId]),
      deliveries: await count(tx, "select 1 from public.email_deliveries where organization_id = $1", [orgId]),
      customers: await count(tx, "select 1 from public.customers where organization_id = $1", [orgId]),
      bots: await count(tx, "select 1 from public.bots where organization_id = $1", [orgId]),
      rules: await count(tx, "select 1 from public.email_rules where organization_id = $1", [orgId]),
      accounts: await count(tx, "select 1 from public.email_accounts where organization_id = $1 and status = 'ACTIVE'", [orgId]),
      members: await count(tx, "select 1 from public.organization_members where organization_id = $1", [orgId])
    }));
  }

  it("changes the plan with one audit record", async () => {
    const [row] = await update(f.b.orgId, "BUSINESS", null, "req-plan");
    expect(row).toMatchObject({ id: f.b.orgId, plan: "BUSINESS", status: "ACTIVE" });
    const audit = await platformAudit(f.b.orgId);
    expect(audit.at(-1)).toEqual({
      action: "organization.plan_changed",
      actor_user_id: platformAdmin,
      metadata: { from: "FREE", to: "BUSINESS" },
      request_id: "req-plan"
    });
  });

  it("an unchanged value writes no audit record and does not touch the row", async () => {
    const before = await platformAudit(f.b.orgId);
    const { updated_at: updatedBefore } = await t.asAdmin((tx) =>
      one<{ updated_at: string }>(tx, "select updated_at from public.organizations where id = $1", [f.b.orgId])
    );
    const [row] = await update(f.b.orgId, "BUSINESS", "ACTIVE");
    expect(row).toMatchObject({ plan: "BUSINESS", status: "ACTIVE" });
    expect(String(row?.updated_at)).toBe(String(updatedBefore));
    expect(await platformAudit(f.b.orgId)).toEqual(before);
  });

  it("unknown organization: no rows, nothing audited", async () => {
    expect(await update("99999999-9999-4999-8999-999999999999", null, "SUSPENDED")).toEqual([]);
  });

  it("SUSPENDED keeps every record, blocks the portal session scope; ACTIVE restores it", async () => {
    const secret = hex("secret");
    const token = hex("token");
    await t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customerA, secret]));
    const login = await t.asService((tx) => one<{ outcome: string }>(tx, "select outcome from portal.create_session($1, $2, null, null)", [secret, token]));
    expect(login.outcome).toBe("OK");
    const sessionRows = () => asService("select * from portal.validate_session($1)", [token]);
    const syncScope = () => asService("select * from portal.sync_scope($1)", [token]);
    expect(await sessionRows()).toHaveLength(1);
    expect(await syncScope()).toHaveLength(1);
    const before = await snapshot(f.a.orgId);

    const [suspended] = await update(f.a.orgId, null, "SUSPENDED", "req-suspend");
    expect(suspended).toMatchObject({ status: "SUSPENDED" });
    expect(await snapshot(f.a.orgId)).toEqual(before);
    expect(await sessionRows()).toEqual([]);
    expect(await syncScope()).toEqual([]);
    // The worker reads organizations.status (and skips inactive organizations).
    const worker = await t.asService((tx) => one<{ status: string }>(tx, "select status from public.organizations where id = $1", [f.a.orgId]));
    expect(worker.status).toBe("SUSPENDED");
    // Members keep reading their data through RLS (the API answers ORGANIZATION_INACTIVE).
    expect(await t.asUser(f.a.ownerId, (tx) => count(tx, "select 1 from public.emails where organization_id = $1", [f.a.orgId]))).toBe(before.emails);

    const [reactivated] = await update(f.a.orgId, null, "ACTIVE", "req-reactivate");
    expect(reactivated).toMatchObject({ status: "ACTIVE" });
    expect(await snapshot(f.a.orgId)).toEqual(before);
    expect(await sessionRows()).toHaveLength(1);
    expect(await syncScope()).toHaveLength(1);

    const audit = (await platformAudit(f.a.orgId)).slice(-2);
    expect(audit).toEqual([
      { action: "organization.suspended", actor_user_id: platformAdmin, metadata: { from: "ACTIVE", to: "SUSPENDED" }, request_id: "req-suspend" },
      { action: "organization.reactivated", actor_user_id: platformAdmin, metadata: { from: "SUSPENDED", to: "ACTIVE" }, request_id: "req-reactivate" }
    ]);
  });

  it("CANCELLED is recorded, deletes nothing and is reversible", async () => {
    const before = await snapshot(f.b.orgId);
    await update(f.b.orgId, null, "CANCELLED");
    expect(await snapshot(f.b.orgId)).toEqual(before);
    expect((await platformAudit(f.b.orgId)).at(-1)?.action).toBe("organization.cancelled");
    await update(f.b.orgId, null, "ACTIVE");
    expect((await platformAudit(f.b.orgId)).at(-1)?.action).toBe("organization.reactivated");
  });
});

describe("platform audit", () => {
  it("list_audit returns the actor e-mail and organization name, filterable by organization", async () => {
    const all = await asService<Record<string, unknown>>("select * from admin.list_audit($1, null, 100, 0)", [platformAdmin]);
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toMatchObject({ actor_email: "root@platform.test" });
    const onlyA = await asService<Record<string, unknown>>("select * from admin.list_audit($1, $2, 100, 0)", [platformAdmin, f.a.orgId]);
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((row) => row.organization_id === f.a.orgId && row.organization_name === "Org A")).toBe(true);
  });

  it("records are immutable, even for the table owner", async () => {
    await expect(t.asAdmin((tx) => tx.query("update public.platform_audit_logs set action = 'organization.updated'"))).rejects.toThrow(/immutable/);
    await expect(t.asAdmin((tx) => tx.query("update public.platform_audit_logs set organization_id = null"))).rejects.toThrow(/immutable/);
    await expect(t.asAdmin((tx) => tx.query("delete from public.platform_audit_logs"))).rejects.toThrow(/immutable/);
  });

  it("survives the deletion of the acting admin (actor anonymized, record kept)", async () => {
    const temporary = await t.createUser("temporary-admin@platform.test");
    await t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [temporary]));
    await t.asService((tx) => tx.query("select * from admin.update_organization($1, $2, 'PRO', null, null)", [temporary, f.b.orgId]));
    await t.asAdmin((tx) => tx.query("delete from auth.users where id = $1", [temporary]));
    const last = (await platformAudit(f.b.orgId)).at(-1);
    expect(last).toMatchObject({ action: "organization.plan_changed", actor_user_id: null, metadata: { from: "BUSINESS", to: "PRO" } });
  });
});
