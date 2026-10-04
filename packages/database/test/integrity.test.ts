import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, type TestDatabase } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

let t: TestDatabase;
let f: Fixtures;

beforeEach(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
});

afterEach(async () => {
  await t?.close();
});

describe("migrations", () => {
  it("keeps the four historical migrations and applies them in order", () => {
    const files = listMigrationFiles();
    expect(files.slice(0, 4)).toEqual([
      "20261002034319_initial_schema.sql",
      "20261002035321_email_accounts_categories_rules.sql",
      "20261002035803_emails_and_attachments.sql",
      "20261002040254_organization_settings_and_audit_logs.sql"
    ]);
  });
});

describe("credentials", () => {
  it("authenticated users can never read encrypted tokens", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("select access_token_encrypted from public.email_accounts"))
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("select refresh_token_encrypted from public.email_accounts"))
    ).rejects.toThrow(/permission denied/);
  });

  it("authenticated users cannot write tokens", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("update public.email_accounts set refresh_token_encrypted = 'x' where id = $1", [f.a.accountId])
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("the service role (backend/worker) can read them", async () => {
    const row = await t.asService((tx) =>
      one<{ refresh_token_encrypted: string }>(
        tx,
        "select refresh_token_encrypted from public.email_accounts where id = $1",
        [f.a.accountId]
      )
    );
    expect(row.refresh_token_encrypted).toBe("v1.iv.tag.refresh");
  });
});

describe("email deduplication", () => {
  const insertEmail = `
    insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at)
    values ($1, $2, $3, 'sender@example.com', now())
    on conflict (email_account_id, provider_message_id) do nothing
    returning id`;

  it("the same provider message is stored only once per account", async () => {
    const first = await t.asService((tx) => tx.query(insertEmail, [f.a.orgId, f.a.accountId, "dup-1"]));
    const second = await t.asService((tx) => tx.query(insertEmail, [f.a.orgId, f.a.accountId, "dup-1"]));

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
    expect(
      await t.asService((tx) =>
        count(tx, "select 1 from public.emails where email_account_id = $1 and provider_message_id = 'dup-1'", [
          f.a.accountId
        ])
      )
    ).toBe(1);
  });

  it("a plain duplicate insert is rejected by the unique index", async () => {
    await expect(
      t.asService((tx) =>
        tx.query(
          `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at)
           values ($1, $2, 'provider-msg-1', 'sender@example.com', now())`,
          [f.a.orgId, f.a.accountId]
        )
      )
    ).rejects.toThrow(/emails_account_provider_message_unique_idx/);
  });

  it("the same provider id in another account is a different message", async () => {
    const other = await t.asService((tx) => tx.query(insertEmail, [f.b.orgId, f.b.accountId, "provider-msg-1"]));
    // provider-msg-1 already exists for account B from the fixtures.
    expect(other.rows).toHaveLength(0);
    const fresh = await t.asService((tx) => tx.query(insertEmail, [f.b.orgId, f.b.accountId, "dup-1"]));
    expect(fresh.rows).toHaveLength(1);
  });
});

describe("audit logs", () => {
  it("are immutable for every role, including the database owner", async () => {
    await expect(
      t.asAdmin((tx) => tx.query("update public.audit_logs set description = 'x' where organization_id = $1", [f.a.orgId]))
    ).rejects.toThrow(/immutable/);
    await expect(
      t.asAdmin((tx) => tx.query("delete from public.audit_logs where organization_id = $1", [f.a.orgId]))
    ).rejects.toThrow(/immutable/);
  });

  it("cannot be written by authenticated users", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("insert into public.audit_logs (organization_id, actor_user_id, action) values ($1, $2, 'LOGIN')", [
          f.a.orgId,
          f.a.ownerId
        ])
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("USER events require an actor that belongs to the organization", async () => {
    await expect(
      t.asService((tx) =>
        tx.query("insert into public.audit_logs (organization_id, actor_type, action) values ($1, 'USER', 'LOGIN')", [
          f.a.orgId
        ])
      )
    ).rejects.toThrow(/require actor_user_id/);

    await expect(
      t.asService((tx) =>
        tx.query(
          "insert into public.audit_logs (organization_id, actor_type, actor_user_id, action) values ($1, 'USER', $2, 'LOGIN')",
          [f.a.orgId, f.b.ownerId]
        )
      )
    ).rejects.toThrow(/does not belong/);
  });

  it("allow deleting an organization (cascade) — fixed by migration 5", async () => {
    // Organization deletion is an administrative operation (the backend role has no DELETE).
    await t.asAdmin((tx) => tx.query("delete from public.organizations where id = $1", [f.b.orgId]));

    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.organizations where id = $1", [f.b.orgId]))).toBe(0);
    expect(
      await t.asAdmin((tx) => count(tx, "select 1 from public.audit_logs where organization_id = $1", [f.b.orgId]))
    ).toBe(0);
    // Organization A is untouched.
    expect(
      await t.asAdmin((tx) => count(tx, "select 1 from public.audit_logs where organization_id = $1", [f.a.orgId]))
    ).toBe(1);
  });

  it("allow deleting a non-owner user with audit history and keep the record anonymized", async () => {
    await t.asService((tx) =>
      tx.query(
        "insert into public.audit_logs (organization_id, actor_type, actor_user_id, action) values ($1, 'USER', $2, 'LOGIN')",
        [f.a.orgId, f.a.adminId]
      )
    );

    await t.db.query("delete from auth.users where id = $1", [f.a.adminId]);

    // service_role can write audit logs but not read them back (INSERT only).
    const rows = await t.asAdmin(async (tx) => {
      const result = await tx.query<{ actor_type: string; actor_user_id: string | null }>(
        "select actor_type, actor_user_id from public.audit_logs where organization_id = $1 and action = 'LOGIN'",
        [f.a.orgId]
      );
      return result.rows;
    });
    expect(rows).toEqual([{ actor_type: "USER", actor_user_id: null }]);
  });

  it("still refuse deleting a user who is the OWNER of an organization", async () => {
    await expect(t.db.query("delete from auth.users where id = $1", [f.a.ownerId])).rejects.toThrow(
      /must always have an OWNER/
    );
  });
});

describe("storage", () => {
  it("creates a private attachments bucket", async () => {
    const bucket = await t.asService((tx) =>
      one<{ public: boolean; file_size_limit: number }>(
        tx,
        "select public, file_size_limit from storage.buckets where id = 'email-attachments'"
      )
    );
    expect(bucket.public).toBe(false);
    expect(Number(bucket.file_size_limit)).toBe(26214400);
  });
});
