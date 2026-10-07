import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, MIGRATIONS_DIR, type TestDatabase } from "../src/harness.js";
import { activateSubscription, count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Commercial V1.2 (20261006140000_subscription_enforcement.sql):
 *   - one definition of commercial access (public.organization_access):
 *     ACTIVE and current_period_start <= now() < current_period_end;
 *   - scheduled expiration (public.expire_due_subscriptions), idempotent;
 *   - the customer portal requires commercial access (and PORTAL for subscriptions);
 *   - an early renewal never leaves a gap without access.
 */

let t: TestDatabase;
let f: Fixtures;
let platformAdmin: string;
let sequence = 0;

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  platformAdmin = await t.createUser("root@emailbot.test");
  await t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [platformAdmin]));
});
afterAll(async () => t?.close());

async function newOrganization(): Promise<string> {
  sequence += 1;
  return (
    await t.asService((tx) =>
      one<{ id: string }>(tx, "select admin.create_organization($1, $2, $3, null, $4, null) as id", [platformAdmin, `Acceso ${sequence}`, `acceso-${sequence}`, f.a.ownerId])
    )
  ).id;
}

/** Sets the period of a subscription directly (table owner): simulates the passage of time. */
const setPeriod = (subscriptionId: string, start: string, end: string) =>
  t.asAdmin((tx) =>
    tx.query("update public.subscriptions set started_at = least(started_at, $2::timestamptz), current_period_start = $2, current_period_end = $3 where id = $1", [
      subscriptionId,
      start,
      end
    ])
  );

const accessOf = async (orgIds: string[]) =>
  t.asService(async (tx) =>
    Object.fromEntries(
      (
        await tx.query<{ organization_id: string; access: string; subscription_status: string | null; effective_plan: string | null }>(
          "select organization_id, access, subscription_status, effective_plan from public.organization_access($1)",
          [orgIds]
        )
      ).rows.map((row) => [row.organization_id, row])
    )
  );
const access = async (orgId: string) => (await accessOf([orgId]))[orgId];

const status = (subscriptionId: string) =>
  t.asAdmin((tx) => one<{ status: string }>(tx, "select status from public.subscriptions where id = $1", [subscriptionId])).then((row) => row.status);
const cachedPlan = (orgId: string) =>
  t.asAdmin((tx) => one<{ plan: string | null }>(tx, "select plan from public.organizations where id = $1", [orgId])).then((row) => row.plan);
const expireAuditCount = (orgId: string) =>
  t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs where organization_id = $1 and action = 'subscription.expired'", [orgId]));
const sweep = () => t.asService((tx) => one<{ n: number }>(tx, "select public.expire_due_subscriptions() as n")).then((row) => row.n);

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("commercial access: ACTIVE and current_period_start <= now() < current_period_end", () => {
  it("ACTIVE inside its period -> SUBSCRIPTION with the plan", async () => {
    expect(await access(f.a.orgId)).toMatchObject({ access: "SUBSCRIPTION", subscription_status: "ACTIVE", effective_plan: "PRO" });
  });

  it("no subscription (new organization) -> NONE", async () => {
    expect(await access(await newOrganization())).toMatchObject({ access: "NONE", subscription_status: null, effective_plan: null });
  });

  it.each(["SUSPEND", "CANCEL"] as const)("%s -> NONE", async (action) => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    await t.asService((tx) => tx.query("select * from admin.update_subscription_status($1, $2, $3, null, null)", [platformAdmin, subscriptionId, action]));
    expect((await access(orgId))?.access).toBe("NONE");
  });

  it("PAST_DUE -> NONE (set by the payment provider later)", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    await t.asAdmin((tx) => tx.query("select * from private.change_subscription_status($1, 'PAST_DUE', null, 'payment_failed', null)", [subscriptionId]));
    expect(await access(orgId)).toMatchObject({ access: "NONE", subscription_status: "PAST_DUE" });
  });

  it("ACTIVE whose period already ended -> NONE even before the sweep; EXPIRED -> NONE", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    await setPeriod(subscriptionId, iso(-40 * DAY), iso(-1000));
    expect(await access(orgId)).toMatchObject({ access: "NONE", subscription_status: "ACTIVE" });
    await sweep();
    expect(await access(orgId)).toMatchObject({ access: "NONE", subscription_status: "EXPIRED" });
  });

  it("ACTIVE whose period has not started yet (paid in advance) -> NONE until it starts", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    await setPeriod(subscriptionId, iso(2 * DAY), iso(32 * DAY));
    expect(await access(orgId)).toMatchObject({ access: "NONE", subscription_status: "ACTIVE" });
  });

  it("answers for several organizations at once; members only see their own", async () => {
    const none = await newOrganization();
    const rows = await accessOf([f.a.orgId, f.b.orgId, none]);
    expect([rows[f.a.orgId]?.access, rows[f.b.orgId]?.access, rows[none]?.access]).toEqual(["SUBSCRIPTION", "SUBSCRIPTION", "NONE"]);
    const visible = await t.asUser(f.b.ownerId, (tx) => count(tx, "select * from public.organization_access($1)", [[f.a.orgId, f.b.orgId]]));
    expect(visible).toBe(1);
    await expect(t.asAnon((tx) => tx.query("select * from public.organization_access($1)", [[f.a.orgId]]))).rejects.toThrow(/permission denied/);
  });
});

describe("scheduled expiration (public.expire_due_subscriptions)", () => {
  it("expires only what is due; ACTIVE with a future end and a future period stay; the cache becomes NULL", async () => {
    const due = await newOrganization();
    const future = await newOrganization();
    const notStarted = await newOrganization();
    const dueId = await activateSubscription(t, due, "PRO");
    const futureId = await activateSubscription(t, future, "PRO");
    const notStartedId = await activateSubscription(t, notStarted, "PRO");
    await setPeriod(dueId, iso(-31 * DAY), iso(-60_000));
    await setPeriod(notStartedId, iso(DAY), iso(31 * DAY));
    expect(await cachedPlan(due)).toBe("PRO");

    expect(await sweep()).toBeGreaterThanOrEqual(1);
    expect(await status(dueId)).toBe("EXPIRED");
    expect(await cachedPlan(due)).toBeNull();
    expect(await status(futureId)).toBe("ACTIVE");
    expect(await status(notStartedId)).toBe("ACTIVE");
    expect(await cachedPlan(future)).toBe("PRO");
    expect(await expireAuditCount(due)).toBe(1);
  });

  it("idempotent: running it again changes nothing and writes no audit record", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    await setPeriod(subscriptionId, iso(-31 * DAY), iso(-60_000));
    await sweep();
    const auditBefore = await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs"));
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(await status(subscriptionId)).toBe("EXPIRED");
    expect(await expireAuditCount(orgId)).toBe(1);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs"))).toBe(auditBefore);
  });

  it("the end is exclusive: at exactly current_period_end there is no access and the subscription is due", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    // A past instant: a sweep at an earlier instant never touches future periods of other tests.
    const end = new Date(Date.now() - 3_600_000).toISOString();
    await setPeriod(subscriptionId, iso(-31 * DAY), end);
    await t.asAdmin((tx) => tx.query("select private.expire_due_subscriptions($1::timestamptz - interval '1 second')", [end]));
    expect(await status(subscriptionId)).toBe("ACTIVE");
    await t.asAdmin((tx) => tx.query("select private.expire_due_subscriptions($1::timestamptz)", [end]));
    expect(await status(subscriptionId)).toBe("EXPIRED");
  });

  it("a SUSPENDED subscription whose period ended also expires; a CANCELED one is left alone", async () => {
    const suspended = await newOrganization();
    const canceled = await newOrganization();
    const suspendedId = await activateSubscription(t, suspended);
    const canceledId = await activateSubscription(t, canceled);
    await t.asService((tx) => tx.query("select * from admin.update_subscription_status($1, $2, 'SUSPEND', null, null)", [platformAdmin, suspendedId]));
    await t.asService((tx) => tx.query("select * from admin.update_subscription_status($1, $2, 'CANCEL', null, null)", [platformAdmin, canceledId]));
    await setPeriod(suspendedId, iso(-31 * DAY), iso(-60_000));
    await setPeriod(canceledId, iso(-31 * DAY), iso(-60_000));
    await sweep();
    expect(await status(suspendedId)).toBe("EXPIRED");
    expect(await status(canceledId)).toBe("CANCELED");
  });

  it("only the service role (the worker's scheduler) can run it", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select public.expire_due_subscriptions()"))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select public.expire_due_subscriptions()"))).rejects.toThrow(/permission denied/);
  });
});

describe("early renewal: no gap without access", () => {
  it("renewing an ACTIVE subscription with the next period (starting at its current end) keeps the access", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId);
    const end = await t.asAdmin((tx) => one<{ end: string }>(tx, "select current_period_end as end from public.subscriptions where id = $1", [subscriptionId]));
    const nextEnd = new Date(new Date(end.end).getTime() + 30 * DAY).toISOString();
    const renewal = await t.asService((tx) =>
      one<{ outcome: string }>(tx, "select * from admin.activate_subscription($1, $2, 'PRO', 'MONTHLY', 'YAPE', 39.90, $3, $4, null, null, null)", [
        platformAdmin,
        orgId,
        end.end,
        nextEnd
      ])
    );
    expect(renewal.outcome).toBe("RENEWED");
    expect(await access(orgId)).toMatchObject({ access: "SUBSCRIPTION" });
    const period = await t.asAdmin((tx) =>
      one<{ starts_now: boolean; end: string }>(tx, "select current_period_start <= now() as starts_now, current_period_end as end from public.subscriptions where id = $1", [subscriptionId])
    );
    expect(period.starts_now).toBe(true);
    expect(new Date(period.end).toISOString()).toBe(nextEnd);
  });

  it("a first subscription paid in advance does not grant access before its start", async () => {
    const orgId = await newOrganization();
    await t.asService((tx) =>
      tx.query("select * from admin.activate_subscription($1, $2, 'PRO', 'MONTHLY', 'CASH', 39.90, now() + interval '3 days', now() + interval '33 days', null, null, null)", [
        platformAdmin,
        orgId
      ])
    );
    expect(await access(orgId)).toMatchObject({ access: "NONE", subscription_status: "ACTIVE" });
  });
});

describe("customer portal requires commercial access", () => {
  const hex = () => randomBytes(32).toString("hex");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  async function portalCustomer(orgId: string) {
    const customerId = await t.asAdmin((tx) =>
      one<{ id: string }>(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Cliente portal') returning id", [orgId])
    );
    const secretHash = sha(hex());
    await t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customerId.id, secretHash]));
    return { customerId: customerId.id, secretHash };
  }
  const login = (secretHash: string, tokenHash: string) =>
    t.asService((tx) => one<{ outcome: string }>(tx, "select outcome from portal.create_session($1, $2, null, null)", [secretHash, tokenHash])).then((row) => row.outcome);
  const validate = (tokenHash: string) => t.asService((tx) => count(tx, "select * from portal.validate_session($1)", [tokenHash]));

  it("ACTIVE PRO (PORTAL included): login and session work", async () => {
    const orgId = await newOrganization();
    await activateSubscription(t, orgId, "PRO");
    const { secretHash } = await portalCustomer(orgId);
    const token = sha(hex());
    expect(await login(secretHash, token)).toBe("OK");
    expect(await validate(token)).toBe(1);
  });

  it.each(["SUSPEND", "EXPIRE", "CANCEL"] as const)("%s: open sessions stop working and login is refused; nothing is deleted; access again restores them", async (change) => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId, "PRO");
    const { customerId, secretHash } = await portalCustomer(orgId);
    const token = sha(hex());
    expect(await login(secretHash, token)).toBe("OK");

    if (change === "EXPIRE") {
      await setPeriod(subscriptionId, iso(-31 * DAY), iso(-60_000));
      await sweep();
    } else {
      await t.asService((tx) => tx.query("select * from admin.update_subscription_status($1, $2, $3, null, null)", [platformAdmin, subscriptionId, change]));
    }
    expect(await validate(token)).toBe(0);
    expect(await login(secretHash, sha(hex()))).toBe("SUBSCRIPTION_INACTIVE");
    const kept = await t.asAdmin(async (tx) => ({
      credentials: await count(tx, "select 1 from public.customer_access_credentials where customer_id = $1 and status = 'ACTIVE'", [customerId]),
      sessions: await count(tx, "select 1 from public.customer_sessions where customer_id = $1 and revoked_at is null", [customerId])
    }));
    expect(kept).toEqual({ credentials: 1, sessions: 1 });

    // A new payment gives the access back: the same session works again.
    await t.asService((tx) =>
      tx.query("select * from admin.activate_subscription($1, $2, 'PRO', 'MONTHLY', 'TRANSFER', 39.90, now(), now() + interval '1 month', null, null, null)", [
        platformAdmin,
        orgId
      ])
    );
    expect(await validate(token)).toBe(1);
  });

  it("no subscription: login refused", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId, "PRO");
    const { secretHash } = await portalCustomer(orgId);
    await t.asService((tx) => tx.query("select * from admin.update_subscription_status($1, $2, 'CANCEL', null, null)", [platformAdmin, subscriptionId]));
    expect(await login(secretHash, sha(hex()))).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("an ACTIVE BASIC subscription (no PORTAL feature) cannot use the portal; the portal sync scope is empty too", async () => {
    const orgId = await newOrganization();
    const subscriptionId = await activateSubscription(t, orgId, "PRO");
    const { secretHash } = await portalCustomer(orgId);
    const token = sha(hex());
    expect(await login(secretHash, token)).toBe("OK");
    await t.asService((tx) =>
      tx.query("select * from admin.activate_subscription($1, $2, 'BASIC', 'MONTHLY', 'CASH', 19.90, now(), now() + interval '1 month', null, null, null)", [
        platformAdmin,
        orgId
      ])
    );
    expect(await status(subscriptionId)).toBe("ACTIVE");
    expect(await validate(token)).toBe(0);
    expect(await t.asService((tx) => count(tx, "select * from portal.sync_scope($1)", [token]))).toBe(0);
    expect(await login(secretHash, sha(hex()))).toBe("SUBSCRIPTION_INACTIVE");
  });
});

describe("legacy organizations keep the phase 1.1 behavior", () => {
  let legacy: TestDatabase;
  let owner: string;
  let orgId: string;

  beforeAll(async () => {
    legacy = await createTestDatabase({ stopBefore: "20261006120000" });
    owner = await legacy.createUser("legacy@g.test");
    orgId = (await legacy.asUser(owner, (tx) => one<{ id: string }>(tx, "select public.create_organization('Antigua', 'antigua') as id"))).id;
    for (const file of listMigrationFiles().filter((name) => name >= "20261006120000")) {
      await legacy.db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  });
  afterAll(async () => legacy?.close());

  it("FREE without subscription: access LEGACY (BASIC), plan untouched, never expired by the sweep", async () => {
    const row = await legacy.asService((tx) =>
      one<{ access: string; effective_plan: string; plan: string }>(tx, "select access, effective_plan, plan from public.organization_access($1)", [[orgId]])
    );
    expect(row).toEqual({ access: "LEGACY", effective_plan: "BASIC", plan: "FREE" });
    expect((await legacy.asService((tx) => one<{ n: number }>(tx, "select public.expire_due_subscriptions() as n"))).n).toBe(0);
    expect(await legacy.asAdmin((tx) => one<{ plan: string }>(tx, "select plan from public.organizations where id = $1", [orgId]))).toEqual({ plan: "FREE" });
  });

  it("its portal keeps working (legacy behavior unchanged)", async () => {
    const customer = await legacy.asAdmin((tx) => one<{ id: string }>(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Cliente') returning id", [orgId]));
    const secret = createHash("sha256").update("legacy-secret").digest("hex");
    await legacy.asUser(owner, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customer.id, secret]));
    const token = createHash("sha256").update("legacy-token").digest("hex");
    const outcome = await legacy.asService((tx) => one<{ outcome: string }>(tx, "select outcome from portal.create_session($1, $2, null, null)", [secret, token]));
    expect(outcome.outcome).toBe("OK");
  });
});
