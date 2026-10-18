import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Commercial V1 phase 2, Culqi SANDBOX (20261016120000_culqi_billing_sandbox.sql
 * + 20261016120100_culqi_billing_verified_charges.sql). The provider side
 * (billing_*) never grants access by itself: only a Culqi CHARGE verified by
 * the worker is applied, through private.activate_subscription (origin
 * CULQI), once per charge id; stale charges never lower a plan or shorten a
 * period; declined charges are recorded without touching public.subscriptions.
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

type Plan = "BASIC" | "PRO" | "BUSINESS";
type Period = "MONTHLY" | "YEARLY";

async function newOrganization(): Promise<string> {
  sequence += 1;
  return (
    await t.asService((tx) =>
      one<{ id: string }>(tx, "select admin.create_organization($1, $2, $3, null, $4, null) as id", [platformAdmin, `Pago ${sequence}`, `pago-${sequence}`, f.a.ownerId])
    )
  ).id;
}

const priceId = (plan: Plan, period: Period = "MONTHLY") =>
  t.asService((tx) =>
    one<{ id: string }>(
      tx,
      "select p.id from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id where c.code = $1 and p.billing_period = $2 and p.active",
      [plan, period]
    )
  ).then((row) => row.id);

/** A Culqi subscription created by the API (checkout), as the service role. */
async function checkout(orgId: string, plan: Plan, options: { sxn?: string | null; period?: Period } = {}) {
  sequence += 1;
  const sxn = options.sxn === undefined ? `sxn_test_s${sequence}` : options.sxn;
  const price = await priceId(plan, options.period ?? "MONTHLY");
  return t.asService((tx: Tx) =>
    one<{ id: string }>(
      tx,
      `insert into public.billing_subscriptions (organization_id, plan_price_id, environment, external_customer_id, external_card_id, external_plan_id, external_subscription_id, provider_status)
       values ($1, $2, 'test', $3, $4, $5, $6, 1) returning id`,
      [orgId, price, `cus_test_c${sequence}`, `crd_test_k${sequence}`, `pln_test_p${sequence}`, sxn]
    )
  );
}

interface Confirm {
  /** The verified Culqi charge (the idempotency key). */
  charge: string;
  /** Defaults to the charge id (they must be equal). */
  key?: string | null;
  period?: number;
  start?: string;
  end?: string;
}

async function confirm(billingId: string, options: Confirm) {
  return t.asService((tx) =>
    one<{ outcome: string; subscription_id: string; superseded_external_ids: string[] }>(
      tx,
      `select * from public.billing_activate_culqi_subscription($1, $2, 'subscription.charge.succeeded',
         coalesce($3::timestamptz, now()), coalesce($4::timestamptz, now() + interval '1 month'), $5, $6, 3::smallint, 'req-culqi')`,
      [billingId, options.key === undefined ? options.charge : options.key, options.start ?? null, options.end ?? null, options.period ?? 1, options.charge]
    )
  );
}

/** A declined charge, recorded under `key` (the charge id, or an event id when the charge is unknown). */
const failCharge = (billingId: string, key: string, charge: string | null = key.startsWith("chr_") ? key : null) =>
  t.asService((tx) =>
    one<{ result: string }>(
      tx,
      "select public.billing_record_culqi_charge_failure($1, $2, 'subscription.charge.failed', $3, 'card_declined', 'Tarjeta rechazada', 5::smallint, 'req-fail') as result",
      [billingId, key, charge]
    )
  ).then((row) => row.result);

const setStatus = (billingId: string, status: string, reason: string | null = null) =>
  t.asService((tx) =>
    one<{ result: string }>(tx, "select public.billing_set_culqi_status($1, $2, null, $3, null, null, 'req-status') as result", [billingId, status, reason])
  ).then((row) => row.result);

const billing = (id: string) =>
  t.asAdmin((tx) =>
    one<{ status: string; cancel_reason: string | null; subscription_id: string | null; current_period_end: string | null; failure_code: string | null }>(
      tx,
      "select status, cancel_reason, subscription_id, current_period_end, failure_code from public.billing_subscriptions where id = $1",
      [id]
    )
  );

const openSubscription = (orgId: string) =>
  t.asAdmin((tx) =>
    tx
      .query<{ id: string; status: string; origin: string; payment_method: string; external_subscription_id: string | null; plan: string; current_period_end: Date }>(
        `select s.id, s.status, s.origin, s.payment_method, s.external_subscription_id, c.code as plan, s.current_period_end
         from public.subscriptions s join public.plan_prices p on p.id = s.plan_price_id join public.plan_catalog c on c.id = p.plan_id
         where s.organization_id = $1 and s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')`,
        [orgId]
      )
      .then((result) => result.rows[0] ?? null)
  );

const organizationPlan = (orgId: string) =>
  t.asAdmin((tx) => one<{ plan: string | null }>(tx, "select plan from public.organizations where id = $1", [orgId])).then((row) => row.plan);

const access = (orgId: string) =>
  t.asAdmin((tx) => one<{ access: string; effective_plan: string | null }>(tx, "select access, effective_plan from public.organization_access(array[$1::uuid])", [orgId]));

const payments = (orgId: string) => t.asAdmin((tx) => count(tx, "select 1 from public.payment_events where organization_id = $1", [orgId]));

describe("schema, privileges and environment guards", () => {
  it("the Data API (anon / authenticated) cannot read or write any billing table; service_role cannot delete", async () => {
    for (const table of ["billing_provider_plans", "billing_customers", "billing_subscriptions", "billing_webhook_events"]) {
      await expect(t.asAnon((tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
      await expect(t.asService((tx) => tx.query(`delete from public.${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("select public.billing_set_culqi_status(gen_random_uuid(), 'CANCELED', null, null, null, null, null)"))
    ).rejects.toThrow(/permission denied/);
  });

  it("ids must have Culqi's format and belong to the row's environment (a live id never enters a test row)", async () => {
    const org = await newOrganization();
    const price = await priceId("PRO");
    const insert = (values: Array<string | null>) =>
      t.asService((tx) =>
        tx.query(
          `insert into public.billing_subscriptions (organization_id, plan_price_id, environment, external_customer_id, external_plan_id, external_subscription_id)
           values ($1, $2, 'test', $3, $4, $5)`,
          [org, price, ...values]
        )
      );
    await expect(insert(["cus_live_x1", "pln_test_x1", "sxn_test_x1"])).rejects.toThrow(/environment_matches/);
    await expect(insert(["cus_test_x1", "pln_test_x1", "sxn_live_x1"])).rejects.toThrow(/environment_matches/);
    await expect(insert(["4111111111111111", "pln_test_x1", "sxn_test_x1"])).rejects.toThrow(/customer_id/);
    await expect(
      t.asService((tx) => tx.query("insert into public.billing_provider_plans (plan_price_id, environment, external_plan_id) values ($1, 'test', 'pln_live_abc')", [price]))
    ).rejects.toThrow(/environment_matches/);
    await expect(
      t.asService((tx) => tx.query("insert into public.billing_webhook_events (environment, external_event_id) values ('test', 'evt_live_abc')"))
    ).rejects.toThrow(/environment_matches/);
  });

  it("F5: the checkout is reserved BEFORE the Culqi customer exists; a Culqi subscription always has its customer", async () => {
    const org = await newOrganization();
    const price = await priceId("PRO");
    const reserved = await t.asService((tx) =>
      one<{ id: string }>(
        tx,
        "insert into public.billing_subscriptions (organization_id, plan_price_id, environment, external_plan_id) values ($1, $2, 'test', 'pln_test_reserve') returning id",
        [org, price]
      )
    );
    // A second reservation of the same organization is refused atomically (one PENDING per organization).
    await expect(
      t.asService((tx) => tx.query("insert into public.billing_subscriptions (organization_id, plan_price_id, environment, external_plan_id) values ($1, $2, 'test', 'pln_test_reserve')", [org, price]))
    ).rejects.toThrow(/billing_subscriptions_one_pending/);
    await expect(
      t.asService((tx) => tx.query("update public.billing_subscriptions set external_subscription_id = 'sxn_test_nocustomer' where id = $1", [reserved.id]))
    ).rejects.toThrow(/customer_before_subscription/);
  });

  it("one checkout in progress per organization; webhook events are unique per Culqi event id", async () => {
    const org = await newOrganization();
    await checkout(org, "PRO");
    await expect(checkout(org, "BUSINESS")).rejects.toThrow(/billing_subscriptions_one_pending/);
    await t.asService((tx) => tx.query("insert into public.billing_webhook_events (environment, external_event_id) values ('test', 'evt_test_unique1')"));
    await expect(
      t.asService((tx) => tx.query("insert into public.billing_webhook_events (environment, external_event_id) values ('test', 'evt_test_unique1')"))
    ).rejects.toThrow(/billing_webhook_events_unique/);
  });
});

describe("F1: only a verified charge activates (private.activate_subscription, origin CULQI)", () => {
  it("activates once per charge: CULQI origin, cache, payment with the charge id, audit", async () => {
    const org = await newOrganization();
    expect((await access(org)).access).toBe("NONE");
    const id = await checkout(org, "PRO");
    const first = await confirm(id.id, { charge: "chr_test_first" });
    expect(first.outcome).toBe("ACTIVATED");

    const sub = await openSubscription(org);
    expect(sub).toMatchObject({ status: "ACTIVE", origin: "CULQI", payment_method: "CULQI", plan: "PRO" });
    expect(sub?.external_subscription_id).toMatch(/^sxn_test_/);
    expect(await organizationPlan(org)).toBe("PRO");
    expect(await access(org)).toMatchObject({ access: "SUBSCRIPTION", effective_plan: "PRO" });
    expect(await billing(id.id)).toMatchObject({ status: "ACTIVE", subscription_id: sub?.id });

    const payment = await t.asAdmin((tx) =>
      one<{ amount: string; payment_status: string; external_payment_id: string; payment_method: string; external_event_id: string }>(
        tx,
        "select amount::text, payment_status, external_payment_id, payment_method, external_event_id from public.payment_events where organization_id = $1",
        [org]
      )
    );
    expect(payment).toEqual({ amount: "39.90", payment_status: "SUCCEEDED", external_payment_id: "chr_test_first", payment_method: "CULQI", external_event_id: "chr_test_first" });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs where organization_id = $1 and action = 'subscription.activated'", [org]))).toBe(1);

    // The same charge again (webhook + reconciliation, retries): one payment, one activation.
    expect((await confirm(id.id, { charge: "chr_test_first" })).outcome).toBe("DUPLICATE");
    expect(await payments(org)).toBe(1);
  });

  it("nothing can be activated without a charge id: no subscription status / creation key, no foreign key, no live charge", async () => {
    const id = await checkout(await newOrganization(), "PRO");
    await expect(confirm(id.id, { charge: null as unknown as string, key: "culqi:sxn:p1" })).rejects.toThrow(/verified Culqi charge id is required/);
    await expect(confirm(id.id, { charge: "chr_test_abc", key: "culqi:sxn:p1" })).rejects.toThrow(/activation key must be the Culqi charge id/);
    await expect(confirm(id.id, { charge: "sxn_test_notacharge" })).rejects.toThrow(/verified Culqi charge id is required/);
    await expect(confirm(id.id, { charge: "chr_live_abc" })).rejects.toThrow(/another Culqi environment/);
    expect(await billing(id.id)).toMatchObject({ status: "PENDING" });
  });

  it("a renewal charge extends the period; a late older charge never shortens it", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "BASIC");
    const now = Date.now();
    const day = 24 * 3600_000;
    await confirm(id.id, { charge: "chr_test_renew1", period: 1, start: new Date(now).toISOString(), end: new Date(now + 30 * day).toISOString() });
    const renewal = await confirm(id.id, { charge: "chr_test_renew2", period: 2, start: new Date(now).toISOString(), end: new Date(now + 60 * day).toISOString() });
    expect(renewal.outcome).toBe("RENEWED");
    const end = (await openSubscription(org))?.current_period_end.getTime();
    expect(end).toBeGreaterThan(now + 59 * day);

    // An older charge processed late (out of order): nothing shortened, nothing recorded.
    const late = await confirm(id.id, { charge: "chr_test_renew0", period: 0, start: new Date(now - 30 * day).toISOString(), end: new Date(now + 2 * day).toISOString() });
    expect(late.outcome).toBe("ALREADY_COVERED");
    expect((await openSubscription(org))?.current_period_end.getTime()).toBe(end);
    expect(await payments(org)).toBe(2);
  });

  it("a repeated old charge does not clear a newer PAST_DUE (provider status untouched on DUPLICATE)", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    await confirm(id.id, { charge: "chr_test_pd1" });
    expect(await failCharge(id.id, "chr_test_pd2")).toBe("RECORDED");
    expect(await billing(id.id)).toMatchObject({ status: "PAST_DUE" });
    expect((await confirm(id.id, { charge: "chr_test_pd1" })).outcome).toBe("DUPLICATE");
    expect(await billing(id.id)).toMatchObject({ status: "PAST_DUE" });
  });

  it.each([
    ["BASIC", "PRO"],
    ["BASIC", "BUSINESS"],
    ["PRO", "BUSINESS"]
  ] as const)("upgrade %s -> %s: new plan on its verified charge; the old Culqi subscription is superseded; its late charges are ignored", async (from, to) => {
    const org = await newOrganization();
    const old = await checkout(org, from);
    await confirm(old.id, { charge: `chr_test_up${from}${to}old` });
    expect(await organizationPlan(org)).toBe(from);

    // Pending upgrade: the plan does NOT change yet.
    const upgrade = await checkout(org, to);
    expect(await organizationPlan(org)).toBe(from);

    const result = await confirm(upgrade.id, { charge: `chr_test_up${from}${to}new` });
    expect(result.outcome).toBe("PLAN_CHANGED");
    expect(result.superseded_external_ids).toHaveLength(1);
    expect(await organizationPlan(org)).toBe(to);
    expect(await billing(old.id)).toMatchObject({ status: "CANCELED", cancel_reason: "UPGRADED" });

    // A late renewal charge of the replaced subscription never lowers the plan.
    expect((await confirm(old.id, { charge: `chr_test_up${from}${to}late` })).outcome).toBe("IGNORED");
    expect(await organizationPlan(org)).toBe(to);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs where organization_id = $1 and action = 'billing.subscription.superseded'", [org]))).toBe(1);
  });

  it("F4: a FAILED Culqi subscription of the organization is superseded too (cancelled at Culqi by the worker)", async () => {
    const org = await newOrganization();
    const failed = await checkout(org, "PRO");
    expect(await failCharge(failed.id, "chr_test_f4declined")).toBe("RECORDED");
    expect(await billing(failed.id)).toMatchObject({ status: "FAILED" });
    const retry = await checkout(org, "PRO");
    const result = await confirm(retry.id, { charge: "chr_test_f4ok" });
    expect(result.outcome).toBe("ACTIVATED");
    expect(result.superseded_external_ids).toHaveLength(1);
    expect(await billing(failed.id)).toMatchObject({ status: "CANCELED", cancel_reason: "UPGRADED" });
  });

  it("a legacy / manually paid organization can move to card payments (same plan or higher)", async () => {
    expect((await openSubscription(f.a.orgId))?.origin).toBe("ADMIN");
    const id = await checkout(f.a.orgId, "PRO");
    expect((await confirm(id.id, { charge: "chr_test_manualtocard" })).outcome).toBe("RENEWED");
    expect(await openSubscription(f.a.orgId)).toMatchObject({ origin: "CULQI", payment_method: "CULQI", plan: "PRO" });
  });

  it("mailboxes and other data are untouched by an activation (only the subscription changes)", async () => {
    const before = await t.asAdmin((tx) => count(tx, "select 1 from public.email_accounts where organization_id = $1", [f.b.orgId]));
    const id = await checkout(f.b.orgId, "BUSINESS");
    await confirm(id.id, { charge: "chr_test_orgbbusiness" });
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_accounts where organization_id = $1 and status <> 'DISCONNECTED'", [f.b.orgId]))).toBe(before);
    expect(await organizationPlan(f.b.orgId)).toBe("BUSINESS");
  });
});

describe("declined charges and provider-side states (access unchanged)", () => {
  it("initial charge declined: billing FAILED, payment recorded once as FAILED, no subscription, no access", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    expect(await failCharge(id.id, "chr_test_fail1")).toBe("RECORDED");
    expect(await failCharge(id.id, "chr_test_fail1")).toBe("DUPLICATE");
    // The same charge reported again under its webhook event id: still one record.
    expect(await failCharge(id.id, "evt_test_fail1", "chr_test_fail1")).toBe("DUPLICATE");
    expect(await billing(id.id)).toMatchObject({ status: "FAILED", failure_code: "card_declined" });
    expect(await openSubscription(org)).toBeNull();
    expect((await access(org)).access).toBe("NONE");
    expect(
      await t.asAdmin((tx) => one<{ payment_status: string; status: string }>(tx, "select payment_status, status from public.payment_events where external_payment_id = 'chr_test_fail1'"))
    ).toEqual({ payment_status: "FAILED", status: "PROCESSED" });
    expect(await payments(org)).toBe(1);

    // A declined charge is never activated afterwards.
    expect((await confirm(id.id, { charge: "chr_test_fail1" })).outcome).toBe("DUPLICATE");
    expect((await access(org)).access).toBe("NONE");
    // Culqi retries with a NEW charge that succeeds: activated (a FAILED row can still become ACTIVE).
    expect((await confirm(id.id, { charge: "chr_test_fail1retry" })).outcome).toBe("ACTIVATED");
    expect(await billing(id.id)).toMatchObject({ status: "ACTIVE", failure_code: null });
  });

  it("renewal declined: billing PAST_DUE, the paid subscription keeps its status and period (no policy yet)", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    await confirm(id.id, { charge: "chr_test_pdok" });
    const before = await openSubscription(org);
    expect(await failCharge(id.id, "chr_test_renewfail")).toBe("RECORDED");
    expect(await billing(id.id)).toMatchObject({ status: "PAST_DUE" });
    expect(await openSubscription(org)).toEqual(before);
    expect((await access(org)).access).toBe("SUBSCRIPTION");
  });

  it("cancellation by Culqi (or the user) and expiry are terminal; late charges cannot revive the row", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "BASIC");
    await confirm(id.id, { charge: "chr_test_cx1" });
    expect(await setStatus(id.id, "CANCELED", "PROVIDER")).toBe("CHANGED");
    expect(await billing(id.id)).toMatchObject({ status: "CANCELED", cancel_reason: "PROVIDER" });
    expect(await setStatus(id.id, "CANCELED")).toBe("UNCHANGED");
    expect(await setStatus(id.id, "PAST_DUE")).toBe("IGNORED");
    expect((await confirm(id.id, { charge: "chr_test_cx2" })).outcome).toBe("IGNORED");
    // The paid period is kept: access ends at its end (expiration sweep), not at the cancellation.
    expect((await access(org)).access).toBe("SUBSCRIPTION");

    const user = await checkout(await newOrganization(), "PRO");
    expect(await setStatus(user.id, "CANCELED", "USER")).toBe("CHANGED");
    expect(await billing(user.id)).toMatchObject({ status: "CANCELED", cancel_reason: "USER" });

    const expired = await checkout(await newOrganization(), "PRO");
    expect(await setStatus(expired.id, "EXPIRED")).toBe("CHANGED");
    expect(await setStatus(expired.id, "FAILED")).toBe("IGNORED");
  });

  it("F4: a PENDING checkout can be failed (confirmation_timeout) to free the organization", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    const result = await t.asService((tx) =>
      one<{ result: string }>(tx, "select public.billing_set_culqi_status($1, 'FAILED', 1::smallint, null, 'confirmation_timeout', null, 'req-timeout') as result", [id.id])
    );
    expect(result.result).toBe("CHANGED");
    expect(await billing(id.id)).toMatchObject({ status: "FAILED", failure_code: "confirmation_timeout" });
    await checkout(org, "PRO"); // a new checkout is possible again
  });

  it("ACTIVE / PENDING are never set directly (only a verified charge activates)", async () => {
    const id = await checkout(await newOrganization(), "PRO");
    await expect(setStatus(id.id, "ACTIVE")).rejects.toThrow(/confirmed payment/);
    await expect(setStatus(id.id, "PENDING")).rejects.toThrow(/confirmed payment/);
  });

  it("an activation needs the Culqi subscription to exist", async () => {
    const id = await checkout(await newOrganization(), "PRO", { sxn: null });
    await expect(confirm(id.id, { charge: "chr_test_nosxn" })).rejects.toThrow(/was not created/);
  });
});

describe("REVIEW_REQUIRED: a checkout whose charge stayed unconfirmed (20261016120300)", () => {
  const markReview = (billingId: string, code = "CULQI_UNCONFIRMED_REVIEW") =>
    t.asService((tx) => one<{ result: string }>(tx, "select public.billing_mark_culqi_review_required($1, $2, 'req-review') as result", [billingId, code])).then((row) => row.result);
  /** What the worker records on every unconfirmed reconciliation (direct update, service_role). */
  const noteUnconfirmed = (billingId: string, charge: string) =>
    t.asService((tx) =>
      tx.query(
        "update public.billing_subscriptions set last_reconciled_at = now(), last_charge_id = $2, last_outcome_type = 'tipo_desconocido', last_outcome_code = 'X0001', last_decline_code = null where id = $1",
        [billingId, charge]
      )
    );
  const review = (id: string) =>
    t.asAdmin((tx) =>
      one<{ status: string; failure_code: string | null; review_required_at: string | null; last_charge_id: string | null; last_outcome_code: string | null; canceled_at: string | null; cancel_reason: string | null }>(
        tx,
        "select status, failure_code, review_required_at, last_charge_id, last_outcome_code, canceled_at, cancel_reason from public.billing_subscriptions where id = $1",
        [id]
      )
    );

  it("A/B/C: PENDING blocks a new checkout; REVIEW_REQUIRED and FAILED do not", async () => {
    const org = await newOrganization();
    const pending = await checkout(org, "PRO");
    await expect(checkout(org, "PRO")).rejects.toThrow(/billing_subscriptions_one_pending/);
    expect(await markReview(pending.id)).toBe("CHANGED");
    const second = await checkout(org, "PRO"); // REVIEW_REQUIRED no longer blocks
    expect(await failCharge(second.id, "chr_test_rvblockfail")).toBe("RECORDED");
    await checkout(org, "PRO"); // FAILED does not block either
  });

  it("PENDING -> REVIEW_REQUIRED keeps every trace; only through its function; idempotent; never from another status", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    await noteUnconfirmed(id.id, "chr_test_rvtrace");
    await expect(setStatus(id.id, "REVIEW_REQUIRED")).rejects.toThrow(/billing_mark_culqi_review_required/);
    expect(await markReview(id.id)).toBe("CHANGED");
    expect(await review(id.id)).toMatchObject({ status: "REVIEW_REQUIRED", failure_code: "CULQI_UNCONFIRMED_REVIEW", last_charge_id: "chr_test_rvtrace", last_outcome_code: "X0001", canceled_at: null });
    expect((await review(id.id)).review_required_at).not.toBeNull();
    expect(await markReview(id.id)).toBe("UNCHANGED");
    const audit = await t.asAdmin((tx) =>
      one<{ metadata: Record<string, unknown> }>(tx, "select metadata from public.platform_audit_logs where action = 'billing.subscription.review_required' and target_id = $1", [id.id])
    );
    expect(audit.metadata).toMatchObject({ previousStatus: "PENDING", reviewCode: "CULQI_UNCONFIRMED_REVIEW", lastChargeId: "chr_test_rvtrace" });
    const failed = await checkout(org, "PRO");
    expect(await failCharge(failed.id, "chr_test_rvnotpending")).toBe("RECORDED");
    expect(await markReview(failed.id)).toBe("IGNORED");
    await expect(markReview(failed.id, "bad code")).rejects.toThrow(/review code/);
    await expect(
      t.asService((tx) => tx.query("update public.billing_subscriptions set last_charge_id = 'chr_live_X' where id = $1", [id.id]))
    ).rejects.toThrow(/billing_subscriptions_last_charge_id/);
  });

  it("J/L: a later verified charge activates a REVIEW_REQUIRED checkout when nothing changed since it began; once", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    expect(await markReview(id.id)).toBe("CHANGED");
    expect((await confirm(id.id, { charge: "chr_test_rvpaid" })).outcome).toBe("ACTIVATED");
    expect(await review(id.id)).toMatchObject({ status: "ACTIVE", failure_code: null });
    expect((await review(id.id)).review_required_at).not.toBeNull(); // kept for audit
    expect((await access(org)).effective_plan).toBe("PRO");
    expect((await confirm(id.id, { charge: "chr_test_rvpaid" })).outcome).toBe("DUPLICATE");
    expect(await payments(org)).toBe(1);
  });

  it("J: an upgrade under review (BÁSICO active before it began) is applied as an upgrade", async () => {
    const org = await newOrganization();
    const basic = await checkout(org, "BASIC");
    expect((await confirm(basic.id, { charge: "chr_test_rvbasic" })).outcome).toBe("ACTIVATED");
    const pro = await checkout(org, "PRO");
    expect(await markReview(pro.id)).toBe("CHANGED");
    expect((await confirm(pro.id, { charge: "chr_test_rvupgrade" })).outcome).toBe("PLAN_CHANGED");
    expect((await access(org)).effective_plan).toBe("PRO");
  });

  it("K/L: a later confirmed decline ends a REVIEW_REQUIRED checkout FAILED, recorded once", async () => {
    const org = await newOrganization();
    const id = await checkout(org, "PRO");
    expect(await markReview(id.id)).toBe("CHANGED");
    expect(await failCharge(id.id, "chr_test_rvdeclined")).toBe("RECORDED");
    expect(await review(id.id)).toMatchObject({ status: "FAILED", failure_code: "card_declined" });
    expect(await failCharge(id.id, "chr_test_rvdeclined")).toBe("DUPLICATE");
    expect(await payments(org)).toBe(1);
    expect(await access(org)).toMatchObject({ access: "NONE" });
  });

  it("M/N/O/P: a new checkout coexists with the old review (own row, own Culqi subscription); once it is ACTIVE the old charge cannot overwrite the plan (CONFLICT)", async () => {
    const org = await newOrganization();
    const basic = await checkout(org, "BASIC");
    expect((await confirm(basic.id, { charge: "chr_test_rvpbasic" })).outcome).toBe("ACTIVATED");
    const old = await checkout(org, "PRO");
    expect(await markReview(old.id)).toBe("CHANGED");
    const fresh = await checkout(org, "BUSINESS");
    const ids = await t.asAdmin((tx) =>
      tx.query<{ id: string; external_subscription_id: string }>("select id, external_subscription_id from public.billing_subscriptions where id = any($1)", [[old.id, fresh.id]])
    );
    expect(new Set(ids.rows.map((item) => item.external_subscription_id)).size).toBe(2);

    expect((await confirm(fresh.id, { charge: "chr_test_rvpnew" })).outcome).toBe("PLAN_CHANGED");
    expect(await review(old.id)).toMatchObject({ status: "REVIEW_REQUIRED", canceled_at: null, cancel_reason: null }); // not superseded / cancelled
    expect(await review(basic.id)).toMatchObject({ status: "CANCELED", cancel_reason: "UPGRADED" }); // the normal upgrade rule

    const before = await payments(org);
    expect((await confirm(old.id, { charge: "chr_test_rvplate" })).outcome).toBe("CONFLICT");
    expect(await review(old.id)).toMatchObject({ status: "REVIEW_REQUIRED" });
    expect((await access(org)).effective_plan).toBe("BUSINESS");
    expect(await payments(org)).toBe(before);
  });

  it("O: the organization's subscription changed after the review began (e.g. a manual payment): CONFLICT, nothing applied", async () => {
    const org = await newOrganization();
    const basic = await checkout(org, "BASIC");
    expect((await confirm(basic.id, { charge: "chr_test_rvmbasic" })).outcome).toBe("ACTIVATED");
    const pro = await checkout(org, "PRO");
    expect(await markReview(pro.id)).toBe("CHANGED");
    await t.asAdmin((tx) => tx.query("update public.subscriptions set updated_at = now() + interval '1 second' where organization_id = $1 and status = 'ACTIVE'", [org]));
    expect((await confirm(pro.id, { charge: "chr_test_rvmlate" })).outcome).toBe("CONFLICT");
    expect((await access(org)).effective_plan).toBe("BASIC");
  });

  it("REVIEW_REQUIRED can still end CANCELED / EXPIRED by Culqi (provider side), and is terminal there", async () => {
    const id = await checkout(await newOrganization(), "PRO");
    expect(await markReview(id.id)).toBe("CHANGED");
    expect(await setStatus(id.id, "CANCELED", "PROVIDER")).toBe("CHANGED");
    expect((await confirm(id.id, { charge: "chr_test_rvcanceled" })).outcome).toBe("IGNORED");
  });
});

describe("regression: catalog and entitlements unchanged", () => {
  it("prices and email account limits", async () => {
    const prices = await t.asAdmin((tx) =>
      tx.query<{ code: string; billing_period: string; amount: string }>(
        "select c.code, p.billing_period, p.amount::text from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id where p.active order by c.sort_order, p.billing_period"
      )
    );
    expect(prices.rows.map((row) => `${row.code} ${row.billing_period} ${row.amount}`)).toEqual([
      "BASIC MONTHLY 19.90",
      "BASIC YEARLY 199.00",
      "PRO MONTHLY 39.90",
      "PRO YEARLY 399.00",
      "BUSINESS MONTHLY 89.90",
      "BUSINESS YEARLY 899.00"
    ]);
    const limits = await t.asAdmin((tx) =>
      tx.query<{ code: string; limit_value: string }>(
        "select c.code, e.limit_value from public.plan_entitlements e join public.plan_catalog c on c.id = e.plan_id where e.key = 'EMAIL_ACCOUNTS' order by c.sort_order"
      )
    );
    expect(limits.rows.map((row) => Number(row.limit_value))).toEqual([25, 125, 250]);
  });
});
