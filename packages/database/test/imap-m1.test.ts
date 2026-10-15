import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { activateSubscription, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * IMAP M1 (20261015120000_imap_m1_lifecycle.sql): explicit activation.
 *   - connect_imap_email_account still stores the mailbox PAUSED, now with
 *     IMAP_ACTIVATION_PENDING (also on a reconnection of an ACTIVE mailbox);
 *   - activate_imap_email_account is the only way to make an IMAP mailbox
 *     ACTIVE (service_role, per-organization lock, plan feature + access,
 *     usable v2 password and settings); the E1 trigger still refuses it to
 *     members (authenticated).
 *
 * Every migration is applied from scratch to a throwaway PGlite database (no
 * Docker, no network). PGlite runs one transaction at a time: overlapping
 * sessions are in scripts/imap-activate-concurrency-check.sh (real PostgreSQL).
 */

let t: TestDatabase;
let f: Fixtures;
let sequence = 0;

/** SecretBox v2 shape (iv 12 bytes, tag 16 bytes, base64url). The database never sees a real password. */
const V2 = "v2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Q0lQSEVSVEVYVA";

type Activation = { outcome: string; email_account_id: string | null; previous_status: string | null };

const CONNECT = "select * from public.connect_imap_email_account($1, $2, $3, $4, $5, $6, $7, $8, $9)";
const ACTIVATE = "select * from public.activate_imap_email_account($1, $2)";

const connect = (organizationId: string, email: string, cursor: string | null = "imap:v1:7:120") =>
  t.asService((tx) =>
    one<{ outcome: string; email_account_id: string }>(tx, CONNECT, [organizationId, email, null, email, "imap.example-mail.com", 993, "TLS", V2, cursor])
  );
const activate = (organizationId: string, id: string) => t.asService((tx) => one<Activation>(tx, ACTIVATE, [organizationId, id]));

const row = (id: string) =>
  t.asAdmin((tx) =>
    one<{ status: string; last_error_code: string | null; last_error_message: string | null; access_token_encrypted: string | null; sync_cursor: string | null }>(
      tx,
      "select status, last_error_code, last_error_message, access_token_encrypted, sync_cursor from public.email_accounts where id = $1",
      [id]
    )
  );

async function organization(plan: "BASIC" | "PRO" | "BUSINESS" | null): Promise<{ id: string; ownerId: string }> {
  sequence += 1;
  const ownerId = await t.createUser(`imap-m1-owner-${sequence}@example.test`);
  const org = await t.asUser(ownerId, (tx) => one<{ id: string }>(tx, "select public.create_organization($1, $2) as id", [`ImapM1 ${sequence}`, `imap-m1-${sequence}`]));
  if (plan) await activateSubscription(t, org.id, plan);
  return { id: org.id, ownerId };
}

/** A PRO organization with one connected (PAUSED) IMAP mailbox. */
async function connectedMailbox(plan: "PRO" | "BUSINESS" = "PRO") {
  const org = await organization(plan);
  sequence += 1;
  const created = await connect(org.id, `m1-${sequence}@example-mail.com`);
  expect(created.outcome).toBe("CREATED");
  return { org, id: created.email_account_id };
}

const disconnect = (id: string) =>
  t.asService((tx) =>
    tx.query(
      `update public.email_accounts set status = 'DISCONNECTED', access_token_encrypted = null, refresh_token_encrypted = null,
         token_expires_at = null, sync_cursor = null, last_error_code = null, last_error_message = null where id = $1`,
      [id]
    )
  );

beforeAll(async () => {
  t = await createTestDatabase({ defaultPrivileges: "production" });
  f = await seedTwoTenants(t);
});
afterAll(async () => t?.close());

describe("public.activate_imap_email_account: privileges", () => {
  it("SECURITY DEFINER, empty search_path, EXECUTE only for service_role (members and anonymous are refused)", async () => {
    const fn = await t.asAdmin((tx) =>
      one<{ prosecdef: boolean; proconfig: string[]; proacl: string }>(
        tx,
        "select prosecdef, proconfig, proacl::text from pg_proc where oid = 'public.activate_imap_email_account(uuid, uuid)'::regprocedure"
      )
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=""']);
    expect(fn.proacl).not.toMatch(/(^|[{,])(authenticated|anon)=/);
    const { org, id } = await connectedMailbox();
    for (const run of [(sql: string, values: unknown[]) => t.asUser(org.ownerId, (tx) => tx.query(sql, values)), (sql: string, values: unknown[]) => t.asAnon((tx) => tx.query(sql, values))]) {
      await expect(run(ACTIVATE, [org.id, id])).rejects.toThrow(/permission denied for function activate_imap_email_account/);
    }
    expect((await row(id)).status).toBe("PAUSED");
  });

  it("the E1 trigger still refuses a member's direct activation (OWNER), even with a valid plan and login", async () => {
    const { org, id } = await connectedMailbox();
    await expect(t.asUser(org.ownerId, (tx) => tx.query("update public.email_accounts set status = 'ACTIVE' where id = $1", [id]))).rejects.toThrow(
      /IMAP synchronization is not available yet/
    );
    expect((await row(id)).status).toBe("PAUSED");
    // Pausing an IMAP mailbox stays a member operation (status column, trigger allows PAUSED).
    expect((await activate(org.id, id)).outcome).toBe("ACTIVATED");
    const paused = await t.asUser(org.ownerId, async (tx) => (await tx.query("update public.email_accounts set status = 'PAUSED' where id = $1", [id])).affectedRows);
    expect(paused).toBe(1);
    expect((await row(id)).status).toBe("PAUSED");
  });

  it("invalid input raises (programming error of the caller)", async () => {
    await expect(t.asService((tx) => tx.query(ACTIVATE, [null, f.a.accountId]))).rejects.toThrow(/organization and a mailbox are required/);
    await expect(t.asService((tx) => tx.query(ACTIVATE, ["00000000-0000-4000-8000-000000000000", f.a.accountId]))).rejects.toThrow(/Organization not found/);
  });
});

describe("connect_imap_email_account after M1: always PAUSED + IMAP_ACTIVATION_PENDING", () => {
  it("a new mailbox is PAUSED with the neutral code; nothing is ACTIVE until an explicit activation", async () => {
    const { id } = await connectedMailbox();
    expect(await row(id)).toMatchObject({
      status: "PAUSED",
      last_error_code: "IMAP_ACTIVATION_PENDING",
      last_error_message: "Mailbox connected and paused. Resume it to start synchronizing new mail.",
      access_token_encrypted: V2,
      sync_cursor: "imap:v1:7:120"
    });
  });

  it("reconnecting an ACTIVE mailbox leaves it PAUSED again (same server: cursor kept)", async () => {
    const { org, id } = await connectedMailbox();
    expect((await activate(org.id, id)).outcome).toBe("ACTIVATED");
    const email = (await t.asAdmin((tx) => one<{ email_address: string }>(tx, "select email_address from public.email_accounts where id = $1", [id]))).email_address;
    const again = await t.asService((tx) =>
      one<{ outcome: string; previous_status: string }>(tx, CONNECT, [org.id, email, null, email, "imap.example-mail.com", 993, "TLS", V2, "imap:v1:7:999"])
    );
    expect(again).toMatchObject({ outcome: "RECONNECTED", previous_status: "ACTIVE" });
    expect(await row(id)).toMatchObject({ status: "PAUSED", last_error_code: "IMAP_ACTIVATION_PENDING", sync_cursor: "imap:v1:7:120" });
  });
});

describe("public.activate_imap_email_account: outcomes", () => {
  it.each(["PRO", "BUSINESS"] as const)("%s: a PAUSED mailbox becomes ACTIVE, the pending code is cleared, the cursor kept", async (plan) => {
    const { org, id } = await connectedMailbox(plan);
    expect(await activate(org.id, id)).toEqual({ outcome: "ACTIVATED", email_account_id: id, previous_status: "PAUSED" });
    expect(await row(id)).toMatchObject({ status: "ACTIVE", last_error_code: null, last_error_message: null, sync_cursor: "imap:v1:7:120", access_token_encrypted: V2 });
    // Idempotent: a second activation changes nothing.
    expect(await activate(org.id, id)).toEqual({ outcome: "ALREADY_ACTIVE", email_account_id: id, previous_status: "ACTIVE" });
  });

  it.each(["IMAP_AUTH_FAILED", "IMAP_TLS_FAILED", "IMAP_ACTIVATION_PENDING"])(
    "M1.4 (H1): ERROR (%s) is never activated: RECONNECT_REQUIRED, nothing written; a reconnection makes it activatable again",
    async (code) => {
      const { org, id } = await connectedMailbox();
      await t.asService((tx) => tx.query("update public.email_accounts set status = 'ERROR', last_error_code = $2, last_error_message = 'x' where id = $1", [id, code]));
      expect(await activate(org.id, id)).toEqual({ outcome: "RECONNECT_REQUIRED", email_account_id: id, previous_status: "ERROR" });
      expect(await row(id)).toMatchObject({ status: "ERROR", last_error_code: code, last_error_message: "x", access_token_encrypted: V2, sync_cursor: "imap:v1:7:120" });
      // Connecting it again (the API does it after a connection test under the E4 limits) leaves it PAUSED...
      const email = (await t.asAdmin((tx) => one<{ email_address: string }>(tx, "select email_address from public.email_accounts where id = $1", [id]))).email_address;
      expect((await connect(org.id, email)).outcome).toBe("RECONNECTED");
      expect(await row(id)).toMatchObject({ status: "PAUSED", last_error_code: "IMAP_ACTIVATION_PENDING" });
      // ...and only then the approved activation applies.
      expect(await activate(org.id, id)).toMatchObject({ outcome: "ACTIVATED", previous_status: "PAUSED" });
    }
  );

  it("BASIC (downgrade), canceled and expired subscriptions: FEATURE_NOT_AVAILABLE, nothing written", async () => {
    for (const setup of ["BASIC", "canceled", "expired"] as const) {
      const { org, id } = await connectedMailbox();
      if (setup === "BASIC") {
        // Downgrade: a new BASIC subscription replaces the PRO one.
        await activateSubscription(t, org.id, "BASIC");
      } else if (setup === "canceled") {
        // CANCELED ends the access at once (docs/commercial-plans.md).
        await t.asAdmin((tx) => tx.query("update public.subscriptions set status = 'CANCELED', canceled_at = now() where organization_id = $1", [org.id]));
      } else {
        await t.asAdmin((tx) =>
          tx.query(
            "update public.subscriptions set started_at = now() - interval '2 months', current_period_start = now() - interval '2 months', current_period_end = now() - interval '1 minute' where organization_id = $1",
            [org.id]
          )
        );
      }
      expect(await activate(org.id, id), setup).toMatchObject({ outcome: "FEATURE_NOT_AVAILABLE", previous_status: "PAUSED" });
      expect(await row(id), setup).toMatchObject({ status: "PAUSED", last_error_code: "IMAP_ACTIVATION_PENDING" });
    }
  });

  it("DISCONNECTED is refused (connect again); the cleared credentials stay cleared", async () => {
    const { org, id } = await connectedMailbox();
    await disconnect(id);
    expect(await activate(org.id, id)).toMatchObject({ outcome: "DISCONNECTED", previous_status: "DISCONNECTED" });
    expect(await row(id)).toMatchObject({ status: "DISCONNECTED", access_token_encrypted: null, sync_cursor: null });
  });

  it("a missing or non-v2 password is refused (CREDENTIALS_MISSING); invalid stored settings too (SETTINGS_INVALID)", async () => {
    for (const value of [null, "", "v1.aaaa.bbbb.cccc", "plaintext-password"]) {
      const { org, id } = await connectedMailbox();
      await t.asAdmin((tx) => tx.query("update public.email_accounts set access_token_encrypted = $2 where id = $1", [id, value]));
      expect(await activate(org.id, id), String(value)).toMatchObject({ outcome: "CREDENTIALS_MISSING" });
      expect((await row(id)).status).toBe("PAUSED");
    }
    const broken: Array<Record<string, unknown> | null> = [
      null,
      { host: "169.254.169.254", port: 993, security: "TLS", username: "u" },
      { host: "imap.corp", port: 993, security: "TLS", username: "u" },
      { host: "imap.example-mail.com", port: 143, security: "TLS", username: "u" },
      { host: "imap.example-mail.com", port: 993, secure: true, username: "u" },
      { host: "imap.example-mail.com", port: 993, security: "TLS", username: "" }
    ];
    for (const settings of broken) {
      const { org, id } = await connectedMailbox();
      await t.asAdmin((tx) => tx.query("update public.email_accounts set provider_metadata = $2 where id = $1", [id, settings === null ? {} : { imap: settings }]));
      expect(await activate(org.id, id), JSON.stringify(settings)).toMatchObject({ outcome: "SETTINGS_INVALID" });
      expect((await row(id)).status).toBe("PAUSED");
    }
  });

  it("another organization's mailbox is NOT_FOUND (no information leaked); a Gmail mailbox is NOT_IMAP", async () => {
    const { id } = await connectedMailbox();
    expect(await activate(f.b.orgId, id)).toEqual({ outcome: "NOT_FOUND", email_account_id: null, previous_status: null });
    expect((await row(id)).status).toBe("PAUSED");
    expect(await activate(f.a.orgId, f.a.accountId)).toMatchObject({ outcome: "NOT_IMAP" });
    expect(await activate(f.a.orgId, "00000000-0000-4000-8000-000000000001")).toMatchObject({ outcome: "NOT_FOUND" });
  });

  it("activation never takes a new EMAIL_ACCOUNTS slot: a PAUSED mailbox already counts", async () => {
    const { org, id } = await connectedMailbox("BUSINESS");
    await t.asAdmin((tx) =>
      tx.query(
        `update public.plan_entitlements e set limit_value = 1 from public.plan_catalog c where c.id = e.plan_id and c.code = 'BUSINESS' and e.key = 'EMAIL_ACCOUNTS'`
      )
    );
    try {
      expect((await activate(org.id, id)).outcome).toBe("ACTIVATED");
    } finally {
      await t.asAdmin((tx) =>
        tx.query(
          `update public.plan_entitlements e set limit_value = 250 from public.plan_catalog c where c.id = e.plan_id and c.code = 'BUSINESS' and e.key = 'EMAIL_ACCOUNTS'`
        )
      );
    }
  });
});
