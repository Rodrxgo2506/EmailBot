import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { activateSubscription, count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * public.connect_oauth_email_account: the OAuth callback's only write of a
 * Gmail / Microsoft mailbox (20261007160000_email_account_oauth_connect.sql).
 *
 *   P0  the EMAIL_ACCOUNTS limit is checked and the row written in ONE
 *       transaction under a per-organization lock;
 *   P1  re-authorizing a Gmail mailbox in ERROR keeps its history cursor.
 *
 * PGlite has a single connection: transactions never overlap here, so the
 * calls "started together" below run one after the other. They prove the
 * function's decisions; the lock itself is exercised with real overlapping
 * sessions against PostgreSQL by scripts/connect-concurrency-check.sh
 * (see docs/commercial-plans.md).
 */

let t: TestDatabase;
let f: Fixtures;
let sequence = 0;

interface Connection {
  outcome: "CREATED" | "RECONNECTED" | "PLAN_LIMIT_REACHED" | "MISSING_REFRESH_TOKEN";
  email_account_id: string | null;
  previous_status: string | null;
  used: number | null;
  limit_value: number | null;
}

interface AccountRow {
  id: string;
  status: string;
  email_address: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  sync_cursor: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

interface ConnectOptions {
  provider?: "GMAIL" | "MICROSOFT";
  access?: string;
  refresh?: string | null;
  cursor?: string | null;
}

/** What the API's privileged layer does (service_role, PostgREST RPC). */
const connect = (organizationId: string, emailAddress: string, options: ConnectOptions = {}) =>
  t.asService((tx) =>
    one<Connection>(
      tx,
      `select * from public.connect_oauth_email_account($1, $2::public.email_provider, $3, null, $3, $4, $5, now() + interval '1 hour', $6)`,
      [
        organizationId,
        options.provider ?? "GMAIL",
        emailAddress,
        options.access ?? "v1.access",
        options.refresh === undefined ? "v1.refresh" : options.refresh,
        options.cursor === undefined ? "1000" : options.cursor
      ]
    )
  );

const accounts = (organizationId: string) =>
  t.asAdmin(async (tx) =>
    (
      await tx.query<AccountRow>(
        `select id, status, email_address, access_token_encrypted, refresh_token_encrypted, sync_cursor, last_error_code, last_error_message
         from public.email_accounts where organization_id = $1 order by email_address`,
        [organizationId]
      )
    ).rows
  );

const account = async (id: string) => (await t.asAdmin((tx) => one<AccountRow & { organization_id: string }>(tx, "select * from public.email_accounts where id = $1", [id])));

const counted = (organizationId: string) =>
  t.asAdmin((tx) => count(tx, "select 1 from public.email_accounts where organization_id = $1 and status <> 'DISCONNECTED'", [organizationId]));

/** A new organization with an ACTIVE subscription to `plan`. */
async function organization(plan: "BASIC" | "PRO" | "BUSINESS"): Promise<string> {
  sequence += 1;
  const ownerId = await t.createUser(`connect-owner-${sequence}@example.test`);
  const org = await t.asUser(ownerId, (tx) => one<{ id: string }>(tx, "select public.create_organization($1, $2) as id", [`Connect ${sequence}`, `connect-${sequence}`]));
  await activateSubscription(t, org.id, plan);
  return org.id;
}

/** BUSINESS is used by the limit scenarios only (the seeded tenants are PRO); its catalog limit is set per test. */
const setBusinessLimit = (limit: number | null) =>
  t.asAdmin((tx) =>
    tx.query(
      `update public.plan_entitlements e set limit_value = $1
       from public.plan_catalog c where c.id = e.plan_id and c.code = 'BUSINESS' and e.key = 'EMAIL_ACCOUNTS'`,
      [limit]
    )
  );

/** The worker's markError (AUTH_REVOKED): status ERROR, cursor untouched. */
const markError = (id: string) =>
  t.asAdmin((tx) =>
    tx.query("update public.email_accounts set status = 'ERROR', last_error_code = 'AUTH_REVOKED', last_error_message = 'Reconnect' where id = $1", [id])
  );

/** The API's disconnectEmailAccount. */
const disconnect = (organizationId: string, id: string) =>
  t.asService((tx) =>
    tx.query(
      `update public.email_accounts set status = 'DISCONNECTED', access_token_encrypted = null, refresh_token_encrypted = null,
         token_expires_at = null, sync_cursor = null, last_error_code = null, last_error_message = null
       where organization_id = $1 and id = $2`,
      [organizationId, id]
    )
  );

beforeAll(async () => {
  t = await createTestDatabase({ defaultPrivileges: "production" });
  f = await seedTwoTenants(t);
});
afterAll(async () => t?.close());

describe("privileges", () => {
  it("SECURITY DEFINER with an empty search_path; EXECUTE only for service_role", async () => {
    const fn = await t.asAdmin((tx) =>
      one<{ prosecdef: boolean; proconfig: string[] }>(
        tx,
        "select prosecdef, proconfig from pg_proc where oid = 'public.connect_oauth_email_account(uuid, public.email_provider, text, text, text, text, text, timestamptz, text)'::regprocedure"
      )
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=""']);

    const sql = "select * from public.connect_oauth_email_account($1, 'GMAIL', 'x@example.com', null, null, 'a', 'r', null, '1')";
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql, [f.a.orgId]))).rejects.toThrow(/permission denied for function connect_oauth_email_account/);
    await expect(t.asAnon((tx) => tx.query(sql, [f.a.orgId]))).rejects.toThrow(/permission denied for function connect_oauth_email_account/);
    expect(await accounts(f.a.orgId)).toHaveLength(1);
  });

  it("refuses IMAP and unknown organizations (nothing written)", async () => {
    await expect(connect(f.a.orgId, "imap@example.com", { provider: "IMAP" as "GMAIL" })).rejects.toThrow(/Only OAuth providers/);
    await expect(connect("00000000-0000-4000-8000-000000000000", "x@example.com")).rejects.toThrow(/Organization not found/);
  });
});

describe("P0: the EMAIL_ACCOUNTS limit and the write are one transaction", () => {
  it("a new mailbox: CREATED, ACTIVE, lower-case address, tokens and cursor stored", async () => {
    const orgId = await organization("PRO");
    const result = await connect(orgId, "  New@Example.COM ", { access: "v1.at", refresh: "v1.rt", cursor: "555" });
    expect(result).toMatchObject({ outcome: "CREATED", previous_status: null });
    expect(await account(result.email_account_id as string)).toMatchObject({
      organization_id: orgId,
      status: "ACTIVE",
      email_address: "new@example.com",
      access_token_encrypted: "v1.at",
      refresh_token_encrypted: "v1.rt",
      sync_cursor: "555"
    });
  });

  it("limit 1, two callbacks started together: exactly one mailbox, one CREATED and one PLAN_LIMIT_REACHED", async () => {
    await setBusinessLimit(1);
    const orgId = await organization("BUSINESS");
    const results = await Promise.all([connect(orgId, "one@example.com"), connect(orgId, "two@example.com")]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "PLAN_LIMIT_REACHED"]);
    expect(results.find((result) => result.outcome === "PLAN_LIMIT_REACHED")).toMatchObject({ used: 1, limit_value: 1, email_account_id: null });
    expect(await accounts(orgId)).toHaveLength(1);
  });

  it("limit 2, three callbacks started together: exactly two mailboxes", async () => {
    await setBusinessLimit(2);
    const orgId = await organization("BUSINESS");
    const results = await Promise.all(["a", "b", "c"].map((name) => connect(orgId, `${name}@example.com`)));
    expect(results.filter((result) => result.outcome === "CREATED")).toHaveLength(2);
    expect(results.filter((result) => result.outcome === "PLAN_LIMIT_REACHED")).toHaveLength(1);
    expect(await accounts(orgId)).toHaveLength(2);
  });

  it("the real catalog: BASIC connects its 25th mailbox and refuses the 26th", async () => {
    const orgId = await organization("BASIC");
    for (let index = 1; index <= 25; index += 1) expect((await connect(orgId, `box${index}@example.com`)).outcome).toBe("CREATED");
    expect(await connect(orgId, "box26@example.com")).toMatchObject({ outcome: "PLAN_LIMIT_REACHED", used: 25, limit_value: 25 });
    expect(await counted(orgId)).toBe(25);
  });

  it("an unlimited plan (limit_value NULL) never refuses", async () => {
    await setBusinessLimit(null);
    const orgId = await organization("BUSINESS");
    for (const name of ["u1", "u2", "u3"]) expect((await connect(orgId, `${name}@example.com`)).outcome).toBe("CREATED");
  });

  it("without commercial access the limit is 0 for a new mailbox (fail closed); a mailbox that counts can still be re-authorized", async () => {
    await setBusinessLimit(5);
    const orgId = await organization("BUSINESS");
    const existing = await connect(orgId, "kept@example.com");
    const subscriptionId = (await t.asAdmin((tx) => one<{ id: string }>(tx, "select id from public.subscriptions where organization_id = $1", [orgId]))).id;
    await t.asAdmin((tx) => tx.query("select * from private.change_subscription_status($1, 'PAST_DUE', null, 'payment_failed', null)", [subscriptionId]));

    expect(await connect(orgId, "new@example.com")).toMatchObject({ outcome: "PLAN_LIMIT_REACHED", limit_value: 0 });
    expect(await connect(orgId, "kept@example.com")).toMatchObject({ outcome: "RECONNECTED", email_account_id: existing.email_account_id });
    expect(await accounts(orgId)).toHaveLength(1);
  });

  it("the limit is per organization: another organization's mailboxes never count", async () => {
    await setBusinessLimit(1);
    const first = await organization("BUSINESS");
    const second = await organization("BUSINESS");
    expect((await connect(first, "shared@example.com")).outcome).toBe("CREATED");
    // The same Google mailbox in another organization is another row of that organization.
    expect((await connect(second, "shared@example.com")).outcome).toBe("CREATED");
    expect(await accounts(first)).toHaveLength(1);
    expect(await accounts(second)).toHaveLength(1);
  });
});

describe("P1: re-authorizing a mailbox", () => {
  it("ERROR (cursor 12345): same id, ACTIVE, cursor KEPT, error cleared, tokens replaced", async () => {
    const orgId = await organization("PRO");
    const { email_account_id: id } = await connect(orgId, "err@example.com", { access: "v1.old-at", refresh: "v1.old-rt", cursor: "12345" });
    await markError(id as string);

    const result = await connect(orgId, "err@example.com", { access: "v1.new-at", refresh: "v1.new-rt", cursor: "99999" });
    expect(result).toMatchObject({ outcome: "RECONNECTED", email_account_id: id, previous_status: "ERROR" });
    expect(await account(id as string)).toMatchObject({
      status: "ACTIVE",
      sync_cursor: "12345",
      last_error_code: null,
      last_error_message: null,
      access_token_encrypted: "v1.new-at",
      refresh_token_encrypted: "v1.new-rt"
    });
    expect(await accounts(orgId)).toHaveLength(1);
  });

  it("ERROR without a new refresh token keeps the stored one", async () => {
    const orgId = await organization("PRO");
    const { email_account_id: id } = await connect(orgId, "keep@example.com", { refresh: "v1.stored-rt", cursor: "42" });
    await markError(id as string);
    expect((await connect(orgId, "keep@example.com", { access: "v1.at2", refresh: null, cursor: "50" })).outcome).toBe("RECONNECTED");
    expect(await account(id as string)).toMatchObject({ refresh_token_encrypted: "v1.stored-rt", access_token_encrypted: "v1.at2", sync_cursor: "42" });
  });

  it("ERROR at the limit is allowed and takes no extra slot", async () => {
    await setBusinessLimit(1);
    const orgId = await organization("BUSINESS");
    const { email_account_id: id } = await connect(orgId, "only@example.com", { cursor: "12345" });
    await markError(id as string);
    expect(await connect(orgId, "only@example.com")).toMatchObject({ outcome: "RECONNECTED", email_account_id: id });
    expect(await counted(orgId)).toBe(1);
    expect(await connect(orgId, "other@example.com")).toMatchObject({ outcome: "PLAN_LIMIT_REACHED" });
  });

  it("ERROR whose cursor was lost (NULL) gets the current cursor (nothing to keep)", async () => {
    const orgId = await organization("PRO");
    const { email_account_id: id } = await connect(orgId, "nocursor@example.com", { cursor: null });
    await markError(id as string);
    await connect(orgId, "nocursor@example.com", { cursor: "777" });
    expect((await account(id as string)).sync_cursor).toBe("777");
  });

  it("Microsoft in ERROR keeps the previous behaviour (the delta cursor restarts from the connection)", async () => {
    const orgId = await organization("PRO");
    const { email_account_id: id } = await connect(orgId, "ms@contoso.test", { provider: "MICROSOFT", cursor: "since:old" });
    await markError(id as string);
    await connect(orgId, "ms@contoso.test", { provider: "MICROSOFT", cursor: "since:new" });
    expect(await account(id as string)).toMatchObject({ status: "ACTIVE", sync_cursor: "since:new" });
  });

  it("ACTIVE: same id, no duplicate, cursor from the new connection (unchanged semantics), refresh kept when none returned", async () => {
    const orgId = await organization("PRO");
    const { email_account_id: id } = await connect(orgId, "active@example.com", { refresh: "v1.rt-1", cursor: "100" });
    const result = await connect(orgId, "active@example.com", { refresh: null, cursor: "200" });
    expect(result).toMatchObject({ outcome: "RECONNECTED", email_account_id: id, previous_status: "ACTIVE" });
    expect(await account(id as string)).toMatchObject({ status: "ACTIVE", sync_cursor: "200", refresh_token_encrypted: "v1.rt-1" });
    expect(await accounts(orgId)).toHaveLength(1);
  });

  it("DISCONNECTED: needs room, a refresh token and starts from the current cursor (unchanged semantics)", async () => {
    await setBusinessLimit(1);
    const orgId = await organization("BUSINESS");
    const { email_account_id: oldId } = await connect(orgId, "old@example.com", { cursor: "10" });
    await disconnect(orgId, oldId as string);
    const { email_account_id: otherId } = await connect(orgId, "other@example.com");

    // At the limit: a DISCONNECTED mailbox counts again, so it needs room.
    expect(await connect(orgId, "old@example.com", { cursor: "20" })).toMatchObject({ outcome: "PLAN_LIMIT_REACHED", previous_status: "DISCONNECTED" });
    expect((await account(oldId as string)).status).toBe("DISCONNECTED");

    await disconnect(orgId, otherId as string);
    // Its tokens were wiped at disconnection: without a new refresh token it cannot work.
    expect(await connect(orgId, "old@example.com", { refresh: null, cursor: "20" })).toMatchObject({ outcome: "MISSING_REFRESH_TOKEN" });
    expect((await account(oldId as string)).status).toBe("DISCONNECTED");

    expect(await connect(orgId, "old@example.com", { refresh: "v1.rt-new", cursor: "20" })).toMatchObject({
      outcome: "RECONNECTED",
      email_account_id: oldId,
      previous_status: "DISCONNECTED"
    });
    expect(await account(oldId as string)).toMatchObject({ status: "ACTIVE", sync_cursor: "20", refresh_token_encrypted: "v1.rt-new" });
  });
});

describe("MISSING_REFRESH_TOKEN", () => {
  it("a new mailbox without a refresh token: refused, no row, no slot; the retry with one connects", async () => {
    await setBusinessLimit(1);
    const orgId = await organization("BUSINESS");
    expect(await connect(orgId, "offline@example.com", { refresh: null })).toMatchObject({ outcome: "MISSING_REFRESH_TOKEN", email_account_id: null });
    expect(await connect(orgId, "offline@example.com", { refresh: "" })).toMatchObject({ outcome: "MISSING_REFRESH_TOKEN" });
    expect(await accounts(orgId)).toHaveLength(0);
    expect((await connect(orgId, "offline@example.com", { refresh: "v1.rt" })).outcome).toBe("CREATED");
    expect(await accounts(orgId)).toHaveLength(1);
  });
});

describe("case-insensitive addresses", () => {
  it("usuario@ / USUARIO@ / Usuario@ are one mailbox (one row, one id, stored lower-case)", async () => {
    const orgId = await organization("PRO");
    const first = await connect(orgId, "Usuario@Example.com");
    const second = await connect(orgId, "USUARIO@EXAMPLE.COM");
    const third = await connect(orgId, "usuario@example.com");
    expect(first.outcome).toBe("CREATED");
    expect([second.outcome, third.outcome]).toEqual(["RECONNECTED", "RECONNECTED"]);
    expect(new Set([first.email_account_id, second.email_account_id, third.email_account_id]).size).toBe(1);
    expect((await accounts(orgId)).map((row) => row.email_address)).toEqual(["usuario@example.com"]);
  });

  it("a legacy mixed-case row is found, reused and normalized, so the exact-match lookups (webhook, worker) find it", async () => {
    const orgId = await organization("PRO");
    const legacy = await t.asAdmin((tx) =>
      one<{ id: string }>(
        tx,
        `insert into public.email_accounts (organization_id, provider, email_address, status, access_token_encrypted, refresh_token_encrypted)
         values ($1, 'GMAIL', 'Legacy@Example.com', 'ERROR', 'v1.a', 'v1.r') returning id`,
        [orgId]
      )
    );
    expect(await connect(orgId, "legacy@example.com")).toMatchObject({ outcome: "RECONNECTED", email_account_id: legacy.id });
    // The lookups of hasActiveMailbox / findActiveAccountsByAddress (PostgREST .eq on the lower-cased address).
    const found = await t.asService((tx) =>
      count(tx, "select 1 from public.email_accounts where provider = 'GMAIL' and status = 'ACTIVE' and email_address = lower($1)", ["LEGACY@example.com"])
    );
    expect(found).toBe(1);
  });
});

describe("two mailboxes of one organization (sales@ / support@)", () => {
  it("are two rows with their own tokens and cursor; an error, a reconnection or a disconnection of one never touches the other", async () => {
    const orgId = await organization("PRO");
    const sales = await connect(orgId, "sales@example.com", { access: "v1.at-sales", refresh: "v1.rt-sales", cursor: "100" });
    const support = await connect(orgId, "support@example.com", { access: "v1.at-support", refresh: "v1.rt-support", cursor: "900" });
    expect(sales.email_account_id).not.toBe(support.email_account_id);
    const supportBefore = await account(support.email_account_id as string);
    expect(supportBefore).toMatchObject({ access_token_encrypted: "v1.at-support", refresh_token_encrypted: "v1.rt-support", sync_cursor: "900" });

    // sales@ in ERROR, then re-authorized: support@ unchanged.
    await markError(sales.email_account_id as string);
    expect((await account(support.email_account_id as string)).status).toBe("ACTIVE");
    await connect(orgId, "sales@example.com", { access: "v1.at-sales-2", refresh: null, cursor: "150" });
    expect(await account(sales.email_account_id as string)).toMatchObject({ access_token_encrypted: "v1.at-sales-2", sync_cursor: "100" });
    expect(await account(support.email_account_id as string)).toEqual(supportBefore);

    // support@ in ERROR: sales@ unchanged.
    const salesBefore = await account(sales.email_account_id as string);
    await markError(support.email_account_id as string);
    expect(await account(sales.email_account_id as string)).toEqual(salesBefore);

    // Disconnecting sales@ leaves support@ as it was.
    const supportInError = await account(support.email_account_id as string);
    await disconnect(orgId, sales.email_account_id as string);
    expect((await account(sales.email_account_id as string)).status).toBe("DISCONNECTED");
    expect(await account(support.email_account_id as string)).toEqual(supportInError);
  });
});
