import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Migration 9: processing state owned by the worker (service_role may update
 * only the processing columns), idempotent attachment rows, and no
 * processing-state writes by authenticated users.
 */

const MIGRATION_9 = "20261003150000";
const PROCESSING_COLUMNS = ["processing_status", "processed_at", "processing_error_code", "processing_error_message", "processing_attempts"];
const OTHER_COLUMNS = ["subject", "text_body", "organization_id", "email_account_id", "provider_message_id", "processing_started_at", "is_read", "category_id"];

const columnPrivilege = (tx: Tx, role: string, column: string, privilege: string) =>
  one<{ granted: boolean }>(tx, "select has_column_privilege($1, 'public.emails', $2, $3) as granted", [role, column, privilege]).then(
    (row) => row.granted
  );

const insertAttachment = (tx: Tx, f: Fixtures, providerId: string | null, filename = "f.pdf") =>
  tx.query<{ id: string }>(
    `insert into public.email_attachments (organization_id, email_id, provider_attachment_id, filename)
     values ($1, $2, $3, $4)
     on conflict (email_id, provider_attachment_id) do nothing
     returning id`,
    [f.a.orgId, f.a.emailId, providerId, filename]
  );

describe("migration 9 exists", () => {
  it("is the ninth migration", () => {
    expect(listMigrationFiles()[8]).toBe(`${MIGRATION_9}_processing_completion.sql`);
  });
});

describe("BEFORE migration 9 (reproduces the gaps)", () => {
  let t: TestDatabase;
  let f: Fixtures;
  beforeAll(async () => {
    t = await createTestDatabase({ stopBefore: MIGRATION_9 });
    f = await seedTwoTenants(t);
  });
  afterAll(async () => t?.close());

  it("an OPERATOR could rewrite processing_status", async () => {
    const updated = await t.asUser(f.a.operatorId, async (tx) => {
      const result = await tx.query("update public.emails set processing_status = 'PROCESSED' where id = $1", [f.a.emailId]);
      return result.affectedRows;
    });
    expect(updated).toBe(1);
  });

  it("the service role could not record processing completion", async () => {
    await expect(
      t.asService((tx) => tx.query("update public.emails set processing_status = 'PROCESSED' where id = $1", [f.a.emailId]))
    ).rejects.toThrow(/permission denied/);
  });

  it("the same provider attachment could be stored twice", async () => {
    await t.asService(async (tx) => {
      await tx.query("insert into public.email_attachments (organization_id, email_id, provider_attachment_id, filename) values ($1, $2, 'dup', 'a.pdf')", [f.a.orgId, f.a.emailId]);
      await tx.query("insert into public.email_attachments (organization_id, email_id, provider_attachment_id, filename) values ($1, $2, 'dup', 'a.pdf')", [f.a.orgId, f.a.emailId]);
    });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_attachments where provider_attachment_id = 'dup'"))).toBe(2);
  });
});

describe("AFTER migration 9", () => {
  let t: TestDatabase;
  let f: Fixtures;
  beforeAll(async () => {
    t = await createTestDatabase();
    f = await seedTwoTenants(t);
  });
  afterAll(async () => t?.close());

  it("service_role may update exactly the processing columns, nothing else, and still has no DELETE", async () => {
    await t.asAdmin(async (tx) => {
      for (const column of PROCESSING_COLUMNS) expect(await columnPrivilege(tx, "service_role", column, "UPDATE"), column).toBe(true);
      for (const column of OTHER_COLUMNS) expect(await columnPrivilege(tx, "service_role", column, "UPDATE"), column).toBe(false);
      const table = await one<{ del: boolean; upd: boolean; ins: boolean; sel: boolean }>(
        tx,
        `select has_table_privilege('service_role', 'public.emails', 'DELETE') as del,
                has_table_privilege('service_role', 'public.emails', 'UPDATE') as upd,
                has_table_privilege('service_role', 'public.emails', 'INSERT') as ins,
                has_table_privilege('service_role', 'public.emails', 'SELECT') as sel`
      );
      expect(table).toEqual({ del: false, upd: false, ins: true, sel: true });
    });
  });

  it("service_role walks an email through RECEIVED -> PROCESSING -> PROCESSED", async () => {
    await t.asService(async (tx) => {
      const email = await one<{ id: string; processing_status: string }>(
        tx,
        `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at, processing_started_at, processing_attempts)
         values ($1, $2, 'state-1', 's@example.com', now(), now(), 1) returning id, processing_status`,
        [f.a.orgId, f.a.accountId]
      );
      expect(email.processing_status).toBe("RECEIVED");
      await tx.query("update public.emails set processing_status = 'PROCESSING', processing_attempts = 2 where id = $1", [email.id]);
      await tx.query(
        "update public.emails set processing_status = 'PROCESSED', processed_at = now(), processing_error_code = null, processing_error_message = null where id = $1",
        [email.id]
      );
      const row = await one<{ processing_status: string; processing_attempts: number; processed: boolean }>(
        tx,
        "select processing_status, processing_attempts, processed_at is not null as processed from public.emails where id = $1",
        [email.id]
      );
      expect(row).toEqual({ processing_status: "PROCESSED", processing_attempts: 2, processed: true });
    });
  });

  it.each([
    ["subject", "update public.emails set subject = 'x' where id = $1"],
    ["processing_started_at", "update public.emails set processing_started_at = now() where id = $1"],
    ["is_read", "update public.emails set is_read = true where id = $1"],
    ["DELETE", "delete from public.emails where id = $1"]
  ])("service_role cannot %s", async (_label, sql) => {
    await expect(t.asService((tx) => tx.query(sql, [f.a.emailId]))).rejects.toThrow(/permission denied/);
  });

  it.each([["operatorId"], ["adminId"], ["ownerId"]] as const)("%s cannot write processing state", async (who) => {
    const userId = f.a[who];
    await expect(
      t.asUser(userId, (tx) => tx.query("update public.emails set processing_status = 'PROCESSED' where id = $1", [f.a.emailId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(userId, (tx) => tx.query("update public.emails set processing_attempts = 99, processed_at = now() where id = $1", [f.a.emailId]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(userId, (tx) =>
        tx.query(
          "insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at, processing_status) values ($1, $2, $3, 'x@example.com', now(), 'PROCESSED')",
          [f.a.orgId, f.a.accountId, `spoof-${who}`]
        )
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("an OPERATOR keeps every other email permission", async () => {
    const updated = await t.asUser(f.a.operatorId, async (tx) => {
      const result = await tx.query(
        "update public.emails set is_read = true, is_important = true, is_archived = false, category_id = $2 where id = $1",
        [f.a.emailId, f.a.categoryId]
      );
      return result.affectedRows;
    });
    expect(updated).toBe(1);
    await t.asAdmin(async (tx) => {
      for (const column of ["category_id", "matched_rule_id", "extracted_data", "is_read", "is_important", "is_archived"]) {
        expect(await columnPrivilege(tx, "authenticated", column, "UPDATE"), column).toBe(true);
      }
      expect(await columnPrivilege(tx, "authenticated", "subject", "INSERT")).toBe(true);
      expect(await columnPrivilege(tx, "authenticated", "processing_status", "INSERT")).toBe(false);
    });
  });

  it("an OPERATOR insert without processing columns gets RECEIVED (worker-owned state)", async () => {
    const row = await t.asUser(f.a.operatorId, (tx) =>
      one<{ processing_status: string }>(
        tx,
        "insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at) values ($1, $2, 'op-1', 'x@example.com', now()) returning processing_status",
        [f.a.orgId, f.a.accountId]
      )
    );
    expect(row.processing_status).toBe("RECEIVED");
  });

  it("the same provider attachment is stored once (ON CONFLICT DO NOTHING)", async () => {
    await t.asService(async (tx) => {
      expect((await insertAttachment(tx, f, "att-1")).rows).toHaveLength(1);
      expect((await insertAttachment(tx, f, "att-1")).rows).toHaveLength(0);
    });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_attachments where provider_attachment_id = 'att-1'"))).toBe(1);
  });

  it("a plain duplicate insert is rejected by the unique index", async () => {
    await expect(
      t.asService((tx) =>
        tx.query("insert into public.email_attachments (organization_id, email_id, provider_attachment_id, filename) values ($1, $2, 'att-1', 'x.pdf')", [
          f.a.orgId,
          f.a.emailId
        ])
      )
    ).rejects.toThrow(/email_attachments_email_provider_attachment_unique_idx/);
  });

  it("different attachments of the same email are all kept", async () => {
    await t.asService(async (tx) => {
      expect((await insertAttachment(tx, f, "att-2")).rows).toHaveLength(1);
      expect((await insertAttachment(tx, f, "att-3")).rows).toHaveLength(1);
    });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_attachments where provider_attachment_id in ('att-2','att-3')"))).toBe(2);
  });

  it("attachments without a provider id never conflict", async () => {
    await t.asService(async (tx) => {
      expect((await insertAttachment(tx, f, null, "a.pdf")).rows).toHaveLength(1);
      expect((await insertAttachment(tx, f, null, "a.pdf")).rows).toHaveLength(1);
    });
    // + the fixture's own NULL-id attachment
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_attachments where email_id = $1 and provider_attachment_id is null", [f.a.emailId]))).toBe(3);
  });

  it("the same provider id on different emails is allowed", async () => {
    await t.asService(async (tx) => {
      await tx.query(
        "insert into public.email_attachments (organization_id, email_id, provider_attachment_id, filename) values ($1, $2, 'att-1', 'b.pdf')",
        [f.b.orgId, f.b.emailId]
      );
    });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_attachments where provider_attachment_id = 'att-1'"))).toBe(2);
  });

  it("tenant isolation: attachments cannot be attached to another organization's email", async () => {
    await expect(
      t.asService((tx) =>
        tx.query("insert into public.email_attachments (organization_id, email_id, provider_attachment_id, filename) values ($1, $2, 'x', 'x.pdf')", [
          f.a.orgId,
          f.b.emailId
        ])
      )
    ).rejects.toThrow();
    await expect(
      t.asUser(f.a.operatorId, (tx) =>
        tx.query("insert into public.email_attachments (organization_id, email_id, filename) values ($1, $2, 'x.pdf')", [f.b.orgId, f.b.emailId])
      )
    ).rejects.toThrow(/row-level security/);
    expect(await t.asUser(f.a.ownerId, (tx) => count(tx, "select 1 from public.email_attachments where organization_id = $1", [f.b.orgId]))).toBe(0);
    expect(
      await t.asUser(f.a.ownerId, async (tx) => {
        const result = await tx.query("update public.emails set is_read = true where id = $1", [f.b.emailId]);
        return result.affectedRows;
      })
    ).toBe(0);
  });

  it("RLS stays enabled and policies are unchanged", async () => {
    await t.asAdmin(async (tx) => {
      expect(
        await count(tx, "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")
      ).toBe(0);
      // The 10 V1 tables (later V2 tables add their own policies; see v1-compatibility.test.ts).
      expect(await count(tx, "select 1 from pg_policies where schemaname = 'public' and tablename <> all($1)", [["bots", "customers", "customer_identifiers", "bot_customer_assignments", "email_deliveries", "customer_access_credentials", "customer_sessions", "plan_catalog", "plan_prices", "plan_entitlements", "subscriptions"]])).toBe(31);
    });
  });
});
