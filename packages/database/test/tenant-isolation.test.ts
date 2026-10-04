import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { count, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Core multi-tenant guarantee: a user of organization A can never read or
 * write data of organization B, regardless of what the client sends.
 */

let t: TestDatabase;
let f: Fixtures;

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
});

afterAll(async () => {
  await t?.close();
});

const TENANT_TABLES = [
  "organization_members",
  "organization_settings",
  "email_accounts",
  "categories",
  "email_rules",
  "emails",
  "email_attachments"
] as const;

describe("tenant isolation: reads", () => {
  it.each(TENANT_TABLES)("a member of A cannot read rows of B in %s", async (table) => {
    for (const userId of [f.a.ownerId, f.a.adminId, f.a.operatorId, f.a.viewerId]) {
      const visibleB = await t.asUser(userId, (tx) =>
        count(tx, `select organization_id from public.${table} where organization_id = $1`, [f.b.orgId])
      );
      expect(visibleB).toBe(0);
    }
  });

  it.each(TENANT_TABLES)("members still see their own organization rows in %s", async (table) => {
    const visibleA = await t.asUser(f.a.viewerId, (tx) =>
      count(tx, `select organization_id from public.${table} where organization_id = $1`, [f.a.orgId])
    );
    expect(visibleA).toBeGreaterThan(0);
  });

  it("an unfiltered select only returns the caller's organization", async () => {
    const orgIds = await t.asUser(f.a.ownerId, async (tx) => {
      const result = await tx.query<{ organization_id: string }>("select distinct organization_id from public.emails");
      return result.rows.map((row) => row.organization_id);
    });
    expect(orgIds).toEqual([f.a.orgId]);
  });

  it("organizations: each owner only sees their organization", async () => {
    const seenByA = await t.asUser(f.a.ownerId, (tx) => count(tx, "select id from public.organizations"));
    const seenByB = await t.asUser(f.b.ownerId, (tx) => count(tx, "select id from public.organizations"));
    expect(seenByA).toBe(1);
    expect(seenByB).toBe(1);
  });

  it("a user without memberships sees nothing", async () => {
    for (const table of ["organizations", ...TENANT_TABLES, "audit_logs"]) {
      const visible = await t.asUser(f.outsiderId, (tx) => count(tx, `select 1 from public.${table}`));
      expect(visible, table).toBe(0);
    }
  });

  it("anonymous requests cannot read tenant tables", async () => {
    await expect(t.asAnon((tx) => count(tx, "select 1 from public.emails"))).rejects.toThrow(/permission denied/);
  });

  it("profiles of other organizations are hidden", async () => {
    const visible = await t.asUser(f.a.ownerId, (tx) =>
      count(tx, "select id from public.profiles where id = $1", [f.b.ownerId])
    );
    expect(visible).toBe(0);

    const ownOrgProfiles = await t.asUser(f.a.viewerId, (tx) => count(tx, "select id from public.profiles"));
    expect(ownOrgProfiles).toBe(4);
  });

  it("audit logs of another organization are hidden even for owners", async () => {
    const visible = await t.asUser(f.a.ownerId, (tx) =>
      count(tx, "select id from public.audit_logs where organization_id = $1", [f.b.orgId])
    );
    expect(visible).toBe(0);
  });
});

describe("tenant isolation: writes", () => {
  it("an admin of A cannot create resources inside B", async () => {
    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query("insert into public.categories (organization_id, name, slug) values ($1, 'X', 'x')", [f.b.orgId])
      )
    ).rejects.toThrow(/row-level security/);

    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query(
          "insert into public.email_rules (organization_id, name) values ($1, 'X')",
          [f.b.orgId]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("an owner of A cannot update or delete rows of B", async () => {
    const updated = await t.asUser(f.a.ownerId, async (tx) => {
      const result = await tx.query("update public.email_rules set name = 'hacked' where id = $1", [f.b.ruleId]);
      return result.affectedRows;
    });
    expect(updated).toBe(0);

    const deleted = await t.asUser(f.a.ownerId, async (tx) => {
      const result = await tx.query("delete from public.emails where id = $1", [f.b.emailId]);
      return result.affectedRows;
    });
    expect(deleted).toBe(0);

    const stillThere = await t.asService((tx) =>
      count(tx, "select 1 from public.email_rules where id = $1 and name = 'Rule'", [f.b.ruleId])
    );
    expect(stillThere).toBe(1);
  });

  it("an owner of A cannot add themselves to B", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')", [
          f.b.orgId,
          f.a.ownerId
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("rows cannot reference resources of another tenant (even with service role)", async () => {
    await expect(
      t.asService((tx) =>
        tx.query(
          `insert into public.emails (organization_id, email_account_id, category_id, sender_email, received_at)
           values ($1, $2, $3, 'x@example.com', now())`,
          [f.a.orgId, f.a.accountId, f.b.categoryId]
        )
      )
    ).rejects.toThrow(/Category does not belong/);

    await expect(
      t.asService((tx) =>
        tx.query(
          `insert into public.emails (organization_id, email_account_id, sender_email, received_at)
           values ($1, $2, 'x@example.com', now())`,
          [f.a.orgId, f.b.accountId]
        )
      )
    ).rejects.toThrow(/Email account does not belong/);

    await expect(
      t.asService((tx) =>
        tx.query("insert into public.email_attachments (organization_id, email_id, filename) values ($1, $2, 'x')", [
          f.a.orgId,
          f.b.emailId
        ])
      )
    ).rejects.toThrow(/Attachment does not belong/);
  });
});
