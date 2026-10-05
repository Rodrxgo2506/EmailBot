import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 3: email_deliveries (who may see a processed email).
 */

let t: TestDatabase;
let f: Fixtures;
let botA: string;
let botA2: string;
let botB: string;
let customerA: string;
let customerA2: string;
let customerB: string;
let identifierA: string;
let identifierA2: string;
let emailA: string;
let emailA2: string;
let emailNoBot: string;
let emailB: string;
let sequence = 0;

const id = async (tx: Tx, sql: string, params: unknown[]) => (await one<{ id: string }>(tx, `${sql} returning id`, params)).id;

const insertEmail = (tx: Tx, organizationId: string, accountId: string, botId: string | null) =>
  id(
    tx,
    `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at, bot_id)
     values ($1, $2, $3, 'sender@example.com', now(), $4)`,
    [organizationId, accountId, `delivery-${++sequence}`, botId]
  );

interface Delivery {
  organizationId: string;
  emailId: string;
  customerId: string;
  botId: string;
  identifierId?: string | null;
  resolution?: string;
}

const deliver = (tx: Tx, d: Delivery) =>
  tx.query(
    `insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution, identifier_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [d.organizationId, d.emailId, d.customerId, d.botId, d.resolution ?? "AUTOMATIC", d.identifierId ?? null]
  );

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  await t.asAdmin(async (tx) => {
    botA = await id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.a.orgId]);
    botA2 = await id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Yape', 'yape')", [f.a.orgId]);
    botB = await id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.b.orgId]);
    customerA = await id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Juan')", [f.a.orgId]);
    customerA2 = await id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Ana')", [f.a.orgId]);
    customerB = await id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Pedro')", [f.b.orgId]);
    identifierA = await id(
      tx,
      `insert into public.customer_identifiers (organization_id, customer_id, type, value, normalized_value)
       values ($1, $2, 'EMAIL', 'juan@a.test', 'juan@a.test')`,
      [f.a.orgId, customerA]
    );
    identifierA2 = await id(
      tx,
      `insert into public.customer_identifiers (organization_id, customer_id, type, value, normalized_value)
       values ($1, $2, 'EMAIL', 'ana@a.test', 'ana@a.test')`,
      [f.a.orgId, customerA2]
    );
    for (const [organizationId, botId, customerId] of [
      [f.a.orgId, botA, customerA],
      [f.a.orgId, botA, customerA2],
      [f.a.orgId, botA2, customerA],
      [f.b.orgId, botB, customerB]
    ]) {
      await tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [
        organizationId,
        botId,
        customerId
      ]);
    }
    emailA = await insertEmail(tx, f.a.orgId, f.a.accountId, botA);
    emailA2 = await insertEmail(tx, f.a.orgId, f.a.accountId, botA2);
    emailNoBot = await insertEmail(tx, f.a.orgId, f.a.accountId, null);
    emailB = await insertEmail(tx, f.b.orgId, f.b.accountId, botB);
  });
  await t.asService(async (tx) => {
    await deliver(tx, { organizationId: f.a.orgId, emailId: emailA, customerId: customerA, botId: botA, identifierId: identifierA });
    await deliver(tx, { organizationId: f.b.orgId, emailId: emailB, customerId: customerB, botId: botB });
  });
});

afterAll(async () => {
  await t?.close();
});

describe("email_deliveries: worker writes", () => {
  it("the service role inserts automatic deliveries idempotently (ON CONFLICT DO NOTHING RETURNING)", async () => {
    const rows = await t.asService(async (tx) => {
      const sql = `insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution, identifier_id)
                   values ($1, $2, $3, $4, 'AUTOMATIC', $5)
                   on conflict (email_id, customer_id) do nothing returning customer_id`;
      const first = await tx.query(sql, [f.a.orgId, emailA, customerA2, botA, identifierA2]);
      const second = await tx.query(sql, [f.a.orgId, emailA, customerA2, botA, identifierA2]);
      return [first.rows.length, second.rows.length];
    });
    expect(rows).toEqual([1, 0]);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where email_id = $1", [emailA]))).toBe(2);
  });

  it("a duplicate delivery (same email, same customer) is rejected", async () => {
    await expect(
      t.asService((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA, customerId: customerA, botId: botA }))
    ).rejects.toThrow(/email_deliveries_email_customer_key/);
  });

  it("an automatic delivery has no human author", async () => {
    await expect(
      t.asAdmin((tx) =>
        tx.query(
          `insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution, created_by)
           values ($1, $2, $3, $4, 'AUTOMATIC', $5)`,
          [f.a.orgId, emailA2, customerA, botA2, f.a.ownerId]
        )
      )
    ).rejects.toThrow(/email_deliveries_automatic_without_author/);
  });
});

describe("email_deliveries: integrity enforced by the database (any role)", () => {
  /*
   * The eligibility trigger already rejects most of these rows; it is disabled
   * here (inside the rolled-back test transaction) to prove the constraints
   * hold on their own.
   */
  const constraintsOnly = (d: Delivery) =>
    t.asAdmin(async (tx) => {
      await tx.query("alter table public.email_deliveries disable trigger email_deliveries_validate_eligibility");
      await deliver(tx, d);
    });

  it("an email of organization A cannot be delivered to a customer of organization B", async () => {
    await expect(constraintsOnly({ organizationId: f.a.orgId, emailId: emailA2, customerId: customerB, botId: botA2 })).rejects.toThrow(
      /email_deliveries_customer_fkey/
    );
    await expect(constraintsOnly({ organizationId: f.b.orgId, emailId: emailA2, customerId: customerB, botId: botB })).rejects.toThrow(
      /email_deliveries_email_fkey/
    );
    await expect(
      t.asAdmin((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerB, botId: botA2 }))
    ).rejects.toThrow(/Customer is not active/);
  });

  it("the delivery bot must be exactly the email bot (composite FK)", async () => {
    // customerA is assigned to botA2, but emailA2 belongs to botA2 and the delivery claims botA.
    await expect(constraintsOnly({ organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botA })).rejects.toThrow(
      /email_deliveries_email_fkey/
    );
    await expect(
      t.asAdmin((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA2, botId: botA }))
    ).rejects.toThrow(/email_deliveries_email_fkey/);
    // A bot of another organization is never valid.
    await expect(constraintsOnly({ organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botB })).rejects.toThrow(
      /email_deliveries_email_fkey|email_deliveries_bot_fkey/
    );
  });

  it("an email without a bot (general rule, ambiguous tie, V1) can never be delivered", async () => {
    for (const botId of [botA, botA2]) {
      await expect(constraintsOnly({ organizationId: f.a.orgId, emailId: emailNoBot, customerId: customerA, botId })).rejects.toThrow(
        /email_deliveries_email_fkey/
      );
    }
  });

  it("the matched identifier must belong to the delivered customer", async () => {
    await expect(
      t.asAdmin((tx) =>
        deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botA2, identifierId: identifierA2 })
      )
    ).rejects.toThrow(/email_deliveries_identifier_fkey/);
  });
});

describe("email_deliveries: eligibility of new deliveries", () => {
  it("a suspended customer gets no new delivery; existing deliveries stay", async () => {
    await t.asAdmin((tx) => tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA]));
    try {
      await expect(
        t.asService((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botA2 }))
      ).rejects.toThrow(/Customer is not active/);
      expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where customer_id = $1", [customerA]))).toBe(1);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA]));
    }
  });

  it("a paused bot gets no new delivery; existing deliveries stay", async () => {
    await t.asAdmin((tx) => tx.query("update public.bots set status = 'PAUSED' where id = $1", [botA2]));
    try {
      await expect(
        t.asService((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botA2 }))
      ).rejects.toThrow(/Bot is not active/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bots set status = 'ACTIVE' where id = $1", [botA2]));
    }
    await t.asAdmin((tx) => tx.query("update public.bots set status = 'PAUSED' where id = $1", [botA]));
    try {
      expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where bot_id = $1", [botA]))).toBe(2);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bots set status = 'ACTIVE' where id = $1", [botA]));
    }
  });

  it("the customer needs an active assignment to the bot", async () => {
    // customerA2 is not assigned to botA2.
    await expect(
      t.asService((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA2, botId: botA2 }))
    ).rejects.toThrow(/Customer is not assigned to the bot/);
    await t.asAdmin((tx) =>
      tx.query("update public.bot_customer_assignments set active = false where bot_id = $1 and customer_id = $2", [botA2, customerA])
    );
    try {
      await expect(
        t.asService((tx) => deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botA2 }))
      ).rejects.toThrow(/Customer is not assigned to the bot/);
    } finally {
      await t.asAdmin((tx) =>
        tx.query("update public.bot_customer_assignments set active = true where bot_id = $1 and customer_id = $2", [botA2, customerA])
      );
    }
  });

  it("the eligibility trigger runs as the invoker and nobody can call it directly", async () => {
    const fn = await t.asAdmin((tx) =>
      one<{ prosecdef: boolean; service: boolean; authenticated: boolean; anon: boolean }>(
        tx,
        `select p.prosecdef,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private' and p.proname = 'validate_email_delivery_eligibility'`
      )
    );
    expect(fn).toEqual({ prosecdef: false, service: false, authenticated: false, anon: false });
  });
});

describe("email_deliveries: RLS", () => {
  it.each(["ownerId", "adminId", "operatorId", "viewerId"] as const)("%s of A reads only the deliveries of A", async (who) => {
    const visible = await t.asUser(f.a[who], (tx) =>
      tx.query<{ organization_id: string }>("select organization_id from public.email_deliveries")
    );
    expect(visible.rows.length).toBe(2);
    expect(visible.rows.every((row) => row.organization_id === f.a.orgId)).toBe(true);
  });

  it("organization B and outsiders never see the deliveries of A", async () => {
    expect(await t.asUser(f.b.ownerId, (tx) => count(tx, "select 1 from public.email_deliveries where organization_id = $1", [f.a.orgId]))).toBe(0);
    expect(await t.asUser(f.b.ownerId, (tx) => count(tx, "select 1 from public.email_deliveries"))).toBe(1);
    expect(await t.asUser(f.outsiderId, (tx) => count(tx, "select 1 from public.email_deliveries"))).toBe(0);
    await expect(t.asAnon((tx) => tx.query("select 1 from public.email_deliveries"))).rejects.toThrow(/permission denied/);
  });

  it("members cannot create, change or delete deliveries in phase 3", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        deliver(tx, { organizationId: f.a.orgId, emailId: emailA2, customerId: customerA, botId: botA2, resolution: "MANUAL" })
      )
    ).rejects.toThrow(/permission denied/);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.email_deliveries set resolution = 'MANUAL'"))).rejects.toThrow(
      /permission denied/
    );
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("delete from public.email_deliveries"))).rejects.toThrow(/permission denied/);
  });
});

describe("email_deliveries: lifecycle", () => {
  it("deleting the matched identifier keeps the delivery and only clears identifier_id", async () => {
    await t.asAdmin((tx) => tx.query("delete from public.customer_identifiers where id = $1", [identifierA]));
    const row = await t.asAdmin((tx) =>
      one<{ identifier_id: string | null; customer_id: string }>(
        tx,
        "select identifier_id, customer_id from public.email_deliveries where email_id = $1 and customer_id = $2",
        [emailA, customerA]
      )
    );
    expect(row).toEqual({ identifier_id: null, customer_id: customerA });
  });

  it("a bot with deliveries cannot be deleted", async () => {
    await expect(t.asAdmin((tx) => tx.query("delete from public.bots where id = $1", [botA]))).rejects.toThrow(/foreign key/);
  });

  it("deleting an email removes its deliveries", async () => {
    await t.asAdmin((tx) => tx.query("delete from public.emails where id = $1", [emailB]));
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where email_id = $1", [emailB]))).toBe(0);
  });
});
