import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 2: customers, customer_identifiers, bot_customer_assignments.
 */

let t: TestDatabase;
let f: Fixtures;
let botA: string;
let botB: string;
let customerA: string;
let customerB: string;

const insertCustomer = (tx: Tx, organizationId: string, name: string, createdBy: string | null = null) =>
  one<{ id: string }>(tx, "insert into public.customers (organization_id, display_name, created_by) values ($1, $2, $3) returning id", [
    organizationId,
    name,
    createdBy
  ]);

const insertIdentifier = (
  tx: Tx,
  organizationId: string,
  customerId: string,
  type: string,
  normalized: string,
  botId: string | null = null
) =>
  one<{ id: string }>(
    tx,
    `insert into public.customer_identifiers (organization_id, customer_id, type, value, normalized_value, bot_id)
     values ($1, $2, $3, $4, $4, $5) returning id`,
    [organizationId, customerId, type, normalized, botId]
  );

const assign = (tx: Tx, organizationId: string, botId: string, customerId: string) =>
  tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [
    organizationId,
    botId,
    customerId
  ]);

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  botA = (await t.asUser(f.a.ownerId, (tx) => one<{ id: string }>(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix') returning id", [f.a.orgId]))).id;
  botB = (await t.asUser(f.b.ownerId, (tx) => one<{ id: string }>(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix') returning id", [f.b.orgId]))).id;
  customerA = (await t.asUser(f.a.ownerId, (tx) => insertCustomer(tx, f.a.orgId, "Juan", f.a.ownerId))).id;
  customerB = (await t.asUser(f.b.ownerId, (tx) => insertCustomer(tx, f.b.orgId, "Pedro", f.b.ownerId))).id;
});

afterAll(async () => {
  await t?.close();
});

describe("customers: RLS by role", () => {
  it("OWNER, ADMIN and OPERATOR can create and update customers", async () => {
    for (const userId of [f.a.adminId, f.a.operatorId]) {
      const created = await t.asUser(userId, (tx) => insertCustomer(tx, f.a.orgId, `by-${userId.slice(0, 4)}`, userId));
      const updated = await t.asUser(userId, async (tx) =>
        (await tx.query("update public.customers set status = 'SUSPENDED', notes = 'x' where id = $1", [created.id])).affectedRows
      );
      expect(updated).toBe(1);
    }
  });

  it("VIEWER reads but cannot create or update", async () => {
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.customers where id = $1", [customerA]))).toBe(1);
    await expect(t.asUser(f.a.viewerId, (tx) => insertCustomer(tx, f.a.orgId, "nope"))).rejects.toThrow(/row-level security/);
    const updated = await t.asUser(f.a.viewerId, async (tx) =>
      (await tx.query("update public.customers set display_name = 'x' where id = $1", [customerA])).affectedRows
    );
    expect(updated).toBe(0);
  });

  it("nobody deletes customers (no DELETE privilege): suspension keeps history", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("delete from public.customers where id = $1", [customerA]))).rejects.toThrow(
      /permission denied/
    );
  });

  it("created_by cannot impersonate another user; organization_id and created_by are not updatable", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => insertCustomer(tx, f.a.orgId, "spoof", f.a.adminId))).rejects.toThrow(/row-level security/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set organization_id = $1 where id = $2", [f.b.orgId, customerA]))
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set created_by = $1 where id = $2", [f.a.adminId, customerA]))
    ).rejects.toThrow(/permission denied/);
  });

  it("external_ref is unique per organization only (and optional)", async () => {
    await t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set external_ref = 'CRM-1' where id = $1", [customerA]));
    await t.asUser(f.b.ownerId, (tx) => tx.query("update public.customers set external_ref = 'CRM-1' where id = $1", [customerB]));
    const other = await t.asUser(f.a.ownerId, (tx) => insertCustomer(tx, f.a.orgId, "Otro"));
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set external_ref = 'CRM-1' where id = $1", [other.id]))
    ).rejects.toThrow(/customers_organization_external_ref_idx/);
  });
});

describe("customers: tenant isolation", () => {
  it("another organization cannot read, update or create customers of A", async () => {
    expect(await t.asUser(f.b.ownerId, (tx) => count(tx, "select 1 from public.customers where id = $1", [customerA]))).toBe(0);
    const updated = await t.asUser(f.b.ownerId, async (tx) =>
      (await tx.query("update public.customers set display_name = 'hacked' where id = $1", [customerA])).affectedRows
    );
    expect(updated).toBe(0);
    await expect(t.asUser(f.b.ownerId, (tx) => insertCustomer(tx, f.a.orgId, "intruder"))).rejects.toThrow(/row-level security/);
    expect(await t.asUser(f.outsiderId, (tx) => count(tx, "select 1 from public.customers"))).toBe(0);
  });

  it("anon has no access; the service role reads only the resolver columns (phase 3)", async () => {
    await expect(t.asAnon((tx) => tx.query("select 1 from public.customers"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select display_name from public.customers"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select notes from public.customers"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select value from public.customer_identifiers"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select created_by from public.bot_customer_assignments"))).rejects.toThrow(/permission denied/);
  });
});

describe("customer identifiers", () => {
  it("OPERATOR manages identifiers; VIEWER only reads", async () => {
    const id = await t.asUser(f.a.operatorId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "EMAIL", "juan@example.com"));
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.customer_identifiers where id = $1", [id.id]))).toBe(1);
    await expect(t.asUser(f.a.viewerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "EMAIL", "v@example.com"))).rejects.toThrow(
      /row-level security/
    );
    const deleted = await t.asUser(f.a.viewerId, async (tx) =>
      (await tx.query("delete from public.customer_identifiers where id = $1", [id.id])).affectedRows
    );
    expect(deleted).toBe(0);
  });

  it("cannot belong to a customer of another organization (composite FK), not even for the table owner", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerB, "EMAIL", "x@example.com"))).rejects.toThrow(
      /customer_identifiers_customer_fkey/
    );
    await expect(t.asAdmin((tx) => insertIdentifier(tx, f.a.orgId, customerB, "EMAIL", "x@example.com"))).rejects.toThrow(
      /customer_identifiers_customer_fkey/
    );
    await expect(t.asUser(f.b.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "EMAIL", "x@example.com"))).rejects.toThrow(
      /row-level security/
    );
  });

  it("a bot-scoped identifier can only use a bot of the same organization", async () => {
    await t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "USERNAME", "juan", botA));
    await expect(t.asAdmin((tx) => insertIdentifier(tx, f.a.orgId, customerA, "USERNAME", "juan2", botB))).rejects.toThrow(
      /customer_identifiers_bot_fkey/
    );
  });

  it("uniqueness: no exact duplicate for the same customer and scope (NULL scope included)", async () => {
    await t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "PHONE", "+51987654321"));
    await expect(t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "PHONE", "+51987654321"))).rejects.toThrow(
      /customer_identifiers_unique_scope/
    );
    // Same value with a different scope is a different relation.
    await t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "PHONE", "+51987654321", botA));
    await expect(
      t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "PHONE", "+51987654321", botA))
    ).rejects.toThrow(/customer_identifiers_unique_scope/);
  });

  it("uniqueness: the same value may identify several customers (shared accounts)", async () => {
    const other = await t.asUser(f.a.ownerId, (tx) => insertCustomer(tx, f.a.orgId, "Compartido"));
    await t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "EMAIL", "shared@example.com"));
    await t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, other.id, "EMAIL", "shared@example.com"));
    expect(
      await t.asUser(f.a.ownerId, (tx) =>
        count(tx, "select 1 from public.customer_identifiers where organization_id = $1 and type = 'EMAIL' and normalized_value = 'shared@example.com'", [
          f.a.orgId
        ])
      )
    ).toBe(2);
  });

  it.each([
    ["EMAIL", "Juan@Example.com"],
    ["EMAIL", "no-at-sign"],
    ["EMAIL", "a b@example.com"],
    ["PHONE", "+51 987 654 321"],
    ["PHONE", "12345"],
    ["USERNAME", " padded"],
    ["CUSTOM", "UpperCase"]
  ])("rejects a non-canonical %s normalized value (%s)", async (type, normalized) => {
    await expect(t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, type, normalized))).rejects.toThrow(
      /customer_identifiers_normalized_format/
    );
  });

  it("customer / organization / type of an identifier are not updatable", async () => {
    const id = await t.asUser(f.a.ownerId, (tx) => insertIdentifier(tx, f.a.orgId, customerA, "EXTERNAL_ID", "ext-9"));
    for (const column of ["customer_id", "organization_id"]) {
      await expect(
        t.asUser(f.a.ownerId, (tx) => tx.query(`update public.customer_identifiers set ${column} = $1 where id = $2`, [f.a.orgId, id.id]))
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customer_identifiers set type = 'CUSTOM' where id = $1", [id.id]))
    ).rejects.toThrow(/permission denied/);
  });
});

describe("bot <-> customer assignments", () => {
  it("bot and customer of the same organization: OPERATOR can assign, deactivate and unassign", async () => {
    await t.asUser(f.a.operatorId, (tx) => assign(tx, f.a.orgId, botA, customerA));
    const deactivated = await t.asUser(f.a.operatorId, async (tx) =>
      (await tx.query("update public.bot_customer_assignments set active = false where bot_id = $1 and customer_id = $2", [botA, customerA])).affectedRows
    );
    expect(deactivated).toBe(1);
    await expect(t.asUser(f.a.operatorId, (tx) => assign(tx, f.a.orgId, botA, customerA))).rejects.toThrow(/bot_customer_assignments_pkey/);
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.bot_customer_assignments where bot_id = $1", [botA]))).toBe(1);
  });

  it("VIEWER cannot assign", async () => {
    const other = await t.asUser(f.a.ownerId, (tx) => insertCustomer(tx, f.a.orgId, "Viewer target"));
    await expect(t.asUser(f.a.viewerId, (tx) => assign(tx, f.a.orgId, botA, other.id))).rejects.toThrow(/row-level security/);
  });

  it("bot A + customer B, or bot B + customer A, is rejected by the database for every role", async () => {
    for (const run of [(fn: (tx: Tx) => Promise<unknown>) => t.asAdmin(fn), (fn: (tx: Tx) => Promise<unknown>) => t.asUser(f.a.ownerId, fn)]) {
      await expect(run((tx) => assign(tx, f.a.orgId, botA, customerB))).rejects.toThrow(/bot_customer_assignments_customer_fkey|row-level security/);
      await expect(run((tx) => assign(tx, f.a.orgId, botB, customerA))).rejects.toThrow(/bot_customer_assignments_bot_fkey|row-level security/);
    }
    await expect(t.asAdmin((tx) => assign(tx, f.b.orgId, botB, customerA))).rejects.toThrow(/bot_customer_assignments_customer_fkey/);
    // Organization B cannot touch assignments of A.
    const touched = await t.asUser(f.b.ownerId, async (tx) =>
      (await tx.query("update public.bot_customer_assignments set active = true where bot_id = $1", [botA])).affectedRows
    );
    expect(touched).toBe(0);
  });

  it("only active is updatable", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.bot_customer_assignments set customer_id = $1 where bot_id = $2", [customerB, botA]))
    ).rejects.toThrow(/permission denied/);
  });
});

describe("statuses and deletion keep history", () => {
  it("suspending a customer or pausing a bot keeps identifiers and assignments", async () => {
    await t.asUser(f.a.ownerId, async (tx) => {
      await tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA]);
      await tx.query("update public.bots set status = 'PAUSED' where id = $1", [botA]);
    });
    await t.asUser(f.a.ownerId, async (tx) => {
      expect(await count(tx, "select 1 from public.customer_identifiers where customer_id = $1", [customerA])).toBeGreaterThan(0);
      expect(await count(tx, "select 1 from public.bot_customer_assignments where customer_id = $1", [customerA])).toBe(1);
      await tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA]);
      await tx.query("update public.bots set status = 'ACTIVE' where id = $1", [botA]);
    });
  });

  it("a bot that still has assignments or scoped identifiers cannot be deleted (nothing deleted or widened silently)", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("delete from public.bots where id = $1", [botA]))).rejects.toThrow(
      /customer_identifiers_bot_fkey|bot_customer_assignments_bot_fkey/
    );
  });

  it("deleting the organization removes its customers, identifiers and assignments (cascade)", async () => {
    const extra = await t.createUser("cascade@c.test");
    const org = await t.asUser(extra, (tx) => one<{ id: string }>(tx, "select public.create_organization('Cascade', 'cascade') as id"));
    await t.asUser(extra, async (tx) => {
      const bot = await one<{ id: string }>(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'B', 'b') returning id", [org.id]);
      const customer = await insertCustomer(tx, org.id, "C");
      await insertIdentifier(tx, org.id, customer.id, "EMAIL", "c@example.com", bot.id);
      await assign(tx, org.id, bot.id, customer.id);
    });
    await t.asAdmin((tx) => tx.query("delete from public.organizations where id = $1", [org.id]));
    await t.asAdmin(async (tx) => {
      expect(await count(tx, "select 1 from public.customers where organization_id = $1", [org.id])).toBe(0);
      expect(await count(tx, "select 1 from public.customer_identifiers where organization_id = $1", [org.id])).toBe(0);
      expect(await count(tx, "select 1 from public.bot_customer_assignments where organization_id = $1", [org.id])).toBe(0);
    });
  });
});
