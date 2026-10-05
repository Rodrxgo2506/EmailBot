import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 1: bots, email_rules.bot_id, emails.bot_id and the
 * worker's column access to organizations.status.
 */

let t: TestDatabase;
let f: Fixtures;
let botA: string;
let botB: string;

const insertBot = (tx: Tx, organizationId: string, slug: string, createdBy: string | null = null) =>
  one<{ id: string }>(
    tx,
    "insert into public.bots (organization_id, name, slug, created_by) values ($1, $2, $2, $3) returning id",
    [organizationId, slug, createdBy]
  );

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  botA = (await t.asUser(f.a.ownerId, (tx) => insertBot(tx, f.a.orgId, "netflix", f.a.ownerId))).id;
  botB = (await t.asUser(f.b.ownerId, (tx) => insertBot(tx, f.b.orgId, "netflix", f.b.ownerId))).id;
});

afterAll(async () => {
  await t?.close();
});

describe("bots: RLS by role", () => {
  it("OWNER and ADMIN can create bots in their organization", async () => {
    await t.asUser(f.a.adminId, (tx) => insertBot(tx, f.a.orgId, "yape-admin", f.a.adminId));
    expect(await t.asUser(f.a.ownerId, (tx) => count(tx, "select 1 from public.bots where organization_id = $1", [f.a.orgId]))).toBe(2);
  });

  it.each(["operatorId", "viewerId"] as const)("%s cannot create, update or delete bots", async (who) => {
    const userId = f.a[who];
    await expect(t.asUser(userId, (tx) => insertBot(tx, f.a.orgId, `x-${who.toLowerCase()}`))).rejects.toThrow(/row-level security/);
    const updated = await t.asUser(userId, async (tx) => (await tx.query("update public.bots set name = 'x' where id = $1", [botA])).affectedRows);
    const deleted = await t.asUser(userId, async (tx) => (await tx.query("delete from public.bots where id = $1", [botA])).affectedRows);
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
  });

  it("every member reads the bots of its organization (VIEWER included)", async () => {
    expect(await t.asUser(f.a.viewerId, (tx) => count(tx, "select 1 from public.bots where id = $1", [botA]))).toBe(1);
  });

  it("created_by / updated_by cannot impersonate another user", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => insertBot(tx, f.a.orgId, "spoof", f.a.adminId))).rejects.toThrow(/row-level security/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.bots set updated_by = $1 where id = $2", [f.a.adminId, botA]))
    ).rejects.toThrow(/row-level security/);
  });

  it("organization_id cannot be changed (no UPDATE grant on the column)", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.bots set organization_id = $1 where id = $2", [f.b.orgId, botA]))
    ).rejects.toThrow(/permission denied/);
  });

  it("slug is unique per organization only", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => insertBot(tx, f.a.orgId, "netflix"))).rejects.toThrow(/bots_organization_slug_key/);
    // botB already uses "netflix" in organization B.
    expect(botB).not.toBe(botA);
  });

  it("documents default to an inert customer resolution and a closed portal", async () => {
    const row = await t.asUser(f.a.ownerId, (tx) =>
      one<{ status: string; customer_resolution: unknown; portal_settings: unknown }>(
        tx,
        "select status, customer_resolution, portal_settings from public.bots where id = $1",
        [botA]
      )
    );
    expect(row.status).toBe("ACTIVE");
    expect(row.customer_resolution).toEqual({ source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" });
    expect(row.portal_settings).toEqual({ showBody: false, showAttachments: false, fields: [] });
  });

  it("documents must be JSON objects", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.bots set portal_settings = '[]'::jsonb where id = $1", [botA]))
    ).rejects.toThrow(/bots_portal_settings_object/);
  });
});

describe("bots: tenant isolation", () => {
  it("members of another organization and outsiders see no bot", async () => {
    expect(await t.asUser(f.b.ownerId, (tx) => count(tx, "select 1 from public.bots where id = $1", [botA]))).toBe(0);
    expect(await t.asUser(f.outsiderId, (tx) => count(tx, "select 1 from public.bots"))).toBe(0);
  });

  it("an owner cannot create, update or delete bots of another organization", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => insertBot(tx, f.b.orgId, "intruder"))).rejects.toThrow(/row-level security/);
    const touched = await t.asUser(f.a.ownerId, async (tx) => {
      const updated = await tx.query("update public.bots set name = 'x' where id = $1", [botB]);
      const deleted = await tx.query("delete from public.bots where id = $1", [botB]);
      return (updated.affectedRows ?? 0) + (deleted.affectedRows ?? 0);
    });
    expect(touched).toBe(0);
  });

  it("anon has no access", async () => {
    await expect(t.asAnon((tx) => tx.query("select 1 from public.bots"))).rejects.toThrow(/permission denied/);
  });
});

describe("rules and emails reference only bots of their own organization (composite FK)", () => {
  it("OWNER/ADMIN can attach a rule to a bot of the same organization; OPERATOR cannot", async () => {
    await t.asUser(f.a.adminId, (tx) => tx.query("update public.email_rules set bot_id = $1 where id = $2", [botA, f.a.ruleId]));
    const operatorUpdates = await t.asUser(f.a.operatorId, async (tx) =>
      (await tx.query("update public.email_rules set bot_id = null where id = $1", [f.a.ruleId])).affectedRows
    );
    expect(operatorUpdates).toBe(0);
    expect(await t.asUser(f.a.viewerId, (tx) => one<{ bot_id: string }>(tx, "select bot_id from public.email_rules where id = $1", [f.a.ruleId]))).toEqual({
      bot_id: botA
    });
  });

  it("a rule cannot reference a bot of another organization, not even as the table owner", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.email_rules set bot_id = $1 where id = $2", [botB, f.a.ruleId]))
    ).rejects.toThrow(/email_rules_bot_fkey/);
    await expect(
      t.asAdmin((tx) => tx.query("update public.email_rules set bot_id = $1 where id = $2", [botB, f.a.ruleId]))
    ).rejects.toThrow(/email_rules_bot_fkey/);
  });

  it("the worker (service role) can store emails.bot_id of the same organization only", async () => {
    await t.asService((tx) =>
      tx.query(
        `insert into public.emails (organization_id, email_account_id, bot_id, provider_message_id, sender_email, received_at)
         values ($1, $2, $3, 'bot-msg-1', 's@example.com', now())`,
        [f.a.orgId, f.a.accountId, botA]
      )
    );
    await expect(
      t.asService((tx) =>
        tx.query(
          `insert into public.emails (organization_id, email_account_id, bot_id, provider_message_id, sender_email, received_at)
           values ($1, $2, $3, 'bot-msg-2', 's@example.com', now())`,
          [f.a.orgId, f.a.accountId, botB]
        )
      )
    ).rejects.toThrow(/emails_bot_fkey/);
  });

  it("members cannot re-route an email (no UPDATE grant on emails.bot_id in phase 1)", async () => {
    await expect(
      t.asUser(f.a.ownerId, (tx) => tx.query("update public.emails set bot_id = null where organization_id = $1", [f.a.orgId]))
    ).rejects.toThrow(/permission denied/);
  });

  it("deleting a bot clears bot_id only and keeps rules, emails and their organization", async () => {
    const temp = await t.asUser(f.a.ownerId, (tx) => insertBot(tx, f.a.orgId, "temporary", f.a.ownerId));
    const rule = await t.asUser(f.a.ownerId, (tx) =>
      one<{ id: string }>(
        tx,
        `insert into public.email_rules (organization_id, bot_id, name, conditions, actions)
         values ($1, $2, 'Temp', '{"conditions":[{"field":"subject","operator":"contains","value":"x"}]}', '{"actions":[]}') returning id`,
        [f.a.orgId, temp.id]
      )
    );
    const email = await t.asService((tx) =>
      one<{ id: string }>(
        tx,
        `insert into public.emails (organization_id, email_account_id, bot_id, provider_message_id, sender_email, received_at)
         values ($1, $2, $3, 'bot-msg-temp', 's@example.com', now()) returning id`,
        [f.a.orgId, f.a.accountId, temp.id]
      )
    );

    await t.asUser(f.a.ownerId, (tx) => tx.query("delete from public.bots where id = $1", [temp.id]));

    await t.asAdmin(async (tx) => {
      expect(await one(tx, "select organization_id, bot_id from public.email_rules where id = $1", [rule.id])).toEqual({
        organization_id: f.a.orgId,
        bot_id: null
      });
      expect(await one(tx, "select organization_id, bot_id from public.emails where id = $1", [email.id])).toEqual({
        organization_id: f.a.orgId,
        bot_id: null
      });
    });
  });

  it("existing V1 rows keep bot_id = NULL (no backfill)", async () => {
    expect(await t.asAdmin((tx) => one(tx, "select bot_id from public.emails where id = $1", [f.b.emailId]))).toEqual({ bot_id: null });
    expect(await t.asAdmin((tx) => one(tx, "select bot_id from public.email_rules where id = $1", [f.b.ruleId]))).toEqual({ bot_id: null });
  });
});

describe("worker access (service role)", () => {
  it("reads organization status and bot status through joins, nothing else", async () => {
    const row = await t.asService((tx) =>
      one<{ organization_status: string; bot_status: string }>(
        tx,
        `select o.status as organization_status, b.status as bot_status
         from public.email_rules r
         join public.organizations o on o.id = r.organization_id
         join public.bots b on b.organization_id = r.organization_id and b.id = r.bot_id
         where r.id = $1`,
        [f.a.ruleId]
      )
    );
    expect(row).toEqual({ organization_status: "ACTIVE", bot_status: "ACTIVE" });
    await expect(t.asService((tx) => tx.query("select slug from public.organizations"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select portal_settings from public.bots"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("update public.bots set status = 'PAUSED'"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("update public.organizations set status = 'SUSPENDED'"))).rejects.toThrow(/permission denied/);
  });
});
