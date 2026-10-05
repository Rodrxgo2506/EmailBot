import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * EmailBot V2 phase 4: customer_access_credentials, customer_sessions and
 * their SECURITY DEFINER functions (admin: public.*, portal: portal.*).
 */

let t: TestDatabase;
let f: Fixtures;
let customerA: string;
let customerA2: string;
let customerB: string;
let botA: string;
let sequence = 0;

const hex = (label: string) => createHash("sha256").update(`${label}-${++sequence}`).digest("hex");

interface Issued {
  credential_id: string;
  organization_id: string;
  previous_credential_id: string | null;
  revoked_sessions: number;
  last4: string;
  status: string;
}

const issue = (tx: Tx, customerId: string, secretHash: string, expiresAt: string | null = null) =>
  one<Issued>(tx, "select * from public.issue_customer_access($1, $2, $3, $4, $5)", [customerId, secretHash, "P417", "SP", expiresAt]);

interface Login {
  outcome: string;
  organization_id: string | null;
  customer_id: string | null;
  session_id: string | null;
  display_name: string | null;
  idle_expires_at: string | null;
  absolute_expires_at: string | null;
}

const login = (secretHash: string, tokenHash: string) =>
  t.asService((tx) => one<Login>(tx, "select * from portal.create_session($1, $2, $3, $4)", [secretHash, tokenHash, "203.0.113.7", "vitest"]));

const validate = (tokenHash: string) =>
  t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from portal.validate_session($1)", [tokenHash])).rows);

/** A credential + an open session for a customer (as OWNER of its organization). */
async function withSession(ownerId: string, customerId: string) {
  const secret = hex("secret");
  const token = hex("token");
  const issued = await t.asUser(ownerId, (tx) => issue(tx, customerId, secret));
  const session = await login(secret, token);
  expect(session.outcome).toBe("OK");
  return { secret, token, credentialId: issued.credential_id, sessionId: session.session_id as string };
}

beforeAll(async () => {
  t = await createTestDatabase();
  f = await seedTwoTenants(t);
  await t.asAdmin(async (tx) => {
    const id = async (sql: string, params: unknown[]) => (await one<{ id: string }>(tx, `${sql} returning id`, params)).id;
    customerA = await id("insert into public.customers (organization_id, display_name) values ($1, 'Juan')", [f.a.orgId]);
    customerA2 = await id("insert into public.customers (organization_id, display_name) values ($1, 'Ana')", [f.a.orgId]);
    customerB = await id("insert into public.customers (organization_id, display_name) values ($1, 'Pedro')", [f.b.orgId]);
    botA = await id("insert into public.bots (organization_id, name, slug) values ($1, 'Netflix', 'netflix')", [f.a.orgId]);
    await tx.query("insert into public.bot_customer_assignments (organization_id, bot_id, customer_id) values ($1, $2, $3)", [f.a.orgId, botA, customerA]);
  });
});

afterAll(async () => {
  await t?.close();
});

describe("credentials: administration through public.issue_customer_access", () => {
  it.each(["ownerId", "adminId", "operatorId"] as const)("%s can generate an Access ID credential", async (who) => {
    const issued = await t.asUser(f.a[who], (tx) => issue(tx, customerA2, hex("secret")));
    expect(issued).toMatchObject({ organization_id: f.a.orgId, status: "ACTIVE", last4: "P417" });
  });

  it("VIEWER, members of another organization and outsiders cannot (indistinguishable from a missing customer)", async () => {
    for (const userId of [f.a.viewerId, f.b.ownerId, f.outsiderId]) {
      await expect(t.asUser(userId, (tx) => issue(tx, customerA, hex("secret")))).rejects.toThrow(/Customer not found/);
    }
    await expect(t.asUser(f.a.ownerId, (tx) => issue(tx, "00000000-0000-4000-8000-000000000000", hex("secret")))).rejects.toThrow(
      /Customer not found/
    );
  });

  it("organization_id comes from the customer, never from the caller", async () => {
    const issued = await t.asUser(f.b.ownerId, (tx) => issue(tx, customerB, hex("secret")));
    expect(issued.organization_id).toBe(f.b.orgId);
  });

  it("one ACTIVE credential: regeneration revokes the previous one and its sessions atomically (history kept)", async () => {
    const first = await withSession(f.a.ownerId, customerA);
    const second = await t.asUser(f.a.adminId, (tx) => issue(tx, customerA, hex("secret")));

    expect(second.previous_credential_id).toBe(first.credentialId);
    expect(second.revoked_sessions).toBe(1);
    const rows = await t.asAdmin((tx) =>
      tx.query<{ id: string; status: string; revoked_reason: string | null }>(
        "select id, status, revoked_reason from public.customer_access_credentials where customer_id = $1 order by created_at",
        [customerA]
      )
    );
    expect(rows.rows.filter((row) => row.status === "ACTIVE").map((row) => row.id)).toEqual([second.credential_id]);
    expect(rows.rows.find((row) => row.id === first.credentialId)).toMatchObject({ status: "REVOKED", revoked_reason: "REGENERATED" });
    expect(await validate(first.token)).toEqual([]);
    expect((await login(first.secret, hex("token"))).outcome).toBe("REVOKED");
  });

  it("the database itself refuses a second ACTIVE credential (any role)", async () => {
    await expect(
      t.asAdmin((tx) =>
        tx.query(
          "insert into public.customer_access_credentials (organization_id, customer_id, secret_hash, last4) values ($1, $2, $3, 'ABCD')",
          [f.a.orgId, customerA, hex("secret")]
        )
      )
    ).rejects.toThrow(/customer_access_credentials_one_active_idx/);
  });

  it("rejects malformed values and past expirations", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => issue(tx, customerA2, "not-a-hash"))).rejects.toThrow(/secret_hash_format/);
    await expect(
      t.asUser(f.a.ownerId, (tx) => one(tx, "select * from public.issue_customer_access($1, $2, 'ilou', 'SP', null)", [customerA2, hex("s")]))
    ).rejects.toThrow(/last4_format/);
    await expect(t.asUser(f.a.ownerId, (tx) => issue(tx, customerA2, hex("secret"), "2020-01-01T00:00:00Z"))).rejects.toThrow(
      /Expiration must be in the future/
    );
  });

  it("revocation revokes the credential and every session; nothing is deleted", async () => {
    const access = await withSession(f.a.ownerId, customerA);
    const revoked = await t.asUser(f.a.operatorId, (tx) =>
      one<{ credential_id: string; revoked_sessions: number }>(tx, "select * from public.revoke_customer_access($1)", [customerA])
    );
    expect(revoked).toEqual({ credential_id: access.credentialId, revoked_sessions: 1 });
    expect(await validate(access.token)).toEqual([]);
    expect((await login(access.secret, hex("token"))).outcome).toBe("REVOKED");
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.customer_sessions where id = $1 and revoked_reason = 'CREDENTIAL_REVOKED'", [access.sessionId]))).toBe(1);
    await expect(t.asUser(f.a.viewerId, (tx) => tx.query("select * from public.revoke_customer_access($1)", [customerA]))).rejects.toThrow(
      /Customer not found/
    );
  });
});

describe("credentials and sessions: hash protection and RLS", () => {
  it("no API role can read secret_hash or token_hash", async () => {
    await withSession(f.a.ownerId, customerA);
    for (const sql of ["select secret_hash from public.customer_access_credentials", "select token_hash from public.customer_sessions"]) {
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
      await expect(t.asService((tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
      await expect(t.asAnon((tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("OWNER/ADMIN/OPERATOR read the public columns of their organization only; VIEWER reads nothing", async () => {
    const credentials = "select id, organization_id, last4, status from public.customer_access_credentials";
    const sessions = "select id, organization_id, last_seen_at, revoked_reason, ip, user_agent from public.customer_sessions";
    for (const sql of [credentials, sessions]) {
      const rows = (await t.asUser(f.a.operatorId, (tx) => tx.query<{ organization_id: string }>(sql))).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.organization_id === f.a.orgId)).toBe(true);
      expect(await t.asUser(f.a.viewerId, (tx) => count(tx, sql))).toBe(0);
      expect(await t.asUser(f.b.ownerId, (tx) => count(tx, `${sql} where organization_id = $1`, [f.a.orgId]))).toBe(0);
    }
  });

  it("members cannot insert, update or delete credentials or sessions directly", async () => {
    for (const sql of [
      "update public.customer_access_credentials set status = 'REVOKED'",
      "delete from public.customer_access_credentials",
      "update public.customer_sessions set revoked_at = now(), revoked_reason = 'REVOKED'",
      "delete from public.customer_sessions"
    ]) {
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
    await expect(
      t.asUser(f.a.ownerId, (tx) =>
        tx.query("insert into public.customer_access_credentials (organization_id, customer_id, secret_hash, last4) values ($1, $2, $3, 'ABCD')", [
          f.a.orgId,
          customerA2,
          hex("s")
        ])
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("portal functions are executable by the service role only; admin functions by authenticated only", async () => {
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select * from portal.validate_session($1)", [hex("t")]))).rejects.toThrow(
      /permission denied/
    );
    await expect(t.asAnon((tx) => tx.query("select * from portal.create_session($1, $2, null, null)", [hex("s"), hex("t")]))).rejects.toThrow(
      /permission denied/
    );
    await expect(t.asService((tx) => tx.query("select * from public.revoke_customer_access($1)", [customerA]))).rejects.toThrow(
      /permission denied/
    );
    await expect(t.asAnon((tx) => tx.query("select * from public.revoke_customer_sessions($1)", [customerA]))).rejects.toThrow(
      /permission denied/
    );
  });

  it("composite integrity: a session uses a credential of ITS customer in ITS organization", async () => {
    const a = await withSession(f.a.ownerId, customerA);
    const insertSession = (organizationId: string, customerId: string, credentialId: string) =>
      t.asAdmin((tx) =>
        tx.query(
          `insert into public.customer_sessions (organization_id, customer_id, credential_id, token_hash, idle_expires_at, absolute_expires_at)
           values ($1, $2, $3, $4, now() + interval '1 day', now() + interval '2 days')`,
          [organizationId, customerId, credentialId, hex("t")]
        )
      );
    await expect(insertSession(f.a.orgId, customerA2, a.credentialId)).rejects.toThrow(/customer_sessions_credential_fkey/);
    await expect(insertSession(f.b.orgId, customerA, a.credentialId)).rejects.toThrow(/foreign key/);
    await expect(
      t.asAdmin((tx) =>
        tx.query(
          `insert into public.customer_access_credentials (organization_id, customer_id, secret_hash, last4, status, revoked_at, revoked_reason)
           values ($1, $2, $3, 'ABCD', 'REVOKED', now(), 'REVOKED')`,
          [f.b.orgId, customerA2, hex("s")]
        )
      )
    ).rejects.toThrow(/customer_access_credentials_customer_fkey/);
  });
});

describe("portal.create_session (login)", () => {
  it("a valid Access ID hash creates a session (7 days idle, 30 days absolute)", async () => {
    const secret = hex("secret");
    await t.asUser(f.a.ownerId, (tx) => issue(tx, customerA, secret));
    const result = await login(secret, hex("token"));
    expect(result).toMatchObject({ outcome: "OK", organization_id: f.a.orgId, customer_id: customerA, display_name: "Juan" });
    const days = (value: string | null) => Math.round((Date.parse(value as string) - Date.now()) / 86_400_000);
    expect(days(result.idle_expires_at)).toBe(7);
    expect(days(result.absolute_expires_at)).toBe(30);
  });

  it("unknown or malformed Access ID hashes reveal nothing", async () => {
    expect(await login(hex("unknown"), hex("token"))).toMatchObject({ outcome: "INVALID", organization_id: null, customer_id: null });
    expect(await login("nope", hex("token"))).toMatchObject({ outcome: "INVALID", organization_id: null });
  });

  it("expired credential -> EXPIRED; the session never outlives the credential", async () => {
    const secret = hex("secret");
    await t.asUser(f.a.ownerId, (tx) => issue(tx, customerA, secret, new Date(Date.now() + 3 * 86_400_000).toISOString()));
    const ok = await login(secret, hex("token"));
    expect(Date.parse(ok.absolute_expires_at as string)).toBeLessThanOrEqual(Date.now() + 3 * 86_400_000 + 1000);
    await t.asAdmin((tx) =>
      tx.query(
        "update public.customer_access_credentials set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where secret_hash = $1",
        [secret]
      )
    );
    expect((await login(secret, hex("token"))).outcome).toBe("EXPIRED");
    expect(await validate(ok.session_id ? (await t.asAdmin((tx) => one<{ h: string }>(tx, "select token_hash as h from public.customer_sessions where id = $1", [ok.session_id]))).h : "")).toEqual([]);
  });

  it("suspended customer -> CUSTOMER_INACTIVE; its open sessions are revoked by the database", async () => {
    const access = await withSession(f.a.ownerId, customerA2);
    await t.asUser(f.a.operatorId, (tx) => tx.query("update public.customers set status = 'SUSPENDED' where id = $1", [customerA2]));
    try {
      expect(await validate(access.token)).toEqual([]);
      expect((await login(access.secret, hex("token"))).outcome).toBe("CUSTOMER_INACTIVE");
      const session = await t.asAdmin((tx) => one<{ revoked_reason: string }>(tx, "select revoked_reason from public.customer_sessions where id = $1", [access.sessionId]));
      expect(session.revoked_reason).toBe("CUSTOMER_SUSPENDED");
    } finally {
      await t.asUser(f.a.operatorId, (tx) => tx.query("update public.customers set status = 'ACTIVE' where id = $1", [customerA2]));
    }
    // Reactivation does not revive old sessions; the credential still works.
    expect(await validate(access.token)).toEqual([]);
    expect((await login(access.secret, hex("token"))).outcome).toBe("OK");
  });

  it("suspended organization -> ORGANIZATION_INACTIVE and sessions are rejected (kept, usable again after reactivation); B unaffected", async () => {
    const a = await withSession(f.a.ownerId, customerA);
    const b = await withSession(f.b.ownerId, customerB);
    await t.asAdmin((tx) => tx.query("update public.organizations set status = 'SUSPENDED' where id = $1", [f.a.orgId]));
    try {
      expect((await login(a.secret, hex("token"))).outcome).toBe("ORGANIZATION_INACTIVE");
      expect(await validate(a.token)).toEqual([]);
      expect(await validate(b.token)).toHaveLength(1);
      expect((await login(b.secret, hex("token"))).outcome).toBe("OK");
    } finally {
      await t.asAdmin((tx) => tx.query("update public.organizations set status = 'ACTIVE' where id = $1", [f.a.orgId]));
    }
    expect(await validate(a.token)).toHaveLength(1);
  });
});

describe("portal.validate_session / portal.end_session", () => {
  it("returns the customer context, its organization name and the active bots' portal settings", async () => {
    const access = await withSession(f.a.ownerId, customerA);
    const [row] = await validate(access.token);
    expect(row).toMatchObject({
      session_id: access.sessionId,
      organization_id: f.a.orgId,
      customer_id: customerA,
      display_name: "Juan",
      customer_status: "ACTIVE",
      organization_name: "Org A",
      bots: [{ name: "Netflix", portalSettings: { showBody: false, showAttachments: false, fields: [] } }]
    });
  });

  it("an unknown token, a revoked session, an idle-expired and an absolute-expired session are rejected", async () => {
    expect(await validate(hex("unknown"))).toEqual([]);
    expect(await validate("not-hex")).toEqual([]);

    const idle = await withSession(f.a.ownerId, customerA);
    await t.asAdmin((tx) => tx.query("update public.customer_sessions set idle_expires_at = now() - interval '1 second' where id = $1", [idle.sessionId]));
    expect(await validate(idle.token)).toEqual([]);

    const absolute = await withSession(f.a.ownerId, customerA);
    await t.asAdmin((tx) =>
      tx.query(
        "update public.customer_sessions set created_at = now() - interval '31 days', absolute_expires_at = now() - interval '1 day', idle_expires_at = now() - interval '1 day 1 second' where id = $1",
        [absolute.sessionId]
      )
    );
    expect(await validate(absolute.token)).toEqual([]);
  });

  it("last_seen_at slides at most every 5 minutes, never beyond the absolute expiry", async () => {
    const access = await withSession(f.a.ownerId, customerA);
    await t.asAdmin((tx) =>
      tx.query("update public.customer_sessions set last_seen_at = now() - interval '10 minutes', idle_expires_at = now() + interval '1 hour' where id = $1", [
        access.sessionId
      ])
    );
    const [row] = await validate(access.token);
    expect(Math.round((Date.parse(String(row?.idle_expires_at)) - Date.now()) / 86_400_000)).toBe(7);
    const fresh = await t.asAdmin((tx) => one<{ recent: boolean }>(tx, "select last_seen_at > now() - interval '1 minute' as recent from public.customer_sessions where id = $1", [access.sessionId]));
    expect(fresh.recent).toBe(true);
  });

  it("end_session revokes only the session of that token (LOGOUT)", async () => {
    const first = await withSession(f.a.ownerId, customerA);
    const other = hex("token");
    expect((await login(first.secret, other)).outcome).toBe("OK");
    const ended = await t.asService((tx) => tx.query<{ session_id: string }>("select * from portal.end_session($1)", [first.token]));
    expect(ended.rows).toEqual([{ session_id: first.sessionId, organization_id: f.a.orgId, customer_id: customerA }]);
    expect(await validate(first.token)).toEqual([]);
    expect(await validate(other)).toHaveLength(1);
    expect((await t.asService((tx) => tx.query("select * from portal.end_session($1)", [first.token]))).rows).toEqual([]);
  });

  it("revoke_customer_sessions: one session or all of them, inside the caller's organization only", async () => {
    const access = await withSession(f.a.ownerId, customerA);
    const second = hex("token");
    await login(access.secret, second);
    const one_ = await t.asUser(f.a.adminId, (tx) =>
      one<{ n: number }>(tx, "select public.revoke_customer_sessions($1, $2) as n", [customerA, access.sessionId])
    );
    expect(one_.n).toBe(1);
    expect(await validate(access.token)).toEqual([]);
    expect(await validate(second)).toHaveLength(1);

    await expect(t.asUser(f.b.ownerId, (tx) => tx.query("select public.revoke_customer_sessions($1)", [customerA]))).rejects.toThrow(/Customer not found/);
    expect(await validate(second)).toHaveLength(1);

    const all = await t.asUser(f.a.operatorId, (tx) => one<{ n: number }>(tx, "select public.revoke_customer_sessions($1) as n", [customerA]));
    expect(all.n).toBeGreaterThanOrEqual(1);
    expect(await validate(second)).toEqual([]);
  });

  it("a session of organization B is never usable to read A (context comes only from the token)", async () => {
    const b = await withSession(f.b.ownerId, customerB);
    const [row] = await validate(b.token);
    expect(row).toMatchObject({ organization_id: f.b.orgId, customer_id: customerB, bots: [] });
  });
});
