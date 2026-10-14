import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { activateSubscription, count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * IMAP phase E1 (20261014120000_imap_e1_security.sql):
 *   - members (authenticated) can no longer create mailboxes nor change the
 *     columns that drive a connection; only status (pause / resume) and
 *     display_name stay, with the API's status rules enforced by a trigger;
 *   - plan feature IMAP: PRO and BUSINESS only;
 *   - public.connect_imap_email_account: the only write of an IMAP mailbox.
 *
 * PGlite runs one transaction at a time: the overlapping-session races are
 * in scripts/imap-connect-concurrency-check.sh (real PostgreSQL).
 */

let t: TestDatabase;
let f: Fixtures;
let sequence = 0;

/** SecretBox v2 shape (iv 12 bytes, tag 16 bytes, base64url). The database never sees a real password. */
const V2 = "v2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Q0lQSEVSVEVYVA";
const V2_OTHER = "v2.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.T1RIRVI";

type Outcome = "CREATED" | "RECONNECTED" | "PLAN_LIMIT_REACHED" | "FEATURE_NOT_AVAILABLE" | "DUPLICATE_ACCOUNT";
interface Connection {
  outcome: Outcome;
  email_account_id: string | null;
  previous_status: string | null;
  used: number | null;
  limit_value: number | null;
}

interface ImapInput {
  email?: string;
  host?: string;
  port?: number;
  security?: string;
  username?: string;
  password?: string | null;
  cursor?: string | null;
  displayName?: string | null;
}

const SQL = "select * from public.connect_imap_email_account($1, $2, $3, $4, $5, $6, $7, $8, $9)";
const args = (organizationId: string, input: ImapInput = {}) => {
  const email = input.email ?? "ventas@example-mail.com";
  return [
    organizationId,
    email,
    input.displayName ?? null,
    input.username ?? email,
    input.host ?? "imap.example-mail.com",
    input.port ?? 993,
    input.security ?? "TLS",
    input.password === undefined ? V2 : input.password,
    input.cursor === undefined ? null : input.cursor
  ];
};

/** What the API's privileged layer does (service_role, PostgREST RPC). */
const connect = (organizationId: string, input: ImapInput = {}) => t.asService((tx) => one<Connection>(tx, SQL, args(organizationId, input)));

const row = (id: string) =>
  t.asAdmin((tx) =>
    one<{
      organization_id: string;
      provider: string;
      status: string;
      email_address: string;
      display_name: string | null;
      access_token_encrypted: string | null;
      refresh_token_encrypted: string | null;
      provider_metadata: Record<string, unknown>;
      sync_cursor: string | null;
      last_error_code: string | null;
    }>(tx, "select * from public.email_accounts where id = $1", [id])
  );

const rowsOf = (organizationId: string) =>
  t.asAdmin((tx) => count(tx, "select 1 from public.email_accounts where organization_id = $1", [organizationId]));

async function organization(plan: "BASIC" | "PRO" | "BUSINESS" | null): Promise<{ id: string; ownerId: string }> {
  sequence += 1;
  const ownerId = await t.createUser(`imap-owner-${sequence}@example.test`);
  const org = await t.asUser(ownerId, (tx) => one<{ id: string }>(tx, "select public.create_organization($1, $2) as id", [`Imap ${sequence}`, `imap-${sequence}`]));
  if (plan) await activateSubscription(t, org.id, plan);
  return { id: org.id, ownerId };
}

const setLimit = (plan: "PRO" | "BUSINESS", limit: number | null) =>
  t.asAdmin((tx) =>
    tx.query(
      `update public.plan_entitlements e set limit_value = $2
       from public.plan_catalog c where c.id = e.plan_id and c.code = $1 and e.key = 'EMAIL_ACCOUNTS'`,
      [plan, limit]
    )
  );

/** The worker's markError / the API's disconnectEmailAccount (service role). */
const markError = (id: string) =>
  t.asService((tx) => tx.query("update public.email_accounts set status = 'ERROR', last_error_code = 'IMAP_AUTH_FAILED' where id = $1", [id]));
const disconnect = (id: string) =>
  t.asService((tx) =>
    tx.query(
      `update public.email_accounts set status = 'DISCONNECTED', access_token_encrypted = null, refresh_token_encrypted = null,
         token_expires_at = null, sync_cursor = null, last_error_code = null, last_error_message = null where id = $1`,
      [id]
    )
  );
const setCursor = (id: string, cursor: string) => t.asService((tx) => tx.query("update public.email_accounts set sync_cursor = $2 where id = $1", [id, cursor]));

beforeAll(async () => {
  t = await createTestDatabase({ defaultPrivileges: "production" });
  f = await seedTwoTenants(t);
});
afterAll(async () => t?.close());

describe("email_accounts: least privilege for members (Data API)", () => {
  it("authenticated keeps only SELECT (no credentials), UPDATE (status, display_name) and DELETE", async () => {
    const privileges = await t.asAdmin(async (tx) => ({
      table: (
        await tx.query<{ privilege_type: string }>(
          "select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'email_accounts' and grantee = 'authenticated' order by 1"
        )
      ).rows.map((r) => r.privilege_type),
      update: (
        await tx.query<{ column_name: string }>(
          "select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'email_accounts' and grantee = 'authenticated' and privilege_type = 'UPDATE' order by 1"
        )
      ).rows.map((r) => r.column_name),
      insert: (
        await tx.query<{ column_name: string }>(
          "select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'email_accounts' and grantee = 'authenticated' and privilege_type = 'INSERT'"
        )
      ).rows.map((r) => r.column_name),
      select: (
        await tx.query<{ column_name: string }>(
          "select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'email_accounts' and grantee = 'authenticated' and privilege_type = 'SELECT'"
        )
      ).rows.map((r) => r.column_name)
    }));
    expect(privileges.table).toEqual(["DELETE"]);
    expect(privileges.update).toEqual(["display_name", "status"]);
    expect(privileges.insert).toEqual([]);
    expect(privileges.select).not.toContain("access_token_encrypted");
    expect(privileges.select).not.toContain("refresh_token_encrypted");
  });

  it.each([
    ["provider", "update public.email_accounts set provider = 'IMAP' where id = $1"],
    ["email_address", "update public.email_accounts set email_address = 'other@a.test' where id = $1"],
    ["provider_metadata (an IMAP host)", `update public.email_accounts set provider_metadata = '{"imap":{"host":"169.254.169.254","port":993}}' where id = $1`],
    ["sync_cursor", "update public.email_accounts set sync_cursor = '1' where id = $1"],
    ["last_synced_at", "update public.email_accounts set last_synced_at = now() where id = $1"],
    ["last_error_code", "update public.email_accounts set last_error_code = null where id = $1"],
    ["last_error_message", "update public.email_accounts set last_error_message = null where id = $1"],
    ["provider_account_id", "update public.email_accounts set provider_account_id = 'x' where id = $1"],
    ["token_expires_at", "update public.email_accounts set token_expires_at = now() where id = $1"],
    ["access_token_encrypted", "update public.email_accounts set access_token_encrypted = 'v1.x.y.z' where id = $1"],
    ["refresh_token_encrypted", "update public.email_accounts set refresh_token_encrypted = 'v1.x.y.z' where id = $1"],
    ["organization_id", "update public.email_accounts set organization_id = organization_id where id = $1"]
  ])("OWNER and ADMIN cannot change %s", async (_column, sql) => {
    for (const userId of [f.a.ownerId, f.a.adminId]) {
      await expect(t.asUser(userId, (tx) => tx.query(sql, [f.a.accountId]))).rejects.toThrow(/permission denied/);
    }
  });

  it("OWNER and ADMIN cannot create mailboxes directly (any provider)", async () => {
    for (const userId of [f.a.ownerId, f.a.adminId]) {
      for (const provider of ["GMAIL", "MICROSOFT", "IMAP"]) {
        await expect(
          t.asUser(userId, (tx) =>
            tx.query("insert into public.email_accounts (organization_id, provider, email_address, status) values ($1, $2::public.email_provider, $3, 'PAUSED')", [
              f.a.orgId,
              provider,
              `direct-${provider.toLowerCase()}@a.test`
            ])
          )
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("the API's legitimate member writes still work: rename, pause, resume (OWNER and ADMIN)", async () => {
    for (const userId of [f.a.ownerId, f.a.adminId]) {
      const renamed = await t.asUser(userId, async (tx) => (await tx.query("update public.email_accounts set display_name = 'Ventas' where id = $1", [f.a.accountId])).affectedRows);
      const paused = await t.asUser(userId, async (tx) => (await tx.query("update public.email_accounts set status = 'PAUSED' where id = $1", [f.a.accountId])).affectedRows);
      const resumed = await t.asUser(userId, async (tx) => (await tx.query("update public.email_accounts set status = 'ACTIVE' where id = $1", [f.a.accountId])).affectedRows);
      expect([renamed, paused, resumed]).toEqual([1, 1, 1]);
    }
    expect((await row(f.a.accountId)).status).toBe("ACTIVE");
  });

  it("VIEWER and OPERATOR cannot manage mailboxes; another organization's mailbox is invisible", async () => {
    for (const userId of [f.a.viewerId, f.a.operatorId]) {
      const changed = await t.asUser(userId, async (tx) => (await tx.query("update public.email_accounts set display_name = 'x', status = 'PAUSED' where id = $1", [f.a.accountId])).affectedRows);
      expect(changed).toBe(0);
    }
    const foreign = await t.asUser(f.a.ownerId, async (tx) => (await tx.query("update public.email_accounts set status = 'PAUSED' where id = $1", [f.b.accountId])).affectedRows);
    expect(foreign).toBe(0);
    const deleted = await t.asUser(f.a.ownerId, async (tx) => (await tx.query("delete from public.email_accounts where id = $1", [f.b.accountId])).affectedRows);
    expect(deleted).toBe(0);
    expect((await row(f.b.accountId)).status).toBe("ACTIVE");
  });

  it("members can only pause / resume: ERROR, DISCONNECTED and resuming a disconnected mailbox are refused", async () => {
    for (const status of ["ERROR", "DISCONNECTED"]) {
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(`update public.email_accounts set status = '${status}' where id = $1`, [f.a.accountId]))).rejects.toThrow(
        /Only pausing and resuming/
      );
    }
    const old = await t.asAdmin((tx) =>
      one<{ id: string }>(tx, "insert into public.email_accounts (organization_id, provider, email_address, status) values ($1, 'GMAIL', 'gone@a.test', 'DISCONNECTED') returning id", [f.a.orgId])
    );
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.email_accounts set status = 'ACTIVE' where id = $1", [old.id]))).rejects.toThrow(/must be connected again/);
    // Renaming a disconnected mailbox is still allowed (status unchanged).
    expect(await t.asUser(f.a.ownerId, async (tx) => (await tx.query("update public.email_accounts set display_name = 'Antigua' where id = $1", [old.id])).affectedRows)).toBe(1);
  });

  it("a member cannot resume an IMAP mailbox while IMAP synchronization does not exist", async () => {
    const created = await connect(f.a.orgId, { email: "resume@a-mail.com" });
    expect(created.outcome).toBe("CREATED");
    const id = created.email_account_id as string;
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("update public.email_accounts set status = 'ACTIVE' where id = $1", [id]))).rejects.toThrow(
      /IMAP synchronization is not available yet/
    );
    expect((await row(id)).status).toBe("PAUSED");
    await disconnect(id);
  });

  it("the service role (API privileged layer, worker) keeps its operational writes", async () => {
    await t.asService(async (tx) => {
      await tx.query("update public.email_accounts set status = 'ERROR', last_error_code = 'AUTH_REVOKED' where id = $1", [f.a.accountId]);
      await tx.query("update public.email_accounts set status = 'ACTIVE', last_error_code = null, sync_cursor = '42', last_synced_at = now() where id = $1", [f.a.accountId]);
    });
    expect((await row(f.a.accountId)).sync_cursor).toBe("42");
  });
});

describe("plan feature IMAP", () => {
  it("PRO and BUSINESS: enabled; BASIC: disabled; every other entitlement unchanged", async () => {
    const rows = await t.asAdmin(
      async (tx) =>
        (
          await tx.query<{ code: string; key: string; kind: string; limit_value: string | null; enabled: boolean | null }>(
            "select c.code, e.key, e.kind, e.limit_value, e.enabled from public.plan_entitlements e join public.plan_catalog c on c.id = e.plan_id order by c.code::text, e.key"
          )
        ).rows
    );
    expect(rows.filter((r) => r.key === "IMAP").map((r) => [r.code, r.kind, r.enabled])).toEqual([
      ["BASIC", "FEATURE", false],
      ["BUSINESS", "FEATURE", true],
      ["PRO", "FEATURE", true]
    ]);
    expect(rows.filter((r) => r.key === "GMAIL").map((r) => [r.code, r.enabled])).toEqual([
      ["BASIC", true],
      ["BUSINESS", true],
      ["PRO", true]
    ]);
    expect(rows.filter((r) => r.key === "MICROSOFT").map((r) => [r.code, r.enabled])).toEqual([
      ["BASIC", false],
      ["BUSINESS", true],
      ["PRO", true]
    ]);
  });

  it("it is visible through public.organization_entitlements like every feature", async () => {
    const pro = await organization("PRO");
    const basic = await organization("BASIC");
    const feature = (orgId: string) =>
      t.asService((tx) => one<{ enabled: boolean }>(tx, "select enabled from public.organization_entitlements($1) where key = 'IMAP'", [orgId]));
    expect((await feature(pro.id)).enabled).toBe(true);
    expect((await feature(basic.id)).enabled).toBe(false);
  });
});

describe("public.connect_imap_email_account", () => {
  it("SECURITY DEFINER, empty search_path, EXECUTE only for service_role", async () => {
    const fn = await t.asAdmin((tx) =>
      one<{ prosecdef: boolean; proconfig: string[] }>(
        tx,
        "select prosecdef, proconfig from pg_proc where oid = 'public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)'::regprocedure"
      )
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=""']);
    const before = await rowsOf(f.a.orgId);
    for (const run of [(sql: string, values: unknown[]) => t.asUser(f.a.ownerId, (tx) => tx.query(sql, values)), (sql: string, values: unknown[]) => t.asAnon((tx) => tx.query(sql, values))]) {
      await expect(run(SQL, args(f.a.orgId, { email: "denied@a-mail.com" }))).rejects.toThrow(/permission denied for function connect_imap_email_account/);
    }
    expect(await rowsOf(f.a.orgId)).toBe(before);
    const guard = await t.asAdmin((tx) => one<{ proacl: string | null }>(tx, "select proacl::text from pg_proc where proname = 'guard_email_account_member_update'"));
    expect(guard.proacl).toBe("{postgres=X/postgres}");
  });

  it("PRO with room: CREATED, PAUSED with IMAP_SYNC_NOT_IMPLEMENTED, encrypted password and settings stored, never ACTIVE", async () => {
    const pro = await organization("PRO");
    const result = await connect(pro.id, { email: "  Ventas@Example-Mail.COM ", username: "ventas@example-mail.com", host: "IMAP.Example-Mail.com", cursor: "imap:v1:7:120", displayName: "Ventas" });
    expect(result).toMatchObject({ outcome: "CREATED", previous_status: null });
    const stored = await row(result.email_account_id as string);
    expect(stored).toMatchObject({
      organization_id: pro.id,
      provider: "IMAP",
      status: "PAUSED",
      email_address: "ventas@example-mail.com",
      display_name: "Ventas",
      access_token_encrypted: V2,
      refresh_token_encrypted: null,
      sync_cursor: "imap:v1:7:120",
      last_error_code: "IMAP_SYNC_NOT_IMPLEMENTED",
      provider_metadata: { imap: { host: "imap.example-mail.com", port: 993, security: "TLS", username: "ventas@example-mail.com" } }
    });
  });

  it("BUSINESS with room: CREATED (STARTTLS on 143)", async () => {
    const business = await organization("BUSINESS");
    const result = await connect(business.id, { port: 143, security: "STARTTLS" });
    expect(result.outcome).toBe("CREATED");
    expect((await row(result.email_account_id as string)).provider_metadata).toMatchObject({ imap: { port: 143, security: "STARTTLS" } });
  });

  it("BASIC, no subscription (unknown / no access) and an expired subscription are refused; nothing is written", async () => {
    const basic = await organization("BASIC");
    const none = await organization(null);
    const expired = await organization("PRO");
    await t.asAdmin((tx) => tx.query("update public.subscriptions set started_at = now() - interval '2 months', current_period_start = now() - interval '2 months', current_period_end = now() - interval '1 minute' where organization_id = $1", [expired.id]));
    for (const orgId of [basic.id, none.id, expired.id]) {
      expect(await connect(orgId)).toMatchObject({ outcome: "FEATURE_NOT_AVAILABLE", email_account_id: null });
      expect(await rowsOf(orgId)).toBe(0);
    }
  });

  it("the EMAIL_ACCOUNTS limit is shared with Gmail / Microsoft: no extra quota for IMAP", async () => {
    const business = await organization("BUSINESS");
    await setLimit("BUSINESS", 2);
    try {
      await t.asService((tx) =>
        tx.query("select * from public.connect_oauth_email_account($1, 'GMAIL', 'gmail@example.com', null, null, 'v1.a', 'v1.r', null, '1')", [business.id])
      );
      expect((await connect(business.id, { email: "uno@example-mail.com" })).outcome).toBe("CREATED");
      expect(await connect(business.id, { email: "dos@example-mail.com" })).toMatchObject({ outcome: "PLAN_LIMIT_REACHED", used: 2, limit_value: 2 });
      expect(await rowsOf(business.id)).toBe(2);
      // And IMAP mailboxes count for the OAuth function too.
      const oauth = await t.asService((tx) =>
        one<{ outcome: string }>(tx, "select * from public.connect_oauth_email_account($1, 'GMAIL', 'otro@example.com', null, null, 'v1.a', 'v1.r', null, '1')", [business.id])
      );
      expect(oauth.outcome).toBe("PLAN_LIMIT_REACHED");
    } finally {
      await setLimit("BUSINESS", 250);
    }
  });

  it("the PRO limit (catalog value) is respected", async () => {
    const pro = await organization("PRO");
    await setLimit("PRO", 1);
    try {
      expect((await connect(pro.id, { email: "a@example-mail.com" })).outcome).toBe("CREATED");
      expect((await connect(pro.id, { email: "b@example-mail.com" })).outcome).toBe("PLAN_LIMIT_REACHED");
      // Re-connecting the mailbox that already counts needs no new slot.
      expect((await connect(pro.id, { email: "A@Example-Mail.com", password: V2_OTHER })).outcome).toBe("RECONNECTED");
    } finally {
      await setLimit("PRO", 125);
    }
  });

  it("the same address twice (any case): one row, RECONNECTED, credentials replaced", async () => {
    const pro = await organization("PRO");
    const first = await connect(pro.id, { email: "Same@Example-Mail.com" });
    const second = await connect(pro.id, { email: "same@example-mail.com", password: V2_OTHER });
    expect(second).toMatchObject({ outcome: "RECONNECTED", email_account_id: first.email_account_id, previous_status: "PAUSED" });
    expect(await rowsOf(pro.id)).toBe(1);
    expect((await row(first.email_account_id as string)).access_token_encrypted).toBe(V2_OTHER);
  });

  it("ERROR on the same server: recovered keeping its cursor (nothing received meanwhile is skipped)", async () => {
    const pro = await organization("PRO");
    const created = await connect(pro.id, { cursor: "imap:v1:7:100" });
    const id = created.email_account_id as string;
    await setCursor(id, "imap:v1:7:150");
    await markError(id);
    const reconnected = await connect(pro.id, { password: V2_OTHER, cursor: "imap:v1:7:999" });
    expect(reconnected).toMatchObject({ outcome: "RECONNECTED", email_account_id: id, previous_status: "ERROR" });
    expect(await row(id)).toMatchObject({ status: "PAUSED", sync_cursor: "imap:v1:7:150", access_token_encrypted: V2_OTHER, last_error_code: "IMAP_SYNC_NOT_IMPLEMENTED" });
  });

  it("ERROR moved to another server: starts from the caller's cursor (the old position means nothing there)", async () => {
    const pro = await organization("PRO");
    const id = (await connect(pro.id, { cursor: "imap:v1:7:100" })).email_account_id as string;
    await markError(id);
    await connect(pro.id, { host: "imappro.example-mail.com", cursor: "imap:v1:3:10" });
    expect(await row(id)).toMatchObject({ sync_cursor: "imap:v1:3:10", provider_metadata: { imap: { host: "imappro.example-mail.com" } } });
  });

  it("DISCONNECTED: needs a free slot, reuses the same row and starts from the connection time", async () => {
    const pro = await organization("PRO");
    const id = (await connect(pro.id, { cursor: "imap:v1:7:100" })).email_account_id as string;
    await disconnect(id);
    await setLimit("PRO", 1);
    try {
      expect((await connect(pro.id, { email: "other@example-mail.com" })).outcome).toBe("CREATED");
      expect(await connect(pro.id, { cursor: "imap:v1:7:500" })).toMatchObject({ outcome: "PLAN_LIMIT_REACHED", email_account_id: id, previous_status: "DISCONNECTED" });
      await t.asService((tx) => tx.query("delete from public.email_accounts where organization_id = $1 and email_address = 'other@example-mail.com'", [pro.id]).catch(() => undefined));
    } finally {
      await setLimit("PRO", 125);
    }
    const reconnected = await connect(pro.id, { cursor: "imap:v1:7:500" });
    expect(reconnected).toMatchObject({ outcome: "RECONNECTED", email_account_id: id, previous_status: "DISCONNECTED" });
    expect(await row(id)).toMatchObject({ status: "PAUSED", sync_cursor: "imap:v1:7:500", access_token_encrypted: V2 });
  });

  it("the same mailbox connected through Gmail / Microsoft: DUPLICATE_ACCOUNT (allowed again once that one is disconnected)", async () => {
    const pro = await organization("PRO");
    const gmail = await t.asService((tx) =>
      one<{ email_account_id: string }>(tx, "select * from public.connect_oauth_email_account($1, 'GMAIL', 'shared@example.com', null, null, 'v1.a', 'v1.r', null, '1')", [pro.id])
    );
    expect((await connect(pro.id, { email: "Shared@Example.com" })).outcome).toBe("DUPLICATE_ACCOUNT");
    expect(await rowsOf(pro.id)).toBe(1);
    await disconnect(gmail.email_account_id);
    expect((await connect(pro.id, { email: "shared@example.com" })).outcome).toBe("CREATED");
  });

  it("organizations are isolated: the same address in two organizations is two mailboxes", async () => {
    const one_ = await organization("PRO");
    const two = await organization("BUSINESS");
    const first = await connect(one_.id, { email: "isolated@example-mail.com" });
    const second = await connect(two.id, { email: "isolated@example-mail.com", password: V2_OTHER });
    expect(second.outcome).toBe("CREATED");
    expect(second.email_account_id).not.toBe(first.email_account_id);
    expect((await row(first.email_account_id as string)).access_token_encrypted).toBe(V2);
    // A member of one organization never sees the other's mailbox.
    const visible = await t.asUser(one_.ownerId, (tx) => count(tx, "select 1 from public.email_accounts where id = $1", [second.email_account_id]));
    expect(visible).toBe(0);
  });

  it.each([
    ["a plaintext password", { password: "hunter2" }, /must be encrypted/],
    ["a v1 (unbound) password", { password: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Q0lQ" }, /must be encrypted/],
    ["no password", { password: null }, /must be encrypted/],
    ["993 with STARTTLS", { security: "STARTTLS" }, /Only port 993 with TLS/],
    ["143 with TLS", { port: 143 }, /Only port 993 with TLS/],
    ["a plaintext mode", { security: "NONE" }, /Only port 993 with TLS/],
    ["another port", { port: 110 }, /Only port 993 with TLS/],
    ["an IP address", { host: "127.0.0.1" }, /must be a DNS name/],
    ["an IPv6 literal", { host: "[::1]" }, /must be a DNS name/],
    ["a single label", { host: "mail" }, /must be a DNS name/],
    ["localhost", { host: "imap.localhost" }, /must be a public DNS name/],
    ["an internal name", { host: "mail.corp.internal" }, /must be a public DNS name/],
    ["an invalid address", { email: "not-an-address" }, /valid email address/],
    ["no username", { username: "  " }, /username is required/]
  ])("invalid input raises (%s) and writes nothing", async (_label, input, message) => {
    const pro = await organization("PRO");
    await expect(connect(pro.id, input as ImapInput)).rejects.toThrow(message);
    expect(await rowsOf(pro.id)).toBe(0);
  });

  it("an unknown organization raises", async () => {
    await expect(connect("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/Organization not found/);
  });
});
