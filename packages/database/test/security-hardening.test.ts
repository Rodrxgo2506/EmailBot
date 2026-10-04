import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, type TestDatabase } from "../src/harness.js";
import { one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Migration 6 (security hardening). The remote project contains
 * public.rls_auto_enable() + the "ensure_rls" event trigger (created
 * outside this repository); the same objects are recreated here so the
 * conditional REVOKE is exercised exactly as it would run remotely.
 */
const REMOTE_OBJECTS = `
create function public.rls_auto_enable() returns event_trigger
language plpgsql security definer set search_path = pg_catalog
as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$$;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
`;

let t: TestDatabase;
let f: Fixtures;

beforeEach(async () => {
  t = await createTestDatabase({ preMigrationSql: REMOTE_OBJECTS });
  f = await seedTwoTenants(t);
});

afterEach(async () => {
  await t?.close();
});

describe("migration 6: attachment storage location is server-owned", () => {
  it("is applied right after the five previous migrations", () => {
    expect(listMigrationFiles()[5]).toBe("20261003120000_security_hardening.sql");
  });

  it("OPERATOR cannot point an attachment at another object", async () => {
    await expect(
      t.asUser(f.a.operatorId, (tx) =>
        tx.query("update public.email_attachments set storage_path = $1 where id = $2", [
          `${f.b.orgId}/x/y/secret.pdf`,
          f.a.attachmentId
        ])
      )
    ).rejects.toThrow(/permission denied/);

    await expect(
      t.asUser(f.a.operatorId, (tx) =>
        tx.query(
          `insert into public.email_attachments (organization_id, email_id, filename, storage_bucket, storage_path, storage_uploaded)
           values ($1, $2, 'x.pdf', 'email-attachments', $3, true)`,
          [f.a.orgId, f.a.emailId, `${f.b.orgId}/x/y/secret.pdf`]
        )
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("OPERATOR can still record attachment metadata and the worker (service role) can store locations", async () => {
    const inserted = await t.asUser(f.a.operatorId, (tx) =>
      one<{ id: string }>(
        tx,
        "insert into public.email_attachments (organization_id, email_id, filename) values ($1, $2, 'meta.pdf') returning id",
        [f.a.orgId, f.a.emailId]
      )
    );

    await t.asService((tx) =>
      tx.query("update public.email_attachments set storage_bucket = 'email-attachments', storage_path = $1, storage_uploaded = true where id = $2", [
        `${f.a.orgId}/${f.a.emailId}/${inserted.id}/meta.pdf`,
        inserted.id
      ])
    );
  });
});

describe("migration 6: rule categories are tenant-scoped", () => {
  it("a rule cannot reference a category of another organization", async () => {
    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query("update public.email_rules set category_id = $1 where id = $2", [f.b.categoryId, f.a.ruleId])
      )
    ).rejects.toThrow(/does not belong to the rule organization/);

    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query("insert into public.email_rules (organization_id, category_id, name) values ($1, $2, 'x')", [
          f.a.orgId,
          f.b.categoryId
        ])
      )
    ).rejects.toThrow(/does not belong to the rule organization/);
  });

  it("same-organization and empty categories keep working", async () => {
    const updated = await t.asUser(f.a.adminId, async (tx) => {
      await tx.query("update public.email_rules set category_id = null where id = $1", [f.a.ruleId]);
      const result = await tx.query("update public.email_rules set category_id = $1 where id = $2", [f.a.categoryId, f.a.ruleId]);
      return result.affectedRows;
    });
    expect(updated).toBe(1);
  });

  it("deleting a category still sets rules to NULL (ON DELETE SET NULL)", async () => {
    await t.asUser(f.a.adminId, (tx) => tx.query("delete from public.emails where category_id = $1", [f.a.categoryId]));
    await t.asUser(f.a.adminId, (tx) => tx.query("delete from public.categories where id = $1", [f.a.categoryId]));
    const rule = await t.asService((tx) =>
      one<{ category_id: string | null }>(tx, "select category_id from public.email_rules where id = $1", [f.a.ruleId])
    );
    expect(rule.category_id).toBeNull();
  });
});

describe("migration 6: public.rls_auto_enable()", () => {
  it("revokes EXECUTE from anon/authenticated/PUBLIC", async () => {
    const privileges = await t.asService((tx) =>
      one<{ anon: boolean; authenticated: boolean }>(
        tx,
        `select has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') as anon,
                has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') as authenticated`
      )
    );
    expect(privileges).toEqual({ anon: false, authenticated: false });
  });

  it("cannot be invoked directly: PostgreSQL only runs it as an event trigger", async () => {
    await expect(t.db.query("select public.rls_auto_enable()")).rejects.toThrow(/can only be called as triggers/);
  });

  it("the event trigger keeps enabling RLS on new public tables", async () => {
    await t.db.exec("create table public.audit_probe (id int)");
    const row = await t.asService((tx) =>
      one<{ enabled: boolean }>(tx, "select relrowsecurity as enabled from pg_class where oid = 'public.audit_probe'::regclass")
    );
    expect(row.enabled).toBe(true);
  });
});
