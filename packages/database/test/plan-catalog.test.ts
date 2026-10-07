import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, MIGRATIONS_DIR, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Commercial V1, phase 1: plan catalog, prices and entitlements
 * (20261006120000_organization_plan_basic.sql + 20261006120100_plan_catalog.sql).
 * The expected values are the approved V1 catalog.
 */

const COMMERCIAL_V1 = "20261006120000";
const GB = 1024 ** 3;

const LIMITS = {
  BASIC: { EMAIL_ACCOUNTS: 2, RULES: 10, BOTS: 2, MONTHLY_EMAILS: 2_000, MEMBERS: 2, CUSTOMERS: 500, STORAGE_BYTES: 1 * GB, RETENTION_DAYS: 30 },
  PRO: { EMAIL_ACCOUNTS: 5, RULES: 30, BOTS: 10, MONTHLY_EMAILS: 15_000, MEMBERS: 5, CUSTOMERS: 2_500, STORAGE_BYTES: 5 * GB, RETENTION_DAYS: 90 },
  BUSINESS: { EMAIL_ACCOUNTS: 20, RULES: 100, BOTS: 50, MONTHLY_EMAILS: 75_000, MEMBERS: 20, CUSTOMERS: 10_000, STORAGE_BYTES: 25 * GB, RETENTION_DAYS: 365 }
} as const;

const FEATURES = {
  BASIC: { GMAIL: true, MICROSOFT: false, ADVANCED_STATS: false, PORTAL: false, API: false, PRIORITY_SUPPORT: false },
  PRO: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: false, PRIORITY_SUPPORT: true },
  BUSINESS: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: true, PRIORITY_SUPPORT: true }
} as const;

type EntitlementRow = { plan: string | null; effective_plan: string | null; access: string; key: string | null; kind: string | null; limit_value: string | null; enabled: boolean | null };

async function entitlementsOf(tx: Tx, organizationId: string) {
  const rows = (await tx.query<EntitlementRow>("select * from public.organization_entitlements($1)", [organizationId])).rows;
  return {
    plan: rows[0]?.plan,
    effectivePlan: rows[0]?.effective_plan,
    access: rows[0]?.access,
    limits: Object.fromEntries(rows.filter((row) => row.kind === "LIMIT").map((row) => [row.key, Number(row.limit_value)])),
    features: Object.fromEntries(rows.filter((row) => row.kind === "FEATURE").map((row) => [row.key, row.enabled]))
  };
}

async function usageOf(tx: Tx, organizationId: string, keys: string[] | null = null) {
  const rows = (await tx.query<{ key: string; used: string }>("select * from public.organization_usage($1, $2)", [organizationId, keys])).rows;
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.used)]));
}

let t: TestDatabase;
let f: Fixtures;
let platformAdmin: string;

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  platformAdmin = await t.createUser("root@emailbot.test");
  await t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [platformAdmin]));
});
afterAll(async () => t?.close());

describe("catalog", () => {
  it("BASIC, PRO and BUSINESS exist (in this order); FREE is not a commercial plan", async () => {
    const rows = await t.asUser(f.a.ownerId, async (tx) =>
      (await tx.query<{ code: string; name: string; badge: string | null; active: boolean }>("select code, name, badge, active from public.plan_catalog order by sort_order")).rows
    );
    expect(rows).toEqual([
      { code: "BASIC", name: "Básico", badge: null, active: true },
      { code: "PRO", name: "Pro", badge: "Más elegido", active: true },
      { code: "BUSINESS", name: "Business", badge: null, active: true }
    ]);
    await expect(t.asAdmin((tx) => tx.query("insert into public.plan_catalog (code, name) values ('FREE', 'Free')"))).rejects.toThrow(/plan_catalog_not_legacy/);
  });

  it("the enum keeps FREE (legacy) and adds BASIC before PRO", async () => {
    const labels = await t.asAdmin(async (tx) =>
      (await tx.query<{ label: string }>("select unnest(enum_range(null::public.organization_plan))::text as label")).rows.map((row) => row.label)
    );
    expect(labels).toEqual(["FREE", "BASIC", "PRO", "BUSINESS"]);
  });
});

describe("prices (PEN, numeric, never float)", () => {
  it.each([
    ["BASIC", "MONTHLY", "19.90", 1990],
    ["BASIC", "YEARLY", "199.00", 19900],
    ["PRO", "MONTHLY", "39.90", 3990],
    ["PRO", "YEARLY", "399.00", 39900],
    ["BUSINESS", "MONTHLY", "89.90", 8990],
    ["BUSINESS", "YEARLY", "899.00", 89900]
  ])("%s %s = S/ %s (%d céntimos)", async (plan, period, amount, cents) => {
    const row = await t.asUser(f.a.ownerId, (tx) =>
      one<{ amount: string; amount_cents: number; currency: string; active: boolean; type: string }>(
        tx,
        `select p.amount::text as amount, p.amount_cents, p.currency, p.active, pg_typeof(p.amount)::text as type
         from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id
         where c.code = $1 and p.billing_period = $2 and p.active`,
        [plan, period]
      )
    );
    expect(row).toEqual({ amount, amount_cents: cents, currency: "PEN", active: true, type: "numeric" });
  });

  it("exactly six active prices; one active price per plan / period / currency; amounts are positive", async () => {
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.plan_prices where active"))).toBe(6);
    const basic = await t.asAdmin((tx) => one<{ id: string }>(tx, "select id from public.plan_catalog where code = 'BASIC'"));
    await expect(
      t.asAdmin((tx) => tx.query("insert into public.plan_prices (plan_id, billing_period, amount) values ($1, 'MONTHLY', 24.90)", [basic.id]))
    ).rejects.toThrow(/plan_prices_one_active_idx/);
    await expect(
      t.asAdmin((tx) => tx.query("insert into public.plan_prices (plan_id, billing_period, amount, active) values ($1, 'MONTHLY', 0, false)", [basic.id]))
    ).rejects.toThrow(/plan_prices_amount_positive/);
    // A price change is a new row once the old one is deactivated (rolled back here).
    await expect(
      t.asAdmin(async (tx) => {
        await tx.query("update public.plan_prices set active = false where plan_id = $1 and billing_period = 'MONTHLY'", [basic.id]);
        await tx.query("insert into public.plan_prices (plan_id, billing_period, amount) values ($1, 'MONTHLY', 24.90)", [basic.id]);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.plan_prices where active and amount = 19.90"))).toBe(1);
  });
});

describe("entitlements", () => {
  it.each(["BASIC", "PRO", "BUSINESS"] as const)("%s: every limit and feature", async (plan) => {
    const rows = await t.asAdmin(async (tx) =>
      (
        await tx.query<{ key: string; kind: string; limit_value: string | null; enabled: boolean | null }>(
          `select e.key, e.kind, e.limit_value, e.enabled from public.plan_entitlements e
           join public.plan_catalog c on c.id = e.plan_id where c.code = $1`,
          [plan]
        )
      ).rows
    );
    const limits = Object.fromEntries(rows.filter((row) => row.kind === "LIMIT").map((row) => [row.key, Number(row.limit_value)]));
    const features = Object.fromEntries(rows.filter((row) => row.kind === "FEATURE").map((row) => [row.key, row.enabled]));
    expect(limits).toEqual(LIMITS[plan]);
    expect(features).toEqual(FEATURES[plan]);
  });

  it("a LIMIT carries a number (NULL = unlimited), a FEATURE a boolean; keys are UPPER_SNAKE", async () => {
    const pro = await t.asAdmin((tx) => one<{ id: string }>(tx, "select id from public.plan_catalog where code = 'PRO'"));
    for (const sql of [
      "insert into public.plan_entitlements (plan_id, key, kind, enabled) values ($1, 'X_LIMIT', 'LIMIT', true)",
      "insert into public.plan_entitlements (plan_id, key, kind, limit_value) values ($1, 'X_FEATURE', 'FEATURE', 3)",
      "insert into public.plan_entitlements (plan_id, key, kind, limit_value) values ($1, 'X_NEGATIVE', 'LIMIT', -1)"
    ]) {
      await expect(t.asAdmin((tx) => tx.query(sql, [pro.id]))).rejects.toThrow(/plan_entitlements_value/);
    }
    await expect(
      t.asAdmin((tx) => tx.query("insert into public.plan_entitlements (plan_id, key, kind, limit_value) values ($1, 'bad key', 'LIMIT', 1)", [pro.id]))
    ).rejects.toThrow(/plan_entitlements_key_format/);
    // Extensible: a new feature or an unlimited limit is just a row (rolled back).
    await expect(
      t.asAdmin(async (tx) => {
        await tx.query("insert into public.plan_entitlements (plan_id, key, kind, enabled) values ($1, 'WHATSAPP', 'FEATURE', true)", [pro.id]);
        await tx.query("insert into public.plan_entitlements (plan_id, key, kind, limit_value) values ($1, 'API_CALLS', 'LIMIT', null)", [pro.id]);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
  });

  it("organization_entitlements: a new organization (no subscription) has no plan and no entitlement; members only", async () => {
    const user = await t.createUser("sin-suscripcion@d.test");
    const fresh = await t.asUser(user, (tx) => one<{ id: string }>(tx, "select public.create_organization('Sin Suscripcion', 'sin-suscripcion') as id"));
    const own = await t.asUser(user, (tx) => entitlementsOf(tx, fresh.id));
    expect(own).toEqual({ plan: null, effectivePlan: null, access: "NONE", limits: {}, features: {} });
    // The seeded tenants pay PRO.
    expect(await t.asUser(f.a.viewerId, (tx) => entitlementsOf(tx, f.a.orgId))).toEqual({ plan: "PRO", effectivePlan: "PRO", access: "SUBSCRIPTION", limits: LIMITS.PRO, features: FEATURES.PRO });
    // Tenant isolation: another organization's plan is invisible.
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select * from public.organization_entitlements($1)", [f.b.orgId]))).toBe(0);
    expect(await t.asUser(f.outsiderId, (tx) => count(tx, "select * from public.organization_entitlements($1)", [f.a.orgId]))).toBe(0);
  });

  it.each(["BASIC", "PRO", "BUSINESS"] as const)("an ACTIVE %s subscription grants exactly the %s entitlements", async (plan) => {
    const [activation] = (
      await t.asService((tx) =>
        tx.query<{ subscription_id: string }>(
          "select * from admin.activate_subscription($1, $2, $3, 'MONTHLY', 'CASH', 10, now(), now() + interval '1 month', null, null, null)",
          [platformAdmin, f.b.orgId, plan]
        )
      )
    ).rows;
    try {
      expect(await t.asUser(f.b.ownerId, (tx) => entitlementsOf(tx, f.b.orgId))).toEqual({
        plan,
        effectivePlan: plan,
        access: "SUBSCRIPTION",
        limits: LIMITS[plan],
        features: FEATURES[plan]
      });
    } finally {
      await t.asService((tx) => tx.query("select * from admin.update_subscription_status($1, $2, 'CANCEL', null, null)", [platformAdmin, activation?.subscription_id]));
    }
    expect((await t.asUser(f.b.ownerId, (tx) => entitlementsOf(tx, f.b.orgId))).access).toBe("NONE");
  });
});

describe("usage (organization_usage)", () => {
  it("counts what the limits measure, for the caller's organization only", async () => {
    await t.asAdmin(async (tx) => {
      await tx.query("insert into public.bots (organization_id, name, slug) values ($1, 'Activo', 'activo')", [f.a.orgId]);
      await tx.query("insert into public.bots (organization_id, name, slug, status) values ($1, 'Pausado', 'pausado', 'PAUSED')", [f.a.orgId]);
      await tx.query("insert into public.customers (organization_id, display_name) values ($1, 'Juan')", [f.a.orgId]);
      await tx.query("insert into public.customers (organization_id, display_name, status) values ($1, 'Ana', 'SUSPENDED')", [f.a.orgId]);
      await tx.query(
        `insert into public.email_accounts (organization_id, provider, email_address, status) values ($1, 'GMAIL', 'old@a.test', 'DISCONNECTED')`,
        [f.a.orgId]
      );
      await tx.query("update public.email_attachments set file_size = 1500, storage_uploaded = true where id = $1", [f.a.attachmentId]);
    });

    const usage = await t.asUser(f.a.viewerId, (tx) => usageOf(tx, f.a.orgId));
    expect(usage).toEqual({
      EMAIL_ACCOUNTS: 1, // the DISCONNECTED mailbox does not count
      RULES: 1,
      BOTS: 1, // ACTIVE only
      MEMBERS: 4,
      CUSTOMERS: 1, // ACTIVE only
      MONTHLY_EMAILS: 1,
      STORAGE_BYTES: 1500
    });
    expect(await t.asUser(f.a.viewerId, (tx) => usageOf(tx, f.a.orgId, ["RULES"]))).toEqual({ RULES: 1 });
    // Another organization: RLS hides everything.
    expect(await t.asUser(f.outsiderId, (tx) => usageOf(tx, f.a.orgId, ["EMAIL_ACCOUNTS", "MEMBERS"]))).toEqual({ EMAIL_ACCOUNTS: 0, MEMBERS: 0 });
  });

  it("MONTHLY_EMAILS counts the current month in the organization's time zone (UTC when the zone is unknown)", async () => {
    await t.asAdmin((tx) => tx.query("update public.organization_settings set timezone = 'Not/AZone' where organization_id = $1", [f.b.orgId]));
    try {
      expect(await t.asUser(f.b.ownerId, (tx) => usageOf(tx, f.b.orgId, ["MONTHLY_EMAILS"]))).toEqual({ MONTHLY_EMAILS: 1 });
      await t.asAdmin((tx) => tx.query("update public.emails set created_at = now() - interval '45 days' where organization_id = $1", [f.b.orgId]));
      expect(await t.asUser(f.b.ownerId, (tx) => usageOf(tx, f.b.orgId, ["MONTHLY_EMAILS"]))).toEqual({ MONTHLY_EMAILS: 0 });
    } finally {
      await t.asAdmin(async (tx) => {
        await tx.query("update public.organization_settings set timezone = 'America/Lima' where organization_id = $1", [f.b.orgId]);
        await tx.query("update public.emails set created_at = now() where organization_id = $1", [f.b.orgId]);
      });
    }
  });
});

describe("organizations: no plan without a subscription, FREE never assigned again", () => {
  it("a self-service organization starts WITHOUT a plan (no free BASIC)", async () => {
    const user = await t.createUser("nuevo@d.test");
    const created = await t.asUser(user, (tx) => one<{ id: string }>(tx, "select public.create_organization('Nueva D', 'nueva-d') as id"));
    expect(await t.asAdmin((tx) => one<{ plan: string | null }>(tx, "select plan from public.organizations where id = $1", [created.id]))).toEqual({ plan: null });
    expect((await t.asUser(user, (tx) => entitlementsOf(tx, created.id))).access).toBe("NONE");
  });

  it("the Super Admin creates organizations without a plan and can never assign FREE (nor any plan directly)", async () => {
    const owner = await t.createUser("owner@e.test");
    const created = await t.asService((tx) =>
      one<{ id: string }>(tx, "select admin.create_organization($1, 'Org E', 'org-e', null, $2, null) as id", [platformAdmin, owner])
    );
    expect(await t.asAdmin((tx) => one<{ plan: string | null }>(tx, "select plan from public.organizations where id = $1", [created.id]))).toEqual({ plan: null });

    const before = await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs"));
    await expect(
      t.asService((tx) => tx.query("select admin.create_organization($1, 'Org F', 'org-f', 'FREE', $2, null)", [platformAdmin, owner]))
    ).rejects.toThrow(/comes from a subscription/);
    await expect(
      t.asService((tx) => tx.query("select * from admin.update_organization($1, $2, 'FREE', null, null)", [platformAdmin, created.id]))
    ).rejects.toThrow(/comes from a subscription/);
    await expect(
      t.asService((tx) =>
        tx.query("select * from admin.activate_subscription($1, $2, 'FREE', 'MONTHLY', 'CASH', 10, now(), now() + interval '1 month', null, null, null)", [
          platformAdmin,
          created.id
        ])
      )
    ).rejects.toThrow(/no active price/);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.platform_audit_logs"))).toBe(before);
  });

  it("nobody sets organizations.plan directly, not even the table owner (it is the subscription cache)", async () => {
    for (const plan of ["FREE", "BUSINESS"]) {
      await expect(t.asAdmin((tx) => tx.query("update public.organizations set plan = $2 where id = $1", [f.a.orgId, plan]))).rejects.toThrow(
        /derived from the subscription/
      );
      await expect(
        t.asAdmin((tx) => tx.query("insert into public.organizations (name, slug, plan) values ('Libre', 'libre', $1)", [plan]))
      ).rejects.toThrow(/derived from the subscription/);
    }
  });

  it("members still cannot change the plan themselves", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.organizations set plan = 'BUSINESS' where id = $1", [f.a.orgId]))).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("catalog privileges", () => {
  it("authenticated reads the catalog but cannot write it; anon sees nothing", async () => {
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.plan_prices"))).toBe(6);
    for (const sql of [
      "update public.plan_prices set amount = 1",
      "delete from public.plan_catalog",
      "insert into public.plan_entitlements (plan_id, key, kind, enabled) select id, 'HACK', 'FEATURE', true from public.plan_catalog"
    ]) {
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
    await expect(t.asAnon((tx) => tx.query("select 1 from public.plan_catalog"))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select * from public.organization_entitlements($1)", [f.a.orgId]))).rejects.toThrow(/permission denied/);
  });

  it("service role (OAuth callback): entitlements and mailbox usage, nothing else", async () => {
    await t.asService(async (tx) => {
      expect((await entitlementsOf(tx, f.a.orgId)).access).toBe("SUBSCRIPTION");
      expect(await usageOf(tx, f.a.orgId, ["EMAIL_ACCOUNTS"])).toEqual({ EMAIL_ACCOUNTS: 1 });
    });
    await expect(t.asService((tx) => tx.query("select name from public.organizations"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("update public.plan_prices set amount = 1"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("update public.plan_entitlements set enabled = true"))).rejects.toThrow(/permission denied/);
  });

  it("service role (public catalog GET /api/plans): reads the active plans, prices and entitlements the API selects", async () => {
    await t.asService(async (tx) => {
      const plans = (await tx.query<{ code: string; badge: string | null }>("select code, name, description, badge, sort_order from public.plan_catalog where active order by sort_order")).rows;
      expect(plans.map((plan) => plan.code)).toEqual(["BASIC", "PRO", "BUSINESS"]);
      expect(plans.find((plan) => plan.code === "PRO")?.badge).toBe("Más elegido");
      const prices = (
        await tx.query<{ code: string; billing_period: string; amount: string; amount_cents: number }>(
          "select c.code, p.billing_period, p.currency, p.amount, p.amount_cents, p.active from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id where p.active order by c.sort_order, p.billing_period"
        )
      ).rows;
      expect(prices.filter((price) => price.billing_period === "MONTHLY").map((price) => [price.code, price.amount, price.amount_cents])).toEqual([
        ["BASIC", "19.90", 1990],
        ["PRO", "39.90", 3990],
        ["BUSINESS", "89.90", 8990]
      ]);
      expect(await count(tx, "select key, kind, limit_value, enabled from public.plan_entitlements")).toBe(42);
    });
  });
});

describe("legacy FREE organizations (created before Commercial V1)", () => {
  let legacy: TestDatabase;
  let owner: string;
  let orgId: string;
  let admin: string;

  beforeAll(async () => {
    legacy = await createTestDatabase({ stopBefore: COMMERCIAL_V1 });
    owner = await legacy.createUser("legacy@g.test");
    admin = await legacy.createUser("root@g.test");
    await legacy.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1)", [admin]));
    orgId = (await legacy.asUser(owner, (tx) => one<{ id: string }>(tx, "select public.create_organization('Antigua', 'antigua') as id"))).id;
    expect(await legacy.asAdmin((tx) => one<{ plan: string }>(tx, "select plan from public.organizations where id = $1", [orgId]))).toEqual({ plan: "FREE" });
    // Now the Commercial V1 migrations run over existing data, as in production.
    for (const file of listMigrationFiles().filter((name) => name >= COMMERCIAL_V1)) {
      await legacy.db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  });
  afterAll(async () => legacy?.close());

  it("keep plan = FREE (no silent change) and are entitled as BASIC (access LEGACY)", async () => {
    expect(await legacy.asAdmin((tx) => one<{ plan: string }>(tx, "select plan from public.organizations where id = $1", [orgId]))).toEqual({ plan: "FREE" });
    expect(await legacy.asUser(owner, (tx) => entitlementsOf(tx, orgId))).toEqual({
      plan: "FREE",
      effectivePlan: "BASIC",
      access: "LEGACY",
      limits: LIMITS.BASIC,
      features: FEATURES.BASIC
    });
  });

  it("keep working: renamed by their owner, suspended and reactivated by the Super Admin", async () => {
    await legacy.asUser(owner, (tx) => tx.query("update public.organizations set name = 'Antigua SAC' where id = $1", [orgId]));
    for (const status of ["SUSPENDED", "ACTIVE"]) {
      const [row] = (
        await legacy.asService((tx) => tx.query<{ plan: string; status: string }>("select * from admin.update_organization($1, $2, null, $3, null)", [admin, orgId, status]))
      ).rows;
      expect(row).toMatchObject({ plan: "FREE", status });
    }
  });

  it("the Super Admin moves them to a paid subscription, audited as coming from FREE", async () => {
    await legacy.asService((tx) =>
      tx.query("select * from admin.activate_subscription($1, $2, 'PRO', 'MONTHLY', 'YAPE', 39.90, now(), now() + interval '1 month', 'OP-1', null, 'req-legacy')", [
        admin,
        orgId
      ])
    );
    const audit = await legacy.asAdmin((tx) =>
      one<{ metadata: Record<string, unknown> }>(
        tx,
        "select metadata from public.platform_audit_logs where organization_id = $1 and action = 'subscription.activated' order by created_at desc limit 1",
        [orgId]
      )
    );
    expect(audit.metadata).toMatchObject({ plan: "PRO", previousOrganizationPlan: "FREE", paymentMethod: "YAPE" });
    expect(await legacy.asAdmin((tx) => one<{ plan: string }>(tx, "select plan from public.organizations where id = $1", [orgId]))).toEqual({ plan: "PRO" });
    expect((await legacy.asUser(owner, (tx) => entitlementsOf(tx, orgId))).access).toBe("SUBSCRIPTION");
    // Once no FREE row is left the foreign key can be validated.
    await legacy.asAdmin((tx) => tx.query("alter table public.organizations validate constraint organizations_plan_in_catalog"));
  });
});
