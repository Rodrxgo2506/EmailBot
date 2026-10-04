import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

let t: TestDatabase;
let f: Fixtures;

describe("RBAC (read-only scenarios, shared database)", () => {
  beforeAll(async () => {
    t = await createTestDatabase();
    f = await seedTwoTenants(t);
  });

  afterAll(async () => {
    await t?.close();
  });

  it("ADMIN cannot promote themselves to OWNER", async () => {
    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query("update public.organization_members set role = 'OWNER' where organization_id = $1 and user_id = $2", [
          f.a.orgId,
          f.a.adminId
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("ADMIN cannot insert an OWNER membership", async () => {
    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')", [
          f.a.orgId,
          f.outsiderId
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("ADMIN cannot transfer ownership to themselves", async () => {
    await expect(
      t.asUser(f.a.adminId, (tx) =>
        tx.query("select public.transfer_organization_ownership($1, $2)", [f.a.orgId, f.a.adminId])
      )
    ).rejects.toThrow(/Only the current OWNER/);
  });

  it("ADMIN cannot remove or demote the OWNER", async () => {
    const deleted = await t.asUser(f.a.adminId, async (tx) => {
      const result = await tx.query("delete from public.organization_members where organization_id = $1 and user_id = $2", [
        f.a.orgId,
        f.a.ownerId
      ]);
      return result.affectedRows;
    });
    expect(deleted).toBe(0);

    const demoted = await t.asUser(f.a.adminId, async (tx) => {
      const result = await tx.query(
        "update public.organization_members set role = 'VIEWER' where organization_id = $1 and user_id = $2",
        [f.a.orgId, f.a.ownerId]
      );
      return result.affectedRows;
    });
    expect(demoted).toBe(0);
  });

  it("the OWNER cannot delete their own membership (organization would be left without OWNER)", async () => {
    const deleted = await t.asUser(f.a.ownerId, async (tx) => {
      const result = await tx.query("delete from public.organization_members where organization_id = $1 and user_id = $2", [
        f.a.orgId,
        f.a.ownerId
      ]);
      return result.affectedRows;
    });
    expect(deleted).toBe(0);
  });

  it("even the database owner (postgres) cannot leave an organization without OWNER", async () => {
    await expect(
      t.asAdmin((tx) =>
        tx.query("delete from public.organization_members where organization_id = $1 and role = 'OWNER'", [f.a.orgId])
      )
    ).rejects.toThrow(/must always have an OWNER/);

    await expect(
      t.asAdmin((tx) =>
        tx.query("update public.organization_members set role = 'ADMIN' where organization_id = $1 and role = 'OWNER'", [
          f.a.orgId
        ])
      )
    ).rejects.toThrow(/must always have an OWNER/);
  });

  it("an organization cannot have two OWNERs", async () => {
    await expect(
      t.asAdmin((tx) =>
        tx.query("update public.organization_members set role = 'OWNER' where organization_id = $1 and user_id = $2", [
          f.a.orgId,
          f.a.adminId
        ])
      )
    ).rejects.toThrow(/organization_members_one_owner_idx/);
  });

  it("OPERATOR and VIEWER cannot manage rules, categories or accounts", async () => {
    for (const userId of [f.a.operatorId, f.a.viewerId]) {
      await expect(
        t.asUser(userId, (tx) =>
          tx.query("insert into public.email_rules (organization_id, name) values ($1, 'X')", [f.a.orgId])
        )
      ).rejects.toThrow(/row-level security/);

      await expect(
        t.asUser(userId, (tx) =>
          tx.query("insert into public.categories (organization_id, name, slug) values ($1, 'X', 'x2')", [f.a.orgId])
        )
      ).rejects.toThrow(/row-level security/);

      const updatedAccounts = await t.asUser(userId, async (tx) => {
        const result = await tx.query("update public.email_accounts set status = 'PAUSED' where id = $1", [f.a.accountId]);
        return result.affectedRows;
      });
      expect(updatedAccounts).toBe(0);
    }
  });

  it("OPERATOR can update emails but VIEWER cannot", async () => {
    const byOperator = await t.asUser(f.a.operatorId, async (tx) => {
      const result = await tx.query("update public.emails set is_read = true where id = $1", [f.a.emailId]);
      return result.affectedRows;
    });
    expect(byOperator).toBe(1);

    const byViewer = await t.asUser(f.a.viewerId, async (tx) => {
      const result = await tx.query("update public.emails set is_read = false where id = $1", [f.a.emailId]);
      return result.affectedRows;
    });
    expect(byViewer).toBe(0);
  });

  it("organization plan/status are not client-writable", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.organizations set plan = 'BUSINESS' where id = $1", [f.a.orgId]))
    ).rejects.toThrow(/permission denied/);
  });

  it("only OWNER/ADMIN can read audit logs", async () => {
    expect(await t.asUser(f.a.adminId, (tx) => count(tx, "select 1 from public.audit_logs"))).toBeGreaterThan(0);
    expect(await t.asUser(f.a.operatorId, (tx) => count(tx, "select 1 from public.audit_logs"))).toBe(0);
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.audit_logs"))).toBe(0);
  });
});

describe("ownership transfer (mutating, fresh database per test)", () => {
  beforeEach(async () => {
    t = await createTestDatabase();
    f = await seedTwoTenants(t);
  });

  afterAll(async () => {
    await t?.close();
  });

  it("the OWNER can transfer ownership atomically; the previous owner becomes ADMIN", async () => {
    await t.asUser(f.a.ownerId, (tx) =>
      tx.query("select public.transfer_organization_ownership($1, $2)", [f.a.orgId, f.a.adminId])
    );

    const roles = await t.asService(async (tx) => {
      const result = await tx.query<{ user_id: string; role: string }>(
        "select user_id, role from public.organization_members where organization_id = $1",
        [f.a.orgId]
      );
      return Object.fromEntries(result.rows.map((row) => [row.user_id, row.role]));
    });

    expect(roles[f.a.adminId]).toBe("OWNER");
    expect(roles[f.a.ownerId]).toBe("ADMIN");
    expect(Object.values(roles).filter((role) => role === "OWNER")).toHaveLength(1);
  });

  it("ownership cannot be transferred to a non-member", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("select public.transfer_organization_ownership($1, $2)", [f.a.orgId, f.outsiderId])
      )
    ).rejects.toThrow(/must already be a member/);
  });

  it("create_organization makes the caller the only OWNER", async () => {
    const orgId = await t.asUser(f.outsiderId, (tx) =>
      one<{ id: string }>(tx, "select public.create_organization('New Org', 'new-org') as id")
    );
    const owner = await t.asService((tx) =>
      one<{ user_id: string; role: string }>(
        tx,
        "select user_id, role from public.organization_members where organization_id = $1",
        [orgId.id]
      )
    );
    expect(owner).toEqual({ user_id: f.outsiderId, role: "OWNER" });

    const settings = await t.asUser(f.outsiderId, (tx) =>
      count(tx, "select 1 from public.organization_settings where organization_id = $1", [orgId.id])
    );
    expect(settings).toBe(1);
  });
});
