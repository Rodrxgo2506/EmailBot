import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Customer deletion (soft delete): public.delete_customer, the deleted_at /
 * deleted_by columns and the guards that keep a deleted customer final and
 * its history intact.
 */

let t: TestDatabase;
let f: Fixtures;
let sequence = 0;
const hex = (label: string) => createHash("sha256").update(`${label}-${++sequence}`).digest("hex");

let botA: string;
let botB: string;
let customerB: string;

const id = async (tx: Tx, sql: string, params: unknown[]) => (await one<{ id: string }>(tx, `${sql} returning id`, params)).id;

/** A customer of A with an identifier, an assignment to botA, a delivered email and an open portal session. */
async function customerWithHistory(name: string) {
  const customerId = await t.asAdmin(async (tx) => {
    const customer = await id(tx, "insert into public.customers (organization_id, display_name, external_ref) values ($1, $2, $3)", [
      f.a.orgId,
      name,
      `ref-${name}`
    ]);
    await tx.query(
      "insert into public.customer_identifiers (organization_id, customer_id, type, value, normalized_value) values ($1, $2, 'EMAIL', $3, $3)",
      [f.a.orgId, customer, `${name.toLowerCase().replace(/\s+/g, "-")}@cliente.test`]
    );
    await tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [f.a.orgId, botA, customer]);
    return customer;
  });
  const emailId = await t.asAdmin((tx) =>
    id(
      tx,
      `insert into public.emails (organization_id, email_account_id, provider_message_id, bot_id, subject, sender_email, received_at)
       values ($1, $2, $3, $4, 'Tu código', 'info@netflix.example', now())`,
      [f.a.orgId, f.a.accountId, `deletion-${++sequence}`, botA]
    )
  );
  const deliveryId = await t.asAdmin((tx) =>
    id(tx, "insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution) values ($1, $2, $3, $4, 'AUTOMATIC')", [
      f.a.orgId,
      emailId,
      customerId,
      botA
    ])
  );
  const secret = hex("secret");
  const token = hex("token");
  await t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customerId, secret]));
  const login = await t.asService((tx) => one<{ outcome: string }>(tx, "select outcome from portal.create_session($1, $2, null, null)", [secret, token]));
  expect(login.outcome).toBe("OK");
  return { customerId, emailId, deliveryId, secret, token };
}

const deleteAs = (userId: string, customerId: string) =>
  t.asUser(userId, (tx) =>
    one<{ customer_id: string; organization_id: string; deleted_at: string; revoked_credential_id: string | null; revoked_sessions: number }>(
      tx,
      "select * from public.delete_customer($1)",
      [customerId]
    )
  );

const customerRow = (customerId: string) =>
  t.asAdmin((tx) =>
    one<{ status: string; deleted_at: string | null; deleted_by: string | null; display_name: string }>(
      tx,
      "select status, deleted_at, deleted_by, display_name from public.customers where id = $1",
      [customerId]
    )
  );

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  botA = await t.asAdmin((tx) => id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.a.orgId]));
  botB = await t.asAdmin((tx) => id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.b.orgId]));
  customerB = await t.asAdmin((tx) => id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Pedro')", [f.b.orgId]));
});

afterAll(async () => {
  await t?.close();
});

describe("delete_customer: who may delete", () => {
  it("only authenticated may execute it (anon and the service role cannot)", async () => {
    const grants = await t.asAdmin((tx) =>
      tx.query<{ grantee: string }>(
        `select grantee from information_schema.routine_privileges
         where routine_schema = 'public' and routine_name = 'delete_customer' and privilege_type = 'EXECUTE'
         order by grantee`
      )
    );
    expect(grants.rows.map((row) => row.grantee).filter((grantee) => ["anon", "authenticated", "service_role", "PUBLIC"].includes(grantee))).toEqual([
      "authenticated"
    ]);
  });

  it("OPERATOR, VIEWER, an outsider and a member of another organization get the same 'not found'; nothing changes", async () => {
    const { customerId } = await customerWithHistory("Intocable");
    for (const userId of [f.a.operatorId, f.a.viewerId, f.outsiderId, f.b.ownerId]) {
      await expect(deleteAs(userId, customerId)).rejects.toThrow(/Customer not found/);
    }
    await expect(deleteAs(f.a.ownerId, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/Customer not found/);
    expect(await customerRow(customerId)).toMatchObject({ status: "ACTIVE", deleted_at: null, deleted_by: null });
  });

  it("A cannot delete a customer of B (cross-tenant), B's customer is untouched", async () => {
    await expect(deleteAs(f.a.ownerId, customerB)).rejects.toThrow(/Customer not found/);
    expect(await customerRow(customerB)).toMatchObject({ status: "ACTIVE", deleted_at: null });
  });

  it("members cannot set or clear deleted_at / deleted_by directly (no column grant)", async () => {
    const { customerId } = await customerWithHistory("Directo");
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set deleted_at = now() where id = $1", [customerId]))
    ).rejects.toThrow(/permission denied/);
    expect(await customerRow(customerId)).toMatchObject({ deleted_at: null });
  });

  it("an inactive organization cannot delete", async () => {
    const { customerId } = await customerWithHistory("Pausa");
    await t.asAdmin((tx) => tx.query("update public.organizations set status = 'SUSPENDED' where id = $1", [f.a.orgId]));
    try {
      await expect(deleteAs(f.a.ownerId, customerId)).rejects.toThrow(/Organization is not active/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.organizations set status = 'ACTIVE' where id = $1", [f.a.orgId]));
    }
    expect(await customerRow(customerId)).toMatchObject({ deleted_at: null });
  });
});

describe("delete_customer: soft delete keeps the history", () => {
  it("ADMIN deletes: suspended + marked with who and when, Access ID and open sessions revoked", async () => {
    const { customerId } = await customerWithHistory("Borrable");
    const result = await deleteAs(f.a.adminId, customerId);

    expect(result).toMatchObject({ customer_id: customerId, organization_id: f.a.orgId, revoked_sessions: 1 });
    expect(result.revoked_credential_id).not.toBeNull();
    const row = await customerRow(customerId);
    expect(row).toMatchObject({ status: "SUSPENDED", deleted_by: f.a.adminId, display_name: "Borrable" });
    expect(row.deleted_at).not.toBeNull();

    const credentials = await t.asAdmin((tx) =>
      tx.query<{ status: string; revoked_by: string }>("select status, revoked_by from public.customer_access_credentials where customer_id = $1", [customerId])
    );
    expect(credentials.rows).toEqual([{ status: "REVOKED", revoked_by: f.a.adminId }]);
    expect(
      await t.asAdmin((tx) => count(tx, "select 1 from public.customer_sessions where customer_id = $1 and revoked_at is null", [customerId]))
    ).toBe(0);
  });

  it("emails, deliveries, identifiers, assignments, credentials, sessions and audit logs are all kept", async () => {
    const { customerId, emailId, deliveryId } = await customerWithHistory("Historial");
    await t.asAdmin((tx) =>
      tx.query(
        "insert into public.audit_logs (organization_id, actor_type, action, entity_type, entity_id, metadata) values ($1, 'SYSTEM', 'LOGIN', 'customer', $2, '{}')",
        [f.a.orgId, customerId]
      )
    );
    const before = await t.asAdmin(async (tx) => ({
      emails: await count(tx, "select 1 from public.emails where id = $1", [emailId]),
      deliveries: await count(tx, "select 1 from public.email_deliveries where id = $1 and customer_id = $2", [deliveryId, customerId]),
      identifiers: await count(tx, "select 1 from public.customer_identifiers where customer_id = $1", [customerId]),
      assignments: await count(tx, "select 1 from public.bot_customer_assignments where customer_id = $1 and active", [customerId]),
      credentials: await count(tx, "select 1 from public.customer_access_credentials where customer_id = $1", [customerId]),
      sessions: await count(tx, "select 1 from public.customer_sessions where customer_id = $1", [customerId]),
      audit: await count(tx, "select 1 from public.audit_logs where entity_id = $1", [customerId])
    }));

    await deleteAs(f.a.ownerId, customerId);

    const after = await t.asAdmin(async (tx) => ({
      emails: await count(tx, "select 1 from public.emails where id = $1", [emailId]),
      deliveries: await count(tx, "select 1 from public.email_deliveries where id = $1 and customer_id = $2", [deliveryId, customerId]),
      identifiers: await count(tx, "select 1 from public.customer_identifiers where customer_id = $1", [customerId]),
      assignments: await count(tx, "select 1 from public.bot_customer_assignments where customer_id = $1 and active", [customerId]),
      credentials: await count(tx, "select 1 from public.customer_access_credentials where customer_id = $1", [customerId]),
      sessions: await count(tx, "select 1 from public.customer_sessions where customer_id = $1", [customerId]),
      audit: await count(tx, "select 1 from public.audit_logs where entity_id = $1", [customerId])
    }));
    expect(before).toEqual({ emails: 1, deliveries: 1, identifiers: 1, assignments: 1, credentials: 1, sessions: 1, audit: 1 });
    expect(after).toEqual(before);
    // Members still read the deliveries of the email (history in the panel).
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.email_deliveries where id = $1", [deliveryId]))).toBe(1);
  });

  it("deleting twice is refused like a missing customer; the first deletion's author and time stay", async () => {
    const { customerId } = await customerWithHistory("Dos veces");
    const first = await deleteAs(f.a.adminId, customerId);
    await expect(deleteAs(f.a.ownerId, customerId)).rejects.toThrow(/Customer not found/);
    const row = await customerRow(customerId);
    expect(row.deleted_by).toBe(f.a.adminId);
    expect(new Date(row.deleted_at as string).toISOString()).toBe(new Date(first.deleted_at).toISOString());
  });
});

describe("a deleted customer is final and receives nothing new", () => {
  it("no new automatic or manual delivery", async () => {
    const { customerId } = await customerWithHistory("Sin entregas");
    await deleteAs(f.a.ownerId, customerId);
    const emailId = await t.asAdmin((tx) =>
      id(
        tx,
        `insert into public.emails (organization_id, email_account_id, provider_message_id, bot_id, subject, sender_email, received_at)
         values ($1, $2, $3, $4, 'Nuevo', 'info@netflix.example', now())`,
        [f.a.orgId, f.a.accountId, `deletion-${++sequence}`, botA]
      )
    );

    await expect(
      t.asAdmin((tx) =>
        tx.query("insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution) values ($1, $2, $3, $4, 'AUTOMATIC')", [
          f.a.orgId,
          emailId,
          customerId,
          botA
        ])
      )
    ).rejects.toThrow(/Customer is not active/);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.add_manual_delivery($1, $2)", [emailId, customerId]))).rejects.toThrow(
      /Customer is not active/
    );
  });

  it("cannot be reactivated, renamed or edited, by members or the table owner", async () => {
    const { customerId } = await customerWithHistory("Final");
    await deleteAs(f.a.ownerId, customerId);

    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerId]))
    ).rejects.toThrow(/Customer is deleted|customers_deleted_is_suspended/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set display_name = 'Otro' where id = $1", [customerId]))
    ).rejects.toThrow(/Customer is deleted/);
    await expect(
      t.asAdmin((tx) => tx.query("update public.customers set deleted_at = null, deleted_by = null where id = $1", [customerId]))
    ).rejects.toThrow(/Customer is deleted/);
    expect(await customerRow(customerId)).toMatchObject({ status: "SUSPENDED", display_name: "Final" });
  });

  it("a deleted customer can never be ACTIVE (check constraint, for every role)", async () => {
    await expect(
      t.asAdmin((tx) =>
        tx.query("insert into public.customers (organization_id, display_name, status, deleted_at) values ($1, 'Imposible', 'ACTIVE', now())", [f.a.orgId])
      )
    ).rejects.toThrow(/customers_deleted_is_suspended/);
  });

  it("no new or changed bot assignment, identifier or Access ID", async () => {
    const { customerId } = await customerWithHistory("Congelado");
    const otherBot = await t.asAdmin((tx) => id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Yape', $2)", [f.a.orgId, `yape-${++sequence}`]));
    await deleteAs(f.a.ownerId, customerId);

    await expect(
      t.asUser(f.a.operatorId, (tx) =>
        tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [f.a.orgId, otherBot, customerId])
      )
    ).rejects.toThrow(/Customer is deleted/);
    await expect(
      t.asUser(f.a.operatorId, (tx) => tx.query("update public.bot_customer_assignments set active = false where customer_id = $1", [customerId]))
    ).rejects.toThrow(/Customer is deleted/);
    await expect(
      t.asUser(f.a.operatorId, (tx) =>
        tx.query(
          "insert into public.customer_identifiers (organization_id, customer_id, type, value, normalized_value) values ($1, $2, 'EMAIL', 'x@y.test', 'x@y.test')",
          [f.a.orgId, customerId]
        )
      )
    ).rejects.toThrow(/Customer is deleted/);
    await expect(
      t.asUser(f.a.operatorId, (tx) => tx.query("update public.customer_identifiers set active = false where customer_id = $1", [customerId]))
    ).rejects.toThrow(/Customer is deleted/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customerId, hex("again")]))
    ).rejects.toThrow(/Customer is deleted/);
  });

  it("the old Access ID and session no longer work in the portal", async () => {
    const { customerId, secret, token } = await customerWithHistory("Portal");
    await deleteAs(f.a.ownerId, customerId);

    const login = await t.asService((tx) => one<{ outcome: string }>(tx, "select outcome from portal.create_session($1, $2, null, null)", [secret, hex("token")]));
    expect(login.outcome).not.toBe("OK");
    const inbox = await t.asService((tx) =>
      tx.query("select * from portal.list_inbox($1, 25, null, null, null, null, null, null, null, null, null)", [token])
    );
    expect(inbox.rows).toHaveLength(0);
  });

  it("is not counted in the CUSTOMERS plan usage", async () => {
    const usage = () =>
      t.asUser(f.a.ownerId, (tx) =>
        one<{ used: string }>(tx, "select used from public.organization_usage($1, array['CUSTOMERS']) where key = 'CUSTOMERS'", [f.a.orgId])
      );
    const { customerId } = await customerWithHistory("Cupo");
    const before = Number((await usage()).used);
    await deleteAs(f.a.ownerId, customerId);
    expect(Number((await usage()).used)).toBe(before - 1);
  });
});

describe("external_ref and organization deletion", () => {
  it("a deleted customer's external_ref can be reused; two live customers still cannot share one", async () => {
    const { customerId } = await customerWithHistory("Referencia");
    await deleteAs(f.a.ownerId, customerId);
    await t.asUser(f.a.ownerId, (tx) =>
      tx.query("insert into public.customers (organization_id, display_name, external_ref) values ($1, 'Nuevo', 'ref-Referencia')", [f.a.orgId])
    );
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("insert into public.customers (organization_id, display_name, external_ref) values ($1, 'Copia', 'ref-Referencia')", [f.a.orgId])
      )
    ).rejects.toThrow(/duplicate key/);
  });

  it("deleting a profile clears deleted_by (ON DELETE SET NULL) without being blocked by the guard", async () => {
    const remover = await t.createUser(`remover-${++sequence}@a.test`);
    await t.asUser(f.a.ownerId, (tx) => tx.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')", [f.a.orgId, remover]));
    const { customerId } = await customerWithHistory("Autor");
    await deleteAs(remover, customerId);
    await t.asAdmin(async (tx) => {
      await tx.query("delete from public.organization_members where user_id = $1", [remover]);
      await tx.query("delete from auth.users where id = $1", [remover]);
    });
    const row = await customerRow(customerId);
    expect(row).toMatchObject({ deleted_by: null, status: "SUSPENDED" });
    expect(row.deleted_at).not.toBeNull();
  });

  it("B is unaffected by everything above", async () => {
    expect(await customerRow(customerB)).toMatchObject({ status: "ACTIVE", deleted_at: null });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.bots where id = $1", [botB]))).toBe(1);
  });
});
