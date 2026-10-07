import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Commercial V1.1 (20261006130000_subscriptions.sql): mandatory subscription.
 * organization -> subscription -> plan_price -> plan -> entitlements;
 * organizations.plan is a cache written only by the subscription core;
 * manual payments (YAPE / CASH / TRANSFER / MANUAL) through admin.*; the
 * private core is the one the Culqi webhook will call (origin CULQI).
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

/** A fresh organization (no subscription) owned by f.a.ownerId. */
async function newOrganization(): Promise<string> {
  sequence += 1;
  const row = await t.asService((tx) =>
    one<{ id: string }>(tx, "select admin.create_organization($1, $2, $3, null, $4, null) as id", [platformAdmin, `Cliente ${sequence}`, `cliente-${sequence}`, f.a.ownerId])
  );
  return row.id;
}

interface Activation {
  plan?: string | undefined;
  period?: "MONTHLY" | "YEARLY" | undefined;
  method?: string | undefined;
  amount?: string | number | undefined;
  start?: string | undefined;
  end?: string | undefined;
  reference?: string | null | undefined;
}

async function activate(orgId: string, options: Activation = {}) {
  return t.asService((tx) =>
    one<{ subscription_id: string; outcome: string }>(
      tx,
      `select * from admin.activate_subscription($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), coalesce($8::timestamptz, now() + interval '1 month'), $9, null, 'req-test')`,
      [
        platformAdmin,
        orgId,
        options.plan ?? "PRO",
        options.period ?? "MONTHLY",
        options.method ?? "YAPE",
        options.amount ?? "39.90",
        options.start ?? null,
        options.end ?? null,
        options.reference ?? null
      ]
    )
  );
}

const action = (subscriptionId: string, name: "SUSPEND" | "REACTIVATE" | "CANCEL" | "EXPIRE", reason: string | null = null) =>
  t.asService((tx) => tx.query<{ status: string }>("select * from admin.update_subscription_status($1, $2, $3, $4, 'req-test')", [platformAdmin, subscriptionId, name, reason]));

const subscription = (id: string) =>
  t.asAdmin((tx) =>
    one<{ status: string; payment_method: string; origin: string; plan: string; billing_period: string; suspended_at: string | null; canceled_at: string | null; expired_at: string | null; current_period_end: string }>(
      tx,
      `select s.status, s.payment_method, s.origin, c.code as plan, p.billing_period, s.suspended_at, s.canceled_at, s.expired_at, s.current_period_end
       from public.subscriptions s join public.plan_prices p on p.id = s.plan_price_id join public.plan_catalog c on c.id = p.plan_id where s.id = $1`,
      [id]
    )
  );

const cachedPlan = async (orgId: string) =>
  (await t.asAdmin((tx) => one<{ plan: string | null }>(tx, "select plan from public.organizations where id = $1", [orgId]))).plan;

const access = async (orgId: string, userId = f.a.ownerId) =>
  t.asUser(userId, (tx) => one<{ access: string; effective_plan: string | null; subscription_status: string | null }>(tx, "select access, effective_plan, subscription_status from public.organization_entitlements($1) limit 1", [orgId]));

const audit = (orgId: string) =>
  t.asAdmin(async (tx) =>
    (
      await tx.query<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
        "select action, actor_user_id, metadata from public.platform_audit_logs where organization_id = $1 and action like any (array['subscription.%', 'payment.%']) order by created_at, id",
        [orgId]
      )
    ).rows
  );

/** The organization's operational data: never touched by the subscription. */
async function dataOf(tx: Tx, orgId: string) {
  return {
    accounts: await count(tx, "select 1 from public.email_accounts where organization_id = $1", [orgId]),
    rules: await count(tx, "select 1 from public.email_rules where organization_id = $1", [orgId]),
    emails: await count(tx, "select 1 from public.emails where organization_id = $1", [orgId]),
    members: await count(tx, "select 1 from public.organization_members where organization_id = $1", [orgId])
  };
}

describe("activation (manual payment through the single core)", () => {
  it("creates an ACTIVE subscription, sets the plan cache, records the payment and audits both", async () => {
    const orgId = await newOrganization();
    expect(await access(orgId)).toMatchObject({ access: "NONE", effective_plan: null, subscription_status: null });

    const result = await activate(orgId, { plan: "PRO", method: "YAPE", amount: "39.90", reference: "OP-777" });
    expect(result.outcome).toBe("ACTIVATED");
    expect(await subscription(result.subscription_id)).toMatchObject({ status: "ACTIVE", payment_method: "YAPE", origin: "ADMIN", plan: "PRO", billing_period: "MONTHLY" });
    expect(await cachedPlan(orgId)).toBe("PRO");
    expect(await access(orgId)).toMatchObject({ access: "SUBSCRIPTION", effective_plan: "PRO", subscription_status: "ACTIVE" });

    const payment = await t.asAdmin((tx) =>
      one<{ external_event_id: string; amount: string; currency: string; status: string; subscription_id: string; processed_at: string | null; event_type: string }>(
        tx,
        "select external_event_id, amount::text, currency, status, subscription_id, processed_at, event_type from public.payment_events where organization_id = $1",
        [orgId]
      )
    );
    expect(payment).toMatchObject({ external_event_id: "yape:OP-777", amount: "39.90", currency: "PEN", status: "PROCESSED", subscription_id: result.subscription_id, event_type: "payment.manual" });
    expect(payment.processed_at).not.toBeNull();

    const trail = await audit(orgId);
    // Same transaction (same timestamp): compared by action, not by order.
    expect(trail.map((row) => row.action).sort()).toEqual(["payment.recorded", "subscription.activated"]);
    expect(trail.find((row) => row.action === "subscription.activated")).toMatchObject({ actor_user_id: platformAdmin, metadata: { plan: "PRO", billingPeriod: "MONTHLY", paymentMethod: "YAPE", origin: "ADMIN" } });
    expect(trail.find((row) => row.action === "payment.recorded")?.metadata).toMatchObject({ paymentMethod: "YAPE", amount: 39.9, currency: "PEN", reference: "yape:OP-777" });
  });

  it.each(["YAPE", "CASH", "TRANSFER", "MANUAL"])("%s is a valid manual payment method", async (method) => {
    const orgId = await newOrganization();
    const result = await activate(orgId, { method, plan: "BASIC", amount: "19.90" });
    expect(await subscription(result.subscription_id)).toMatchObject({ status: "ACTIVE", payment_method: method, plan: "BASIC" });
  });

  it.each([
    ["BASIC", "MONTHLY"],
    ["PRO", "YEARLY"],
    ["BUSINESS", "MONTHLY"],
    ["BUSINESS", "YEARLY"]
  ] as const)("%s %s: the organization gets exactly that plan", async (plan, period) => {
    const orgId = await newOrganization();
    await activate(orgId, { plan, period, end: period === "YEARLY" ? new Date(Date.now() + 365 * 86_400_000).toISOString() : undefined });
    expect(await cachedPlan(orgId)).toBe(plan);
    expect((await access(orgId)).effective_plan).toBe(plan);
  });

  it.each([
    ["CULQI is never a manual payment", { method: "CULQI" }, /YAPE, CASH, TRANSFER or MANUAL/],
    ["zero amount", { amount: 0 }, /greater than zero/],
    ["period ending before it starts", { start: "2030-02-01T00:00:00Z", end: "2030-01-01T00:00:00Z" }, /must end after it starts/],
    ["period already over", { start: "2020-01-01T00:00:00Z", end: "2020-02-01T00:00:00Z" }, /already ended/],
    ["period longer than two years", { end: "2099-01-01T00:00:00Z" }, /subscriptions_period/],
    ["FREE", { plan: "FREE" }, /no active price/]
  ])("refuses %s and changes nothing", async (_label, options, error) => {
    const orgId = await newOrganization();
    const before = await t.asAdmin((tx) => count(tx, "select 1 from public.payment_events"));
    await expect(activate(orgId, options as Activation)).rejects.toThrow(error);
    expect(await cachedPlan(orgId)).toBeNull();
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.subscriptions where organization_id = $1", [orgId]))).toBe(0);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.payment_events"))).toBe(before);
  });
});

describe("renewal and plan changes (no proration, no credits)", () => {
  it("same price = RENEWED with the new period; another price = PLAN_CHANGED; the cache follows every change", async () => {
    const orgId = await newOrganization();
    const first = await activate(orgId, { plan: "BASIC" });
    const nextStart = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const nextEnd = new Date(Date.now() + 60 * 86_400_000).toISOString();

    const renewed = await activate(orgId, { plan: "BASIC", start: nextStart, end: nextEnd, amount: "19.90" });
    expect(renewed).toEqual({ subscription_id: first.subscription_id, outcome: "RENEWED" });
    expect(new Date((await subscription(first.subscription_id)).current_period_end).toISOString()).toBe(nextEnd);

    for (const plan of ["PRO", "BUSINESS", "PRO", "BASIC"]) {
      const changed = await activate(orgId, { plan });
      expect(changed).toEqual({ subscription_id: first.subscription_id, outcome: "PLAN_CHANGED" });
      expect(await cachedPlan(orgId)).toBe(plan);
      expect((await access(orgId)).effective_plan).toBe(plan);
    }
    // One subscription all along (renewals and changes update it).
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.subscriptions where organization_id = $1", [orgId]))).toBe(1);
    const changes = (await audit(orgId)).filter((row) => row.action === "subscription.plan_changed").map((row) => [row.metadata.fromPlan, row.metadata.plan]);
    expect(changes).toEqual([
      ["BASIC", "PRO"],
      ["PRO", "BUSINESS"],
      ["BUSINESS", "PRO"],
      ["PRO", "BASIC"]
    ]);
  });

  it("MONTHLY -> YEARLY is a change of price (period) on the same subscription", async () => {
    const orgId = await newOrganization();
    const first = await activate(orgId, { plan: "PRO", period: "MONTHLY" });
    const yearly = await activate(orgId, { plan: "PRO", period: "YEARLY", amount: "399", end: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    expect(yearly).toEqual({ subscription_id: first.subscription_id, outcome: "PLAN_CHANGED" });
    expect(await subscription(first.subscription_id)).toMatchObject({ plan: "PRO", billing_period: "YEARLY" });
  });
});

describe("status changes: suspend, reactivate, cancel, expire (nothing is deleted)", () => {
  it("SUSPENDED removes the access (cache NULL) and keeps every record; REACTIVATE restores it", async () => {
    const orgId = f.b.orgId;
    const before = await t.asAdmin((tx) => dataOf(tx, orgId));
    const { subscription_id: id } = await activate(orgId, { plan: "BUSINESS", amount: "89.90" });

    const [suspended] = (await action(id, "SUSPEND", "Falta de pago")).rows;
    expect(suspended).toMatchObject({ status: "SUSPENDED" });
    expect((await subscription(id)).suspended_at).not.toBeNull();
    expect(await cachedPlan(orgId)).toBeNull();
    expect(await access(orgId, f.b.ownerId)).toMatchObject({ access: "NONE", effective_plan: null, subscription_status: "SUSPENDED" });
    expect(await t.asAdmin((tx) => dataOf(tx, orgId))).toEqual(before);

    const [reactivated] = (await action(id, "REACTIVATE")).rows;
    expect(reactivated).toMatchObject({ status: "ACTIVE" });
    expect((await subscription(id)).suspended_at).toBeNull();
    expect(await cachedPlan(orgId)).toBe("BUSINESS");
    expect(await access(orgId, f.b.ownerId)).toMatchObject({ access: "SUBSCRIPTION", effective_plan: "BUSINESS" });

    await action(id, "CANCEL");
    expect(await t.asAdmin((tx) => dataOf(tx, orgId))).toEqual(before);
    const trail = (await audit(orgId)).map((row) => row.action);
    expect(trail).toEqual(expect.arrayContaining(["subscription.suspended", "subscription.reactivated", "subscription.canceled"]));
    expect((await audit(orgId)).find((row) => row.action === "subscription.suspended")?.metadata).toEqual({ from: "ACTIVE", to: "SUSPENDED", reason: "Falta de pago" });
  });

  it("CANCELED is terminal: no access, cannot be reactivated; a new payment starts a NEW subscription (history kept)", async () => {
    const orgId = await newOrganization();
    const { subscription_id: id } = await activate(orgId);
    await action(id, "CANCEL", "Lo pidió el cliente");
    expect(await subscription(id)).toMatchObject({ status: "CANCELED" });
    expect((await subscription(id)).canceled_at).not.toBeNull();
    expect(await cachedPlan(orgId)).toBeNull();
    expect((await access(orgId)).access).toBe("NONE");
    for (const next of ["REACTIVATE", "SUSPEND", "CANCEL", "EXPIRE"] as const) {
      await expect(action(id, next)).rejects.toThrow(/A CANCELED subscription cannot become/);
    }
    const again = await activate(orgId, { plan: "BASIC", amount: "19.90" });
    expect(again.outcome).toBe("ACTIVATED");
    expect(again.subscription_id).not.toBe(id);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.subscriptions where organization_id = $1", [orgId]))).toBe(2);
    expect(await cachedPlan(orgId)).toBe("BASIC");
  });

  it("EXPIRED: refused before the period ends; once it ended access stops at once, and the sweep marks it EXPIRED", async () => {
    const orgId = await newOrganization();
    const { subscription_id: id } = await activate(orgId, { plan: "PRO" });
    await expect(action(id, "EXPIRE")).rejects.toThrow(/has not ended yet/);

    // The period ends (simulated by the table owner): access stops even before any sweep.
    await t.asAdmin((tx) =>
      tx.query("update public.subscriptions set current_period_start = now() - interval '2 months', current_period_end = now() - interval '1 second', started_at = now() - interval '2 months' where id = $1", [id])
    );
    expect(await access(orgId)).toMatchObject({ access: "NONE", subscription_status: "ACTIVE" });
    await expect(action(id, "REACTIVATE")).rejects.toThrow(/A ACTIVE subscription cannot become ACTIVE/);

    const expired = await t.asAdmin((tx) => one<{ n: number }>(tx, "select private.expire_due_subscriptions() as n"));
    expect(expired.n).toBeGreaterThanOrEqual(1);
    expect(await subscription(id)).toMatchObject({ status: "EXPIRED" });
    expect((await subscription(id)).expired_at).not.toBeNull();
    expect(await cachedPlan(orgId)).toBeNull();
    expect((await audit(orgId)).at(-1)).toMatchObject({ action: "subscription.expired", actor_user_id: null, metadata: { reason: "period_ended" } });
  });

  it("a suspended subscription whose period ended cannot be reactivated: a new period must be paid", async () => {
    const orgId = await newOrganization();
    const { subscription_id: id } = await activate(orgId);
    await action(id, "SUSPEND");
    await t.asAdmin((tx) =>
      tx.query("update public.subscriptions set current_period_start = now() - interval '2 months', current_period_end = now() - interval '1 day', started_at = now() - interval '2 months' where id = $1", [id])
    );
    await expect(action(id, "REACTIVATE")).rejects.toThrow(/paid period has ended/);
    // Paying a new period reactivates it (RENEWED).
    expect((await activate(orgId)).outcome).toBe("RENEWED");
    expect(await subscription(id)).toMatchObject({ status: "ACTIVE" });
  });

  it("unknown subscription: no row, nothing audited", async () => {
    expect((await action("99999999-9999-4999-8999-999999999999", "SUSPEND")).rows).toEqual([]);
  });
});

describe("one open subscription per organization", () => {
  it("a second ACTIVE / PAST_DUE / SUSPENDED row is refused by the partial unique index; history rows are allowed", async () => {
    const orgId = await newOrganization();
    const { subscription_id: id } = await activate(orgId);
    const priceId = await t.asAdmin((tx) => one<{ plan_price_id: string }>(tx, "select plan_price_id from public.subscriptions where id = $1", [id]));
    for (const status of ["ACTIVE", "PAST_DUE"]) {
      await expect(
        t.asAdmin((tx) =>
          tx.query(
            "insert into public.subscriptions (organization_id, plan_price_id, status, payment_method, origin, started_at, current_period_start, current_period_end) values ($1, $2, $3, 'CASH', 'ADMIN', now(), now(), now() + interval '1 month')",
            [orgId, priceId.plan_price_id, status]
          )
        )
      ).rejects.toThrow(/subscriptions_one_open_per_organization/);
    }
    await t.asAdmin((tx) =>
      tx.query(
        "insert into public.subscriptions (organization_id, plan_price_id, status, payment_method, origin, started_at, current_period_start, current_period_end, expired_at) values ($1, $2, 'EXPIRED', 'CASH', 'ADMIN', now() - interval '2 months', now() - interval '2 months', now() - interval '1 month', now())",
        [orgId, priceId.plan_price_id]
      )
    );
  });
});

describe("consistency: organizations.plan always mirrors the ACTIVE subscription", () => {
  it("subscription = PRO <=> organization.plan = PRO, and nobody can make it BUSINESS directly", async () => {
    const orgId = await newOrganization();
    await activate(orgId, { plan: "PRO" });
    expect(await cachedPlan(orgId)).toBe("PRO");
    await expect(t.asAdmin((tx) => tx.query("update public.organizations set plan = 'BUSINESS' where id = $1", [orgId]))).rejects.toThrow(
      /derived from the subscription/
    );
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.organizations set plan = 'BUSINESS' where id = $1", [orgId]))).rejects.toThrow(
      /permission denied/
    );
    await expect(
      t.asService((tx) => tx.query("select * from admin.update_organization($1, $2, 'BUSINESS', null, null)", [platformAdmin, orgId]))
    ).rejects.toThrow(/comes from a subscription/);

    // Exhaustive check over every organization: cache = plan of the ACTIVE subscription (legacy rows aside).
    const mismatches = await t.asAdmin((tx) =>
      count(
        tx,
        `select 1 from public.organizations o
         where exists (select 1 from public.subscriptions x where x.organization_id = o.id)
           and o.plan is distinct from (
             select c.code from public.subscriptions s join public.plan_prices p on p.id = s.plan_price_id join public.plan_catalog c on c.id = p.plan_id
             where s.organization_id = o.id and s.status = 'ACTIVE')`
      )
    );
    expect(mismatches).toBe(0);
  });
});

describe("payment events: idempotency", () => {
  it("a new event is processed; the same external_event_id is never processed twice", async () => {
    const orgId = await newOrganization();
    const first = await activate(orgId, { method: "TRANSFER", reference: "BCP-0001" });
    expect(first.outcome).toBe("ACTIVATED");
    const periodEnd = (await subscription(first.subscription_id)).current_period_end;

    const again = await activate(orgId, { method: "TRANSFER", reference: "BCP-0001", plan: "BUSINESS", end: new Date(Date.now() + 50 * 86_400_000).toISOString() });
    expect(again).toEqual({ subscription_id: first.subscription_id, outcome: "DUPLICATE" });
    expect(await subscription(first.subscription_id)).toMatchObject({ plan: "PRO", current_period_end: periodEnd });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.payment_events where external_event_id = 'transfer:BCP-0001'"))).toBe(1);
    expect((await audit(orgId)).filter((row) => row.action === "payment.recorded")).toHaveLength(1);

    // The same reference with another method is another payment.
    expect((await activate(orgId, { method: "YAPE", reference: "BCP-0001" })).outcome).toBe("RENEWED");
  });

  it("the core is ready for the payment provider: origin CULQI, its own event id, same idempotency (no webhook yet)", async () => {
    const orgId = await newOrganization();
    const priceId = await t.asAdmin((tx) =>
      one<{ id: string }>(tx, "select p.id from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id where c.code = 'PRO' and p.billing_period = 'MONTHLY' and p.active")
    );
    const call = () =>
      t.asAdmin((tx) =>
        one<{ subscription_id: string; outcome: string }>(
          tx,
          "select * from private.activate_subscription($1, $2, 'CULQI', 'CULQI', now(), now() + interval '1 month', 39.90, 'PEN', 'evt_culqi_123', 'charge.succeeded', null, 'req-webhook')",
          [orgId, priceId.id]
        )
      );
    const first = await call();
    expect(first.outcome).toBe("ACTIVATED");
    expect(await subscription(first.subscription_id)).toMatchObject({ payment_method: "CULQI", origin: "CULQI" });
    expect((await call()).outcome).toBe("DUPLICATE");
    expect((await audit(orgId)).find((row) => row.action === "subscription.activated")).toMatchObject({ actor_user_id: null, metadata: { origin: "CULQI" } });
    // A CULQI origin cannot claim a manual method, nor the admin a CULQI payment.
    await expect(
      t.asAdmin((tx) =>
        tx.query("select * from private.activate_subscription($1, $2, 'CASH', 'CULQI', now(), now() + interval '1 month', 39.90, 'PEN', 'evt_x', 'charge.succeeded', null, null)", [orgId, priceId.id])
      )
    ).rejects.toThrow(/must use the CULQI payment method/);
  });
});

describe("security: members never write subscriptions, payments or prices", () => {
  it("members read their own subscription only", async () => {
    const orgId = await newOrganization();
    await activate(orgId);
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.subscriptions where organization_id = $1", [orgId]))).toBe(0);
    expect(await t.asUser(f.a.ownerId, (tx) => count(tx, "select 1 from public.subscriptions where organization_id = $1", [orgId]))).toBe(1);
    expect(await t.asUser(f.b.ownerId, (tx) => count(tx, "select 1 from public.subscriptions where organization_id = $1", [orgId]))).toBe(0);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select 1 from public.payment_events"))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select 1 from public.subscriptions"))).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["activate (insert)", "insert into public.subscriptions (organization_id, plan_price_id, status, payment_method, origin, started_at, current_period_start, current_period_end) select $1, id, 'ACTIVE', 'CASH', 'ADMIN', now(), now(), now() + interval '1 month' from public.plan_prices limit 1"],
    ["change the status", "update public.subscriptions set status = 'ACTIVE', suspended_at = null where organization_id = $1"],
    ["change the period end", "update public.subscriptions set current_period_end = now() + interval '1 year' where organization_id = $1"],
    ["change the payment method", "update public.subscriptions set payment_method = 'CULQI' where organization_id = $1"],
    ["change the price of the subscription", "update public.subscriptions set plan_price_id = (select id from public.plan_prices order by amount desc limit 1) where organization_id = $1"],
    ["change a catalog price", "update public.plan_prices set amount = 1"],
    ["record a payment", "insert into public.payment_events (organization_id, event_type, payment_method, amount) values ($1, 'payment.manual', 'CASH', 1)"],
    ["delete the subscription", "delete from public.subscriptions where organization_id = $1"]
  ])("an OWNER cannot %s", async (_label, sql) => {
    const orgId = await newOrganization();
    await activate(orgId);
    const usesOrg = sql.includes("$1");
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql, usesOrg ? [orgId] : []))).rejects.toThrow(/permission denied/);
  });

  it("the subscription functions are unreachable for members, anon and the service role (only through admin.*)", async () => {
    const orgId = await newOrganization();
    for (const sql of [
      "select * from private.activate_subscription($1, gen_random_uuid(), 'CASH', 'ADMIN', now(), now() + interval '1 month', 1, 'PEN', null, null, null, null)",
      "select * from private.change_subscription_status(gen_random_uuid(), 'ACTIVE', null, null, null)",
      "select private.sync_organization_plan($1)",
      "select private.expire_due_subscriptions()"
    ]) {
      const params = sql.includes("$1") ? [orgId] : [];
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql, params))).rejects.toThrow(/permission denied/);
      await expect(t.asService((tx) => tx.query(sql, params))).rejects.toThrow(/permission denied/);
    }
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("select * from admin.activate_subscription($1, $2, 'PRO', 'MONTHLY', 'CASH', 1, now(), now() + interval '1 month', null, null, null)", [f.a.ownerId, orgId])
      )
    ).rejects.toThrow(/permission denied/);
    // The service role reaches admin.* but the actor must be a platform admin.
    await expect(
      t.asService((tx) =>
        tx.query("select * from admin.activate_subscription($1, $2, 'PRO', 'MONTHLY', 'CASH', 1, now(), now() + interval '1 month', null, null, null)", [f.a.ownerId, orgId])
      )
    ).rejects.toMatchObject({ code: "42501" });
    expect(await cachedPlan(orgId)).toBeNull();
  });
});
