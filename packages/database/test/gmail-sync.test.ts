import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 5.6: Gmail watch state, the history cursor guarantees
 * the worker relies on (compare-and-set) and portal.sync_scope.
 */

let t: TestDatabase;
let f: Fixtures;
let customerA: string;
let customerA2: string;
let customerB: string;
let botA: string;
let disconnectedA: string;
let sequence = 0;
const hex = (label: string) => createHash("sha256").update(`${label}-${++sequence}`).digest("hex");

async function sessionFor(ownerId: string, customerId: string): Promise<string> {
  const secret = hex("secret");
  const token = hex("token");
  await t.asUser(ownerId, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customerId, secret]));
  await t.asService((tx) => tx.query("select * from portal.create_session($1, $2, null, null)", [secret, token]));
  return token;
}

const scope = (token: string) =>
  t.asService(async (tx) => (await tx.query<{ email_account_id: string; organization_id: string }>("select * from portal.sync_scope($1)", [token])).rows);

/** The worker's cursor update: only from the cursor it started with (PostgREST .eq on sync_cursor). */
const advance = (accountId: string, from: string | null, to: string) =>
  t.asService(async (tx) =>
    (
      await tx.query(
        `update public.email_accounts set sync_cursor = $3, last_synced_at = now()
         where id = $1 and sync_cursor is not distinct from $2`,
        [accountId, from, to]
      )
    ).affectedRows
  );

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  await t.asAdmin(async (tx) => {
    const id = async (sql: string, params: unknown[]) => (await one<{ id: string }>(tx, `${sql} returning id`, params)).id;
    botA = await id("insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.a.orgId]);
    const botB = await id("insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.b.orgId]);
    customerA = await id("insert into public.customers (organization_id, display_name) values ($1, 'Juan')", [f.a.orgId]);
    customerA2 = await id("insert into public.customers (organization_id, display_name) values ($1, 'Sin bot')", [f.a.orgId]);
    customerB = await id("insert into public.customers (organization_id, display_name) values ($1, 'Pedro')", [f.b.orgId]);
    await tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3), ($4, $5, $6)", [
      f.a.orgId,
      botA,
      customerA,
      f.b.orgId,
      botB,
      customerB
    ]);
    disconnectedA = await id(
      "insert into public.email_accounts (organization_id, provider, email_address, status) values ($1, 'GMAIL', 'old@a.test', 'DISCONNECTED')",
      [f.a.orgId]
    );
    await tx.query("update public.email_accounts set sync_cursor = '100' where id = $1", [f.a.accountId]);
  });
});

afterAll(async () => {
  await t?.close();
});

describe("Gmail watch state", () => {
  it("the worker (service role) reads and writes the watch state; members cannot see or change it", async () => {
    await t.asService((tx) =>
      tx.query(
        "update public.email_accounts set watch_expires_at = now() + interval '7 days', watch_renewed_at = now(), watch_error_code = null where id = $1",
        [f.a.accountId]
      )
    );
    const row = await t.asService((tx) =>
      one<{ renew: boolean }>(tx, "select watch_expires_at > now() + interval '6 days' as renew from public.email_accounts where id = $1", [f.a.accountId])
    );
    expect(row.renew).toBe(true);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select watch_expires_at from public.email_accounts"))).rejects.toThrow(/permission denied/);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.email_accounts set watch_expires_at = null"))).rejects.toThrow(/permission denied/);
  });

  it("watch errors are categories with a bounded length", async () => {
    await expect(
      t.asService((tx) => tx.query("update public.email_accounts set watch_error_code = $1 where id = $2", ["x".repeat(101), f.a.accountId]))
    ).rejects.toThrow(/watch_error_code_length/);
  });

  it("renewal scan: active Gmail accounts with a missing or expiring watch, through the partial index", async () => {
    await t.asService((tx) => tx.query("update public.email_accounts set watch_expires_at = now() + interval '2 hours' where id = $1", [f.b.accountId]));
    const due = await t.asService(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `select id from public.email_accounts
           where provider = 'GMAIL' and status = 'ACTIVE' and (watch_expires_at is null or watch_expires_at < now() + interval '1 day')
           order by watch_expires_at nulls first limit 100`
        )
      ).rows.map((row) => row.id)
    );
    expect(due).toContain(f.b.accountId);
    expect(due).not.toContain(f.a.accountId); // renewed above, valid for 7 days
    expect(due).not.toContain(disconnectedA);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from pg_indexes where indexname = 'email_accounts_watch_renewal_idx'"))).toBe(1);
  });
});

describe("history cursor (email_accounts.sync_cursor)", () => {
  it("advances only from the cursor the sync started with (compare-and-set)", async () => {
    expect(await advance(f.a.accountId, "100", "120")).toBe(1);
    expect(await advance(f.a.accountId, "100", "130")).toBe(0); // stale: never overwrites a newer cursor
    const row = await t.asService((tx) => one<{ sync_cursor: string }>(tx, "select sync_cursor from public.email_accounts where id = $1", [f.a.accountId]));
    expect(row.sync_cursor).toBe("120");
  });

  it("two concurrent syncs from the same cursor: exactly one wins, the cursor never goes back", async () => {
    const results = [await advance(f.a.accountId, "120", "140"), await advance(f.a.accountId, "120", "135")];
    expect(results.sort()).toEqual([0, 1]);
    const row = await t.asService((tx) => one<{ sync_cursor: string }>(tx, "select sync_cursor from public.email_accounts where id = $1", [f.a.accountId]));
    expect(row.sync_cursor).toBe("140");
  });

  it("a failed sync leaves the cursor untouched (nothing is written until processing succeeded)", async () => {
    const before = await t.asService((tx) => one<{ sync_cursor: string }>(tx, "select sync_cursor from public.email_accounts where id = $1", [f.a.accountId]));
    // A failing run never reaches the update: simulated by not calling advance(); a retry starts from the same cursor.
    expect(await advance(f.a.accountId, before.sync_cursor, "150")).toBe(1);
  });

  it("cursors are per account: updating account A never touches account B", async () => {
    const beforeB = await t.asService((tx) => one<{ sync_cursor: string | null }>(tx, "select sync_cursor from public.email_accounts where id = $1", [f.b.accountId]));
    await advance(f.a.accountId, "150", "160");
    const afterB = await t.asService((tx) => one<{ sync_cursor: string | null }>(tx, "select sync_cursor from public.email_accounts where id = $1", [f.b.accountId]));
    expect(afterB).toEqual(beforeB);
  });

  it("a retried or duplicated message never duplicates the email (unique account + provider message)", async () => {
    const insert = () =>
      t.asService(async (tx) =>
        (
          await tx.query(
            `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at)
             values ($1, $2, 'gmail-msg-1', 's@example.com', now())
             on conflict (email_account_id, provider_message_id) do nothing returning id`,
            [f.a.orgId, f.a.accountId]
          )
        ).rows.length
      );
    expect([await insert(), await insert(), await insert()]).toEqual([1, 0, 0]);
  });
});

describe("portal.sync_scope (manual sync)", () => {
  it("customer A gets only the ACTIVE accounts of its own organization", async () => {
    const token = await sessionFor(f.a.ownerId, customerA);
    const rows = await scope(token);
    expect(rows.map((row) => row.email_account_id)).toEqual([f.a.accountId]);
    expect(rows.every((row) => row.organization_id === f.a.orgId)).toBe(true);
  });

  it("customer B never gets accounts of A", async () => {
    const rows = await scope(await sessionFor(f.b.ownerId, customerB));
    expect(rows.map((row) => row.email_account_id)).toEqual([f.b.accountId]);
  });

  it("no active assignment -> no sync scope", async () => {
    expect(await scope(await sessionFor(f.a.ownerId, customerA2))).toEqual([]);
    const token = await sessionFor(f.a.ownerId, customerA);
    await t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = false where customer_id = $1", [customerA]));
    try {
      expect(await scope(token)).toEqual([]);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = true where customer_id = $1", [customerA]));
    }
  });

  it("suspended customer, suspended organization or unknown session -> nothing", async () => {
    const token = await sessionFor(f.a.ownerId, customerA);
    await t.asAdmin((tx) => tx.query("update public.organizations set status = 'SUSPENDED' where id = $1", [f.a.orgId]));
    try {
      expect(await scope(token)).toEqual([]);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.organizations set status = 'ACTIVE' where id = $1", [f.a.orgId]));
    }
    await t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA]));
    try {
      expect(await scope(token)).toEqual([]);
    } finally {
      await t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA]));
    }
    expect(await scope(hex("unknown"))).toEqual([]);
  });

  it("only the service role executes it", async () => {
    const token = await sessionFor(f.a.ownerId, customerA);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select * from portal.sync_scope($1)", [token]))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select * from portal.sync_scope($1)", [token]))).rejects.toThrow(/permission denied/);
  });
});
