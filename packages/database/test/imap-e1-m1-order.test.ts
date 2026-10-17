import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, MIGRATIONS_DIR, type DefaultPrivilegesProfile, type TestDatabase } from "../src/harness.js";
import { activateSubscription, one } from "./fixtures.js";

/*
 * IMAP E1 (20261014120000_imap_e1_security.sql) -> M1 (20261015120000_imap_m1_lifecycle.sql).
 *
 * M1 replaces E1's connect_imap_email_account and relies on E1's member
 * protections, so its first statement refuses to run without them: the
 * function M1 replaces, the ENABLED trigger email_accounts_guard_member_update
 * and the least privilege of `authenticated` on public.email_accounts (no
 * INSERT, no UPDATE of provider_metadata, at table or column level). The
 * check looks at those objects, never at the migration history or SQL text.
 *
 * Each case applies the migration files with the harness, one exec per file,
 * as createTestDatabase does. Assertions read the catalog (functions and their
 * ACLs, triggers, table and column privileges, IMAP plan rows) and the
 * behaviour of connect_imap_email_account (E1: IMAP_SYNC_NOT_IMPLEMENTED,
 * M1: IMAP_ACTIVATION_PENDING), not only the absence of errors.
 */

const E1 = "20261014120000";
const M1 = "20261015120000";

function migration(prefix: string): string {
  const name = listMigrationFiles().find((file) => file.startsWith(prefix));
  if (!name) throw new Error(`migration ${prefix} not found`);
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

const E1_SQL = migration(E1);
const M1_SQL = migration(M1);

const CONNECT = "public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)";
const ACTIVATE = "public.activate_imap_email_account(uuid, uuid)";
const GUARD_TRIGGER = "email_accounts_guard_member_update";

/** SecretBox v2 shape (iv 12 bytes, tag 16 bytes, base64url). The database never sees a real password. */
const V2 = "v2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Q0lQSEVSVEVYVA";

const REFUSED = /IMAP M1 requires IMAP E1 \(20261014120000_imap_e1_security\) to be applied first; missing: /;
const MISSING_FUNCTION = "function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)";
const MISSING_TRIGGER = "enabled trigger email_accounts_guard_member_update (private.guard_email_account_member_update)";
const MISSING_PRIVILEGE = "least privilege of authenticated on public.email_accounts (no INSERT, no UPDATE of provider_metadata)";

async function rows<T>(t: TestDatabase, sql: string): Promise<T[]> {
  return (await t.db.query<T>(sql)).rows;
}

async function single<T>(t: TestDatabase, sql: string): Promise<T> {
  const [row] = await rows<T>(t, sql);
  if (row === undefined) throw new Error(`Query returned no rows: ${sql}`);
  return row;
}

/** Everything E1 / M1 can touch, compared before and after a refused migration. */
async function catalog(t: TestDatabase) {
  return {
    functions: await rows(
      t,
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
              md5(p.prosrc) as src, coalesce(p.proacl::text, '') as acl, p.prosecdef as secdef,
              coalesce(array_to_string(p.proconfig, ','), '') as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
        order by 1`
    ),
    triggers: await rows(
      t,
      `select tgname as name, tgfoid::regprocedure::text as fn, tgenabled::text as enabled
         from pg_trigger where tgrelid = 'public.email_accounts'::regclass and not tgisinternal order by 1`
    ),
    tableAcl: await rows(t, `select coalesce(relacl::text, '') as acl from pg_class where oid = 'public.email_accounts'::regclass`),
    columnAcl: await rows(
      t,
      `select attname as column, attacl::text as acl from pg_attribute
        where attrelid = 'public.email_accounts'::regclass and attnum > 0 and not attisdropped and attacl is not null order by 1`
    ),
    imap: await rows(
      t,
      `select c.code, e.kind::text as kind, e.enabled from public.plan_entitlements e
         join public.plan_catalog c on c.id = e.plan_id where e.key = 'IMAP' order by c.code`
    ),
    entitlements: await rows(t, "select count(*)::int as n from public.plan_entitlements")
  };
}

/** What a member (authenticated, Data API) may write on public.email_accounts. */
async function memberPrivileges(t: TestDatabase) {
  return single<{ insert: boolean; update_provider_metadata: boolean; update_status: boolean; update_display_name: boolean; delete: boolean }>(
      t,
      `select has_any_column_privilege('authenticated', 'public.email_accounts', 'INSERT') as insert,
              has_column_privilege('authenticated', 'public.email_accounts', 'provider_metadata', 'UPDATE') as update_provider_metadata,
              has_column_privilege('authenticated', 'public.email_accounts', 'status', 'UPDATE') as update_status,
              has_column_privilege('authenticated', 'public.email_accounts', 'display_name', 'UPDATE') as update_display_name,
              has_table_privilege('authenticated', 'public.email_accounts', 'DELETE') as delete`
  );
}

/** E1's member protections, as E1 leaves them. */
const E1_PRIVILEGES = { insert: false, update_provider_metadata: false, update_status: true, update_display_name: true, delete: true };

async function guardTriggers(t: TestDatabase) {
  return rows<{ fn: string; enabled: string }>(
    t,
    `select tgfoid::regprocedure::text as fn, tgenabled::text as enabled
       from pg_trigger where tgrelid = 'public.email_accounts'::regclass and tgname = '${GUARD_TRIGGER}' and not tgisinternal`
  );
}

/** Existence and EXECUTE grants of the IMAP RPCs (service_role only). */
async function rpcs(t: TestDatabase) {
  return single<{ connect: boolean; activate: boolean; connect_execute: string; activate_execute: string }>(
      t,
      `select to_regprocedure('${CONNECT}') is not null as connect,
              to_regprocedure('${ACTIVATE}') is not null as activate,
              case when to_regprocedure('${CONNECT}') is null then '' else
                concat_ws(',', case when has_function_privilege('anon', to_regprocedure('${CONNECT}'), 'EXECUTE') then 'anon' end,
                               case when has_function_privilege('authenticated', to_regprocedure('${CONNECT}'), 'EXECUTE') then 'authenticated' end,
                               case when has_function_privilege('service_role', to_regprocedure('${CONNECT}'), 'EXECUTE') then 'service_role' end) end as connect_execute,
              case when to_regprocedure('${ACTIVATE}') is null then '' else
                concat_ws(',', case when has_function_privilege('anon', to_regprocedure('${ACTIVATE}'), 'EXECUTE') then 'anon' end,
                               case when has_function_privilege('authenticated', to_regprocedure('${ACTIVATE}'), 'EXECUTE') then 'authenticated' end,
                               case when has_function_privilege('service_role', to_regprocedure('${ACTIVATE}'), 'EXECUTE') then 'service_role' end) end as activate_execute`
  );
}

let sequence = 0;

/** Behaviour of connect_imap_email_account: a PRO organization connects one mailbox (service_role). */
async function connectMailbox(t: TestDatabase): Promise<{ outcome: string; status: string; code: string | null }> {
  sequence += 1;
  const ownerId = await t.createUser(`imap-order-${sequence}@example.test`);
  const org = await t.asUser(ownerId, (tx) =>
    one<{ id: string }>(tx, "select public.create_organization($1, $2) as id", [`ImapOrder ${sequence}`, `imap-order-${sequence}`])
  );
  await activateSubscription(t, org.id, "PRO");
  const email = `order-${sequence}@example-mail.com`;
  const result = await t.asService((tx) =>
    one<{ outcome: string; email_account_id: string }>(tx, "select * from public.connect_imap_email_account($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
      org.id,
      email,
      null,
      email,
      "imap.example-mail.com",
      993,
      "TLS",
      V2,
      "imap:v1:7:120"
    ])
  );
  const row = await t.asAdmin((tx) =>
    one<{ status: string; last_error_code: string | null }>(tx, "select status, last_error_code from public.email_accounts where id = $1", [
      result.email_account_id
    ])
  );
  return { outcome: result.outcome, status: row.status, code: row.last_error_code };
}

const E1_BEHAVIOUR = { outcome: "CREATED", status: "PAUSED", code: "IMAP_SYNC_NOT_IMPLEMENTED" };
const M1_BEHAVIOUR = { outcome: "CREATED", status: "PAUSED", code: "IMAP_ACTIVATION_PENDING" };

/** Runs a migration file the way the harness does (one exec per file); returns the error, if any. */
async function apply(t: TestDatabase, sql: string): Promise<Error | null> {
  return t.db.exec(sql).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );
}

describe("1. E1 then M1 (repository order): both apply, E1's protections stay, M1's function is final", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ defaultPrivileges: "production", stopBefore: M1 });
  });
  afterAll(async () => t?.close());

  it("after E1 alone: E1's function, enabled trigger and least privilege; no activation RPC yet", async () => {
    expect(await memberPrivileges(t)).toEqual(E1_PRIVILEGES);
    expect(await guardTriggers(t)).toEqual([{ fn: "private.guard_email_account_member_update()", enabled: "O" }]);
    expect(await rpcs(t)).toEqual({ connect: true, activate: false, connect_execute: "service_role", activate_execute: "" });
    expect(await connectMailbox(t)).toEqual(E1_BEHAVIOUR);
  });

  it("M1 applies (the precondition passes) and leaves E1's protections exactly as they were", async () => {
    const before = await catalog(t);
    expect(await apply(t, M1_SQL)).toBeNull();
    const after = await catalog(t);

    expect(await memberPrivileges(t)).toEqual(E1_PRIVILEGES);
    expect(await guardTriggers(t)).toEqual([{ fn: "private.guard_email_account_member_update()", enabled: "O" }]);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.tableAcl).toEqual(before.tableAcl);
    expect(after.columnAcl).toEqual(before.columnAcl);
    expect(after.imap).toEqual(before.imap);
    expect(await rpcs(t)).toEqual({ connect: true, activate: true, connect_execute: "service_role", activate_execute: "service_role" });
  });

  it("connect_imap_email_account is M1's version: PAUSED + IMAP_ACTIVATION_PENDING", async () => {
    expect(await connectMailbox(t)).toEqual(M1_BEHAVIOUR);
  });
});

describe("2. M1 without E1: refused by its first statement, catalog unchanged", () => {
  it.each<DefaultPrivilegesProfile>(["local", "production"])("default privileges %s: every missing E1 protection is named; nothing changes", async (profile) => {
    const t = await createTestDatabase({ defaultPrivileges: profile, stopBefore: E1 });
    try {
      // Without E1 the member could still insert and update provider_metadata (the state the precondition detects).
      expect(await memberPrivileges(t)).toMatchObject({ insert: true, update_provider_metadata: true });
      const before = await catalog(t);

      const error = await apply(t, M1_SQL);
      expect(error?.message).toMatch(REFUSED);
      expect(error?.message).toContain(MISSING_FUNCTION);
      expect(error?.message).toContain(MISSING_TRIGGER);
      expect(error?.message).toContain(MISSING_PRIVILEGE);

      expect(await catalog(t)).toEqual(before);
      expect(await rpcs(t)).toEqual({ connect: false, activate: false, connect_execute: "", activate_execute: "" });
    } finally {
      await t.close();
    }
  });
});

describe("3. one E1 protection missing or altered: M1 refuses, names it and changes nothing", () => {
  const cases: Array<[string, string, string]> = [
    ["trigger dropped", `drop trigger ${GUARD_TRIGGER} on public.email_accounts`, MISSING_TRIGGER],
    ["trigger disabled", `alter table public.email_accounts disable trigger ${GUARD_TRIGGER}`, MISSING_TRIGGER],
    ["trigger enabled for replica sessions only", `alter table public.email_accounts enable replica trigger ${GUARD_TRIGGER}`, MISSING_TRIGGER],
    ["trigger function dropped (with its trigger)", "drop function private.guard_email_account_member_update() cascade", MISSING_TRIGGER],
    ["INSERT granted again on columns (the pre-E1 shape)", "grant insert (organization_id, provider, status, email_address, display_name) on table public.email_accounts to authenticated", MISSING_PRIVILEGE],
    ["INSERT granted on the table", "grant insert on table public.email_accounts to authenticated", MISSING_PRIVILEGE],
    ["UPDATE of provider_metadata granted again", "grant update (provider_metadata) on table public.email_accounts to authenticated", MISSING_PRIVILEGE],
    ["UPDATE granted on the table", "grant update on table public.email_accounts to authenticated", MISSING_PRIVILEGE],
    ["connect_imap_email_account dropped", `drop function ${CONNECT}`, MISSING_FUNCTION]
  ];

  it.each(cases)("%s", async (_label, alteration, missing) => {
    const t = await createTestDatabase({ defaultPrivileges: "production", stopBefore: M1 });
    try {
      await t.db.exec(alteration);
      const before = await catalog(t);

      const error = await apply(t, M1_SQL);
      expect(error?.message).toMatch(REFUSED);
      expect(error?.message).toContain(missing);
      // Only the altered protection is reported.
      for (const other of [MISSING_FUNCTION, MISSING_TRIGGER, MISSING_PRIVILEGE].filter((item) => item !== missing)) {
        expect(error?.message).not.toContain(other);
      }

      expect(await catalog(t)).toEqual(before);
      expect((await rpcs(t)).activate).toBe(false);
    } finally {
      await t.close();
    }
  });
});

describe("4-6. after every migration (E1, M1, then the rest)", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ defaultPrivileges: "production" });
  });
  afterAll(async () => t?.close());

  it("4. the final connect_imap_email_account is M1's, with E1's protections in place", async () => {
    expect(await connectMailbox(t)).toEqual(M1_BEHAVIOUR);
    expect(await memberPrivileges(t)).toEqual(E1_PRIVILEGES);
    expect(await guardTriggers(t)).toEqual([{ fn: "private.guard_email_account_member_update()", enabled: "O" }]);
    expect(await rpcs(t)).toEqual({ connect: true, activate: true, connect_execute: "service_role", activate_execute: "service_role" });
  });

  it("5. E1 repeated after M1 fails (IMAP rows already there): M1's function, ACLs and rows unchanged", async () => {
    const before = await catalog(t);
    // Ordered by the organization_plan enum (BASIC, PRO, BUSINESS).
    expect(before.imap).toEqual([
      { code: "BASIC", kind: "FEATURE", enabled: false },
      { code: "PRO", kind: "FEATURE", enabled: true },
      { code: "BUSINESS", kind: "FEATURE", enabled: true }
    ]);

    const error = await apply(t, E1_SQL);
    expect(error?.message).toMatch(/duplicate key value violates unique constraint "plan_entitlements_pkey"/);

    expect(await catalog(t)).toEqual(before);
    expect(await memberPrivileges(t)).toEqual(E1_PRIVILEGES);
    expect(await guardTriggers(t)).toHaveLength(1);
    expect(await connectMailbox(t)).toEqual(M1_BEHAVIOUR);
  });

  it("6. E1 repeated after M1 with the IMAP rows deleted fails at its trigger: M1's function kept, nothing applied", async () => {
    const saved = await rows<{ plan_id: string; key: string; kind: string; enabled: boolean }>(
      t,
      "select plan_id::text, key, kind::text, enabled from public.plan_entitlements where key = 'IMAP' order by plan_id"
    );
    expect(saved).toHaveLength(3);
    await t.db.exec("delete from public.plan_entitlements where key = 'IMAP'");
    const before = await catalog(t);
    expect(before.imap).toEqual([]);

    const error = await apply(t, E1_SQL);
    expect(error?.message).toMatch(/trigger "email_accounts_guard_member_update" for relation "email_accounts" already exists/);

    // The INSERT of the 3 IMAP rows that ran before the failure was not kept either (one exec, one transaction).
    expect(await catalog(t)).toEqual(before);
    expect(await guardTriggers(t)).toHaveLength(1);

    // With the plan rows back, the function still behaves as M1's.
    for (const row of saved) {
      await t.db.query("insert into public.plan_entitlements (plan_id, key, kind, enabled) values ($1, $2, $3::public.plan_entitlement_kind, $4)", [
        row.plan_id,
        row.key,
        row.kind,
        row.enabled
      ]);
    }
    expect(await connectMailbox(t)).toEqual(M1_BEHAVIOUR);
  });
});
