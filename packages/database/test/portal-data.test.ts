import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 5: portal data functions (portal.list_inbox,
 * portal.get_email, portal.get_attachment) and manual deliveries
 * (public.add_manual_delivery, public.remove_manual_delivery).
 */

let t: TestDatabase;
let f: Fixtures;
let sequence = 0;
const hex = (label: string) => createHash("sha256").update(`${label}-${++sequence}`).digest("hex");

interface Tenant {
  orgId: string;
  botId: string;
  customerId: string;
  token: string;
}

let a: Tenant;
let b: Tenant;
let customerA2: string;
let tokenA2: string;
let botNoBody: string;
const emailsA: string[] = [];
const deliveriesA: string[] = [];
let deliveryB: string;
let emailB: string;
let attachmentA: string;
let attachmentInline: string;
let attachmentPending: string;
let attachmentB: string;

const id = async (tx: Tx, sql: string, params: unknown[]) => (await one<{ id: string }>(tx, `${sql} returning id`, params)).id;

async function insertEmail(tx: Tx, organizationId: string, accountId: string, botId: string | null, overrides: Record<string, unknown> = {}) {
  const values = {
    subject: "Tu código",
    sender_email: "info@netflix.example",
    text_body: "Tu código es 4821",
    html_body: "<p>Tu código es <b>4821</b></p>",
    extracted_data: { verification_code: "4821", internal_note: "secret-internal" },
    received_at: new Date(Date.now() - 60_000 * ++sequence).toISOString(),
    ...overrides
  };
  return id(
    tx,
    `insert into public.emails (organization_id, email_account_id, provider_message_id, bot_id, subject, sender_email, text_body, html_body, extracted_data, received_at, is_important)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [organizationId, accountId, `portal-${++sequence}`, botId, values.subject, values.sender_email, values.text_body, values.html_body, values.extracted_data, values.received_at, overrides.is_important ?? false]
  );
}

/** Credential + session for a customer; returns the session token hash. */
async function sessionFor(ownerId: string, customerId: string): Promise<string> {
  const secret = hex("secret");
  const token = hex("token");
  await t.asUser(ownerId, (tx) => tx.query("select * from public.issue_customer_access($1, $2, 'P417', 'SP', null)", [customerId, secret]));
  const login = await t.asService((tx) => one<{ outcome: string }>(tx, "select outcome from portal.create_session($1, $2, null, null)", [secret, token]));
  expect(login.outcome).toBe("OK");
  return token;
}

const inbox = (token: string, options: Record<string, unknown> = {}) =>
  t.asService(
    async (tx) =>
      (
        await tx.query<Record<string, unknown>>(
          "select * from portal.list_inbox($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [
            token,
            options.limit ?? 25,
            options.beforeAt ?? null,
            options.beforeId ?? null,
            options.bot ?? null,
            options.category ?? null,
            options.unread ?? null,
            options.important ?? null,
            options.from ?? null,
            options.to ?? null,
            options.search ?? null
          ]
        )
      ).rows
  );

const detail = (token: string, deliveryId: string) =>
  t.asService(async (tx) => (await one<{ detail: Record<string, any> | null }>(tx, "select portal.get_email($1, $2) as detail", [token, deliveryId])).detail);

const attachment = (token: string, deliveryId: string, attachmentId: string) =>
  t.asService(async (tx) => (await tx.query("select * from portal.get_attachment($1, $2, $3)", [token, deliveryId, attachmentId])).rows);

const deliver = (tx: Tx, organizationId: string, emailId: string, customerId: string, botId: string) =>
  id(
    tx,
    "insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution, created_at) values ($1, $2, $3, $4, 'AUTOMATIC', now() + make_interval(secs => $5))",
    [organizationId, emailId, customerId, botId, ++sequence]
  );

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  await t.asAdmin(async (tx) => {
    const settings = JSON.stringify({ showBody: true, showAttachments: true, fields: [{ key: "verification_code", label: "Código" }, { key: "missing", label: "Falta" }] });
    const botA = await id(tx, "insert into public.bots (organization_id, name, slug, portal_settings) values ($1, 'Netflix', 'netflix', $2)", [f.a.orgId, settings]);
    botNoBody = await id(tx, "insert into public.bots (organization_id, name, slug) values ($1, 'Yape', 'yape')", [f.a.orgId]);
    const botB = await id(tx, "insert into public.bots (organization_id, name, slug, portal_settings) values ($1, 'Netflix', 'netflix', $2)", [f.b.orgId, settings]);
    const customerA = await id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Juan')", [f.a.orgId]);
    customerA2 = await id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Ana')", [f.a.orgId]);
    const customerB = await id(tx, "insert into public.customers (organization_id, display_name) values ($1, 'Pedro')", [f.b.orgId]);
    for (const [organizationId, botId, customerId] of [
      [f.a.orgId, botA, customerA],
      [f.a.orgId, botNoBody, customerA],
      [f.a.orgId, botA, customerA2],
      [f.b.orgId, botB, customerB]
    ]) {
      await tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [organizationId, botId, customerId]);
    }

    for (let index = 0; index < 3; index++) {
      const emailId = await insertEmail(tx, f.a.orgId, f.a.accountId, botA, index === 0 ? { is_important: true, subject: "100% gratis_promo" } : {});
      emailsA.push(emailId);
      deliveriesA.push(await deliver(tx, f.a.orgId, emailId, customerA, botA));
    }
    const yapeEmail = await insertEmail(tx, f.a.orgId, f.a.accountId, botNoBody, { subject: "Yape" });
    emailsA.push(yapeEmail);
    deliveriesA.push(await deliver(tx, f.a.orgId, yapeEmail, customerA, botNoBody));

    emailB = await insertEmail(tx, f.b.orgId, f.b.accountId, botB, { subject: "Email B" });
    deliveryB = await deliver(tx, f.b.orgId, emailB, customerB, botB);

    const attach = (organizationId: string, emailId: string, name: string, inline: boolean, uploaded: boolean) =>
      id(
        tx,
        "insert into public.email_attachments (organization_id, email_id, filename, is_inline, created_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))",
        [organizationId, emailId, name, inline, ++sequence]
      ).then(
        async (attachmentId) => {
          if (uploaded) {
            await tx.query(
              "update public.email_attachments set storage_bucket = 'email-attachments', storage_path = $1, storage_uploaded = true where id = $2",
              [`${organizationId}/${emailId}/${attachmentId}/${name}`, attachmentId]
            );
          }
          return attachmentId;
        }
      );
    attachmentA = await attach(f.a.orgId, emailsA[0] as string, "factura.pdf", false, true);
    attachmentInline = await attach(f.a.orgId, emailsA[0] as string, "logo.png", true, true);
    attachmentPending = await attach(f.a.orgId, emailsA[0] as string, "pendiente.pdf", false, false);
    attachmentB = await attach(f.b.orgId, emailB, "b.pdf", false, true);

    a = { orgId: f.a.orgId, botId: botA, customerId: customerA, token: "" };
    b = { orgId: f.b.orgId, botId: botB, customerId: customerB, token: "" };
  });
  a.token = await sessionFor(f.a.ownerId, a.customerId);
  b.token = await sessionFor(f.b.ownerId, b.customerId);
  tokenA2 = await sessionFor(f.a.ownerId, customerA2);
});

afterAll(async () => {
  await t?.close();
});

describe("portal functions: who may execute them", () => {
  it("only the service role executes portal.list_inbox / get_email / get_attachment; nobody executes the internal helpers", async () => {
    const rows = await t.asAdmin((tx) =>
      tx.query<{ f: string; public_: boolean; anon: boolean; authenticated: boolean; service: boolean }>(
        `select n.nspname || '.' || p.proname as f,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') as public_,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname = 'portal' and p.proname in ('list_inbox', 'get_email', 'get_attachment'))
            or (n.nspname = 'private' and p.proname in ('portal_session_scope', 'portal_fields'))
         order by 1`
      )
    );
    expect(rows.rows).toEqual([
      { f: "portal.get_attachment", public_: false, anon: false, authenticated: false, service: true },
      { f: "portal.get_email", public_: false, anon: false, authenticated: false, service: true },
      { f: "portal.list_inbox", public_: false, anon: false, authenticated: false, service: true },
      { f: "private.portal_fields", public_: false, anon: false, authenticated: false, service: false },
      { f: "private.portal_session_scope", public_: false, anon: false, authenticated: false, service: false }
    ]);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select * from portal.list_inbox($1)", [a.token]))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select portal.get_email($1, $2)", [a.token, deliveriesA[0]]))).rejects.toThrow(/permission denied/);
  });

  it("an invalid, unknown or malformed token returns nothing", async () => {
    expect(await inbox(hex("unknown"))).toEqual([]);
    expect(await inbox("not-a-hash")).toEqual([]);
    expect(await detail(hex("unknown"), deliveriesA[0] as string)).toBeNull();
    expect(await attachment(hex("unknown"), deliveriesA[0] as string, attachmentA)).toEqual([]);
  });
});

describe("portal inbox: scope and isolation", () => {
  it("customer A sees only its deliveries, newest RECEIVED email first, with no internal ids", async () => {
    const rows = await inbox(a.token);
    // Fixtures: each email is received earlier than the previous one (deliveries in the opposite order).
    expect(rows.map((row) => row.delivery_id)).toEqual(deliveriesA);
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ["bot_name", "bot_slug", "category_name", "category_slug", "delivered_at", "delivery_id", "fields", "has_attachments", "is_important", "is_read", "received_at", "sender_email", "sender_name", "subject"].sort()
    );
    expect(JSON.stringify(rows)).not.toContain(a.customerId);
    expect(JSON.stringify(rows)).not.toContain(a.orgId);
    expect(JSON.stringify(rows)).not.toContain("secret-internal");
  });

  it("customer B sees only B; customer A2 (same organization) sees nothing of A", async () => {
    expect((await inbox(b.token)).map((row) => row.delivery_id)).toEqual([deliveryB]);
    expect(await inbox(tokenA2)).toEqual([]);
  });

  it("filters only narrow the customer's scope (a bot slug of B adds nothing)", async () => {
    expect((await inbox(a.token, { bot: "yape" })).map((row) => row.subject)).toEqual(["Yape"]);
    expect((await inbox(b.token, { bot: "yape" }))).toEqual([]);
    expect((await inbox(a.token, { important: true })).map((row) => row.delivery_id)).toEqual([deliveriesA[0]]);
    expect((await inbox(a.token, { search: "100%" })).map((row) => row.delivery_id)).toEqual([deliveriesA[0]]);
    expect(await inbox(a.token, { search: "%" })).toHaveLength(1); // a literal percent, not a wildcard
    expect(await inbox(a.token, { search: "_" })).toHaveLength(1);
    expect(await inbox(a.token, { from: new Date(Date.now() + 60_000).toISOString() })).toEqual([]);
  });

  it("keyset pagination is stable and complete", async () => {
    const first = await inbox(a.token, { limit: 2 });
    const last = first.at(-1) as Record<string, unknown>;
    const second = await inbox(a.token, { limit: 2, beforeAt: last.received_at, beforeId: last.delivery_id });
    expect([...first, ...second].map((row) => row.delivery_id)).toEqual(deliveriesA);
    await expect(inbox(a.token, { beforeAt: new Date().toISOString() })).rejects.toThrow(/Invalid cursor/);
    expect(await inbox(a.token, { limit: 1000 })).toHaveLength(4); // capped at 51
  });
});

describe("portal email detail and portal settings", () => {
  it("returns only the configured fields (missing = null), the body when showBody, and marks it read", async () => {
    const before = await inbox(a.token, { unread: true });
    const email = await detail(a.token, deliveriesA[1] as string);
    expect(email).toMatchObject({
      deliveryId: deliveriesA[1],
      bot: { name: "Netflix", slug: "netflix" },
      read: true,
      fields: [
        { key: "verification_code", label: "Código", value: "4821" },
        { key: "missing", label: "Falta", value: null }
      ],
      body: { text: "Tu código es 4821", html: "<p>Tu código es <b>4821</b></p>" }
    });
    expect(JSON.stringify(email)).not.toContain("secret-internal");
    expect(Object.keys(email as object)).not.toEqual(expect.arrayContaining(["matchedRuleId", "extractedData", "organizationId", "customerId"]));
    const after = await inbox(a.token, { unread: true });
    expect(after).toHaveLength(before.length - 1);
  });

  it("default portal settings: no body, no attachments, no fields", async () => {
    const email = await detail(a.token, deliveriesA[3] as string);
    expect(email).toMatchObject({ subject: "Yape", body: null, attachments: null, fields: [] });
    expect((await inbox(a.token, { bot: "yape" }))[0]).toMatchObject({ fields: [], has_attachments: false });
  });

  it("attachments: only non-inline ones are listed; only stored ones are downloadable", async () => {
    const email = await detail(a.token, deliveriesA[0] as string);
    expect((email?.attachments as Array<{ filename: string; available: boolean }>).map((item) => [item.filename, item.available])).toEqual([
      ["factura.pdf", true],
      ["pendiente.pdf", false]
    ]);
    expect(await attachment(a.token, deliveriesA[0] as string, attachmentA)).toEqual([
      expect.objectContaining({ attachment_id: attachmentA, organization_id: a.orgId, storage_bucket: "email-attachments", filename: "factura.pdf" })
    ]);
    expect(await attachment(a.token, deliveriesA[0] as string, attachmentInline)).toEqual([]);
    expect(await attachment(a.token, deliveriesA[0] as string, attachmentPending)).toEqual([]);
    // An attachment of another email of the same customer through the wrong delivery.
    expect(await attachment(a.token, deliveriesA[1] as string, attachmentA)).toEqual([]);
  });

  it("showAttachments = false hides the list and blocks the download", async () => {
    await t.asAdmin((tx) => tx.query(`update public.bots set portal_settings = portal_settings || '{"showAttachments": false}' where id = $1`, [a.botId]));
    try {
      expect((await detail(a.token, deliveriesA[0] as string))?.attachments).toBeNull();
      expect(await attachment(a.token, deliveriesA[0] as string, attachmentA)).toEqual([]);
    } finally {
      await t.asAdmin((tx) => tx.query(`update public.bots set portal_settings = portal_settings || '{"showAttachments": true}' where id = $1`, [a.botId]));
    }
  });

  it("cross-customer and cross-tenant access is indistinguishable from a missing delivery", async () => {
    expect(await detail(a.token, deliveryB)).toBeNull();
    expect(await detail(b.token, deliveriesA[0] as string)).toBeNull();
    expect(await detail(tokenA2, deliveriesA[0] as string)).toBeNull();
    expect(await detail(a.token, emailsA[0] as string)).toBeNull(); // an email id is not a delivery id
    expect(await attachment(a.token, deliveryB, attachmentB)).toEqual([]);
    expect(await attachment(a.token, deliveriesA[0] as string, attachmentB)).toEqual([]);
    expect(await attachment(b.token, deliveriesA[0] as string, attachmentA)).toEqual([]);
  });
});

describe("portal: states", () => {
  it("bot PAUSED: no new deliveries, but the history stays visible", async () => {
    await t.asAdmin((tx) => tx.query("update public.bots set status = 'PAUSED' where id = $1", [a.botId]));
    try {
      expect(await inbox(a.token, { bot: "netflix" })).toHaveLength(3);
      expect(await detail(a.token, deliveriesA[0] as string)).not.toBeNull();
      const extra = await t.asAdmin((tx) => insertEmail(tx, a.orgId, f.a.accountId, a.botId));
      await expect(
        t.asService((tx) =>
          tx.query("insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution) values ($1, $2, $3, $4, 'AUTOMATIC')", [
            a.orgId,
            extra,
            a.customerId,
            a.botId
          ])
        )
      ).rejects.toThrow(/Bot is not active/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bots set status = 'ACTIVE' where id = $1", [a.botId]));
    }
  });

  it("organization SUSPENDED: inbox, detail and attachments return nothing; B unaffected", async () => {
    await t.asAdmin((tx) => tx.query("update public.organizations set status = 'SUSPENDED' where id = $1", [a.orgId]));
    try {
      expect(await inbox(a.token)).toEqual([]);
      expect(await detail(a.token, deliveriesA[0] as string)).toBeNull();
      expect(await attachment(a.token, deliveriesA[0] as string, attachmentA)).toEqual([]);
      expect(await inbox(b.token)).toHaveLength(1);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.organizations set status = 'ACTIVE' where id = $1", [a.orgId]));
    }
    expect(await inbox(a.token)).toHaveLength(4);
  });

  it("revoked or expired sessions return nothing", async () => {
    const token = await sessionFor(f.a.ownerId, customerA2);
    await t.asAdmin((tx) => tx.query("update public.customer_sessions set idle_expires_at = now() - interval '1 second' where token_hash = $1", [token]));
    expect(await inbox(token)).toEqual([]);
    await t.asService((tx) => tx.query("select * from portal.end_session($1)", [tokenA2]));
    expect(await inbox(tokenA2)).toEqual([]);
    tokenA2 = await sessionFor(f.a.ownerId, customerA2);
  });

  it("customer SUSPENDED: sessions revoked and nothing readable (history kept)", async () => {
    const token = await sessionFor(f.a.ownerId, customerA2);
    await t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA2]));
    try {
      expect(await inbox(token)).toEqual([]);
    } finally {
      await t.asUser(f.a.ownerId, (tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA2]));
    }
    expect(await inbox(token)).toEqual([]); // the session was revoked, not just hidden
    tokenA2 = await sessionFor(f.a.ownerId, customerA2);
  });
});

describe("manual deliveries", () => {
  const add = (userId: string, emailId: string, customerId: string) =>
    t.asUser(userId, (tx) => one<{ delivery_id: string; outcome: string; resolution: string }>(tx, "select * from public.add_manual_delivery($1, $2)", [emailId, customerId]));
  const remove = (userId: string, deliveryId: string) =>
    t.asUser(userId, (tx) => one<{ delivery_id: string; removed: boolean }>(tx, "select * from public.remove_manual_delivery($1)", [deliveryId]));

  it("OPERATOR delivers an email manually to an assigned, active customer (MANUAL, author recorded)", async () => {
    const created = await add(f.a.operatorId, emailsA[0] as string, customerA2);
    expect(created).toMatchObject({ outcome: "CREATED", resolution: "MANUAL" });
    const row = await t.asAdmin((tx) => one<{ resolution: string; created_by: string }>(tx, "select resolution, created_by from public.email_deliveries where id = $1", [created.delivery_id]));
    expect(row).toEqual({ resolution: "MANUAL", created_by: f.a.operatorId });
    expect((await inbox(tokenA2)).map((item) => item.delivery_id)).toEqual([created.delivery_id]);
    expect(await add(f.a.operatorId, emailsA[0] as string, customerA2)).toMatchObject({ outcome: "EXISTING", delivery_id: created.delivery_id });
    expect(await add(f.a.ownerId, emailsA[0] as string, a.customerId)).toMatchObject({ outcome: "EXISTING", resolution: "AUTOMATIC" });
  });

  it("removal is soft, MANUAL only, and hides the email from the portal; delivering again reactivates the row", async () => {
    const created = await add(f.a.adminId, emailsA[1] as string, customerA2);
    expect(await remove(f.a.operatorId, created.delivery_id)).toMatchObject({ removed: true });
    expect(await remove(f.a.operatorId, created.delivery_id)).toMatchObject({ removed: false });
    expect((await inbox(tokenA2)).map((item) => item.delivery_id)).not.toContain(created.delivery_id);
    expect(await detail(tokenA2, created.delivery_id)).toBeNull();
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where id = $1 and removed_at is not null", [created.delivery_id]))).toBe(1);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.emails where id = $1", [emailsA[1]]))).toBe(1);

    expect(await add(f.a.operatorId, emailsA[1] as string, customerA2)).toMatchObject({ outcome: "REACTIVATED", delivery_id: created.delivery_id });
    expect((await inbox(tokenA2)).map((item) => item.delivery_id)).toContain(created.delivery_id);
    await expect(remove(f.a.ownerId, deliveriesA[0] as string)).rejects.toThrow(/Only manual deliveries can be removed/);
  });

  it("same rules as automatic deliveries: no bot, inactive bot, inactive customer, no active assignment, other organization", async () => {
    const noBot = await t.asAdmin((tx) => insertEmail(tx, a.orgId, f.a.accountId, null));
    await expect(add(f.a.ownerId, noBot, a.customerId)).rejects.toThrow(/has no bot/);
    await expect(add(f.a.ownerId, emailsA[3] as string, customerA2)).rejects.toThrow(/not assigned to the bot/);
    await expect(add(f.a.ownerId, emailsA[0] as string, b.customerId)).rejects.toThrow(/Customer not found in this organization/);

    await t.asAdmin((tx) => tx.query("update public.bots set status = 'PAUSED' where id = $1", [a.botId]));
    try {
      await expect(add(f.a.ownerId, emailsA[2] as string, customerA2)).rejects.toThrow(/Bot is not active/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bots set status = 'ACTIVE' where id = $1", [a.botId]));
    }
    await t.asAdmin((tx) => tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA2]));
    try {
      await expect(add(f.a.ownerId, emailsA[2] as string, customerA2)).rejects.toThrow(/Customer is not active/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA2]));
    }
    await t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = false where bot_id = $1 and customer_id = $2", [a.botId, customerA2]));
    try {
      await expect(add(f.a.ownerId, emailsA[2] as string, customerA2)).rejects.toThrow(/not assigned to the bot/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = true where bot_id = $1 and customer_id = $2", [a.botId, customerA2]));
    }
  });

  it("reactivating a removed delivery re-checks eligibility in the database (any path)", async () => {
    const created = await add(f.a.ownerId, emailsA[2] as string, customerA2);
    await remove(f.a.ownerId, created.delivery_id);
    await t.asAdmin((tx) => tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA2]));
    try {
      await expect(
        t.asAdmin((tx) => tx.query("update public.email_deliveries set removed_at = null, removed_by = null where id = $1", [created.delivery_id]))
      ).rejects.toThrow(/Customer is not active/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA2]));
    }
  });

  it("VIEWER, other organizations and outsiders cannot add or remove (indistinguishable from missing)", async () => {
    for (const userId of [f.a.viewerId, f.b.ownerId, f.outsiderId]) {
      await expect(add(userId, emailsA[0] as string, customerA2)).rejects.toThrow(/Email not found/);
    }
    const created = await add(f.a.ownerId, emailsA[2] as string, customerA2);
    for (const userId of [f.a.viewerId, f.b.ownerId]) {
      await expect(remove(userId, created.delivery_id)).rejects.toThrow(/Delivery not found/);
    }
    await expect(add(f.b.ownerId, emailB, customerA2)).rejects.toThrow(/Customer not found in this organization/);
  });

  it("members still cannot write email_deliveries directly", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.email_deliveries set removed_at = now()"))).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("insert into public.email_deliveries (organization_id, email_id, customer_id, bot_id, resolution) values ($1, $2, $3, $4, 'MANUAL')", [
          a.orgId,
          emailsA[0],
          customerA2,
          a.botId
        ])
      )
    ).rejects.toThrow(/permission denied/);
  });
});

describe("phase 5.5: visibility follows the current assignment", () => {
  const setAssignment = (botId: string, customerId: string, active: boolean) =>
    t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = $3 where bot_id = $1 and customer_id = $2", [botId, customerId, active]));
  const filtersOf = async (token: string) =>
    (await t.asService((tx) => one<{ f: { bots: Array<{ name: string; slug: string }>; categories: Array<{ name: string; slug: string }> } | null }>(tx, "select portal.list_filters($1) as f", [token]))).f;

  it("assignment INACTIVE hides that bot's deliveries (inbox, detail, attachment, filters) without deleting anything", async () => {
    const before = await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where customer_id = $1", [a.customerId]));
    await setAssignment(a.botId, a.customerId, false);
    try {
      expect((await inbox(a.token)).map((row) => row.bot_slug)).toEqual(["yape"]);
      expect(await detail(a.token, deliveriesA[0] as string)).toBeNull();
      expect(await attachment(a.token, deliveriesA[0] as string, attachmentA)).toEqual([]);
      expect((await filtersOf(a.token))?.bots.map((bot) => bot.slug)).toEqual(["yape"]);
      expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_deliveries where customer_id = $1", [a.customerId]))).toBe(before);
      expect(await t.asAdmin((tx) => count(tx, "select 1 from public.emails where id = any($1)", [emailsA]))).toBe(emailsA.length);
      expect(await t.asAdmin((tx) => count(tx, "select 1 from public.email_attachments where id = $1", [attachmentA]))).toBe(1);
    } finally {
      await setAssignment(a.botId, a.customerId, true);
    }
    expect(await inbox(a.token)).toHaveLength(4);
    expect(await detail(a.token, deliveriesA[0] as string)).not.toBeNull();
  });

  it("bot PAUSED + assignment ACTIVE: history and filters stay available", async () => {
    await t.asAdmin((tx) => tx.query("update public.bots set status = 'PAUSED' where id = $1", [a.botId]));
    try {
      expect(await inbox(a.token, { bot: "netflix" })).toHaveLength(3);
      expect((await filtersOf(a.token))?.bots.map((bot) => bot.slug)).toEqual(["netflix", "yape"]);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bots set status = 'ACTIVE' where id = $1", [a.botId]));
    }
  });

  it("a MANUAL delivery of an old email keeps the email's original position", async () => {
    const recent = await t.asAdmin((tx) => insertEmail(tx, a.orgId, f.a.accountId, a.botId, { received_at: new Date(Date.now() - 60_000).toISOString(), subject: "reciente" }));
    const old = await t.asAdmin((tx) =>
      insertEmail(tx, a.orgId, f.a.accountId, a.botId, { received_at: new Date(Date.now() - 90 * 86_400_000).toISOString(), subject: "antiguo" })
    );
    await t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.add_manual_delivery($1, $2)", [recent, customerA2]));
    await t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.add_manual_delivery($1, $2)", [old, customerA2])); // delivered LAST
    const token = await sessionFor(f.a.ownerId, customerA2); // earlier suspensions revoked older sessions
    const subjects = (await inbox(token)).map((row) => row.subject);
    expect(subjects.indexOf("reciente")).toBeLessThan(subjects.indexOf("antiguo"));
    expect(subjects.at(-1)).toBe("antiguo");
  });

  it("list_filters: bots of active assignments and categories of visible deliveries; service role only", async () => {
    await t.asAdmin((tx) => tx.query("update public.emails set category_id = $1 where id = $2", [f.a.categoryId, emailsA[0]]));
    expect(await filtersOf(a.token)).toEqual({ bots: [{ name: "Netflix", slug: "netflix" }, { name: "Yape", slug: "yape" }], categories: [{ name: "Codes", slug: "codes" }] });
    expect(await filtersOf(b.token)).toEqual({ bots: [{ name: "Netflix", slug: "netflix" }], categories: [] });
    expect(await filtersOf(hex("unknown"))).toBeNull();
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select portal.list_filters($1)", [a.token]))).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select portal.list_filters($1)", [a.token]))).rejects.toThrow(/permission denied/);
  });
});

describe("phase 5.5: manual delivery functions, security matrix at the database layer", () => {
  let email: string;
  beforeAll(async () => {
    email = await t.asAdmin((tx) => insertEmail(tx, a.orgId, f.a.accountId, a.botId, { subject: "matrix" }));
  });
  const add = (userId: string, customerId = customerA2) =>
    t.asUser(userId, (tx) => one<{ delivery_id: string; outcome: string }>(tx, "select * from public.add_manual_delivery($1, $2)", [email, customerId]));
  const remove = (userId: string, deliveryId: string) =>
    t.asUser(userId, (tx) => one<{ removed: boolean }>(tx, "select * from public.remove_manual_delivery($1)", [deliveryId]));

  it.each(["ownerId", "adminId", "operatorId"] as const)("%s (deliveries:manage) may add and remove", async (who) => {
    const added = await add(f.a[who]);
    expect(["CREATED", "REACTIVATED"]).toContain(added.outcome);
    expect(await remove(f.a[who], added.delivery_id)).toEqual(expect.objectContaining({ removed: true }));
  });

  it("VIEWER, a user without membership and a member of another organization are denied (add and remove)", async () => {
    const added = await add(f.a.ownerId);
    for (const userId of [f.a.viewerId, f.outsiderId, f.b.ownerId]) {
      await expect(add(userId)).rejects.toThrow(/Email not found/);
      await expect(remove(userId, added.delivery_id)).rejects.toThrow(/Delivery not found/);
    }
    await remove(f.a.ownerId, added.delivery_id);
  });

  it("customer of another organization and email of another organization: denied", async () => {
    await expect(add(f.a.ownerId, b.customerId)).rejects.toThrow(/Customer not found in this organization/);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.add_manual_delivery($1, $2)", [emailB, customerA2]))).rejects.toThrow(
      /Email not found/
    );
  });

  it("bot of another organization: impossible, an email only carries a bot of its own organization (composite FK)", async () => {
    await expect(t.asAdmin((tx) => tx.query("update public.emails set bot_id = $1 where id = $2", [b.botId, email]))).rejects.toThrow(/foreign key/);
  });

  it("bot PAUSED, customer SUSPENDED, assignment INACTIVE: denied; everything ACTIVE: allowed", async () => {
    const cases: Array<[string, string, string]> = [
      ["update public.bots set status = 'PAUSED' where id = $1", "update public.bots set status = 'ACTIVE' where id = $1", a.botId],
      ["update public.customers set status = 'SUSPENDED' where id = $1", "update public.customers set status = 'ACTIVE' where id = $1", customerA2]
    ];
    for (const [breakSql, fixSql, target] of cases) {
      await t.asAdmin((tx) => tx.query(breakSql, [target]));
      try {
        await expect(add(f.a.ownerId)).rejects.toThrow(/not active/);
      } finally {
        await t.asAdmin((tx) => tx.query(fixSql, [target]));
      }
    }
    await t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = false where bot_id = $1 and customer_id = $2", [a.botId, customerA2]));
    try {
      await expect(add(f.a.ownerId)).rejects.toThrow(/not assigned/);
    } finally {
      await t.asAdmin((tx) => tx.query("update public.bot_customer_assignments set active = true where bot_id = $1 and customer_id = $2", [a.botId, customerA2]));
    }
    expect(["CREATED", "REACTIVATED"]).toContain((await add(f.a.ownerId)).outcome);
  });
});
