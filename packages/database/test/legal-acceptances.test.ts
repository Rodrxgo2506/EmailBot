import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { count, one } from "./fixtures.js";

/*
 * EmailBot V2 phase 7: recorded acceptance of the Terms and the Privacy
 * Policy at sign-up (public.legal_acceptances, append-only, written only by
 * the trigger on auth.users with the database time).
 */

let t: TestDatabase;
let sequence = 0;

/** @emailbot/types CURRENT_LEGAL_VERSIONS, read from its source (this package does not depend on @emailbot/types). */
const CURRENT = (() => {
  const source = readFileSync(new URL("../../types/src/legal.ts", import.meta.url), "utf8");
  const read = (document: string) => new RegExp(`${document}:\\s*"([0-9]{1,3}\\.[0-9]{1,3})"`).exec(source)?.[1];
  const terms = read("terms");
  const privacy = read("privacy");
  if (!terms || !privacy) throw new Error("CURRENT_LEGAL_VERSIONS not found in packages/types/src/legal.ts");
  return { terms, privacy };
})();
const ACCEPTED = { legal_accepted: true };

/** Simulates Supabase Auth creating a user with the sign-up metadata sent by the web app. */
async function signUp(metadata: Record<string, unknown>): Promise<string> {
  const email = `user-${++sequence}@legal.test`;
  const row = await t.asAdmin((tx) =>
    one<{ id: string }>(tx, "insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id", [
      email,
      JSON.stringify(metadata)
    ])
  );
  return row.id;
}

const acceptances = (userId: string) =>
  t.asAdmin(async (tx) =>
    (
      await tx.query<{ document: string; version: string; source: string; recent: boolean }>(
        "select document, version, source, accepted_at > now() - interval '1 minute' as recent from public.legal_acceptances where user_id = $1 order by document",
        [userId]
      )
    ).rows
  );

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.close();
});

describe("sign-up acceptance (server versions)", () => {
  it("the database mirror of the current versions equals @emailbot/types CURRENT_LEGAL_VERSIONS", async () => {
    const row = await t.asAdmin((tx) => one<{ terms: string; privacy: string }>(tx, "select terms, privacy from private.current_legal_versions()"));
    expect(row).toEqual(CURRENT);
  });

  it("records both documents with the SERVER's current versions, the database time and the source; the profile is still created", async () => {
    const user = await signUp({ full_name: "Ana", ...ACCEPTED });
    expect(await acceptances(user)).toEqual([
      { document: "privacy", version: CURRENT.privacy, source: "signup", recent: true },
      { document: "terms", version: CURRENT.terms, source: "signup", recent: true }
    ]);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.profiles where id = $1 and full_name = 'Ana'", [user]))).toBe(1);
  });

  it("users created without the metadata (existing users, administrators) are created normally, with no acceptance", async () => {
    const user = await signUp({ full_name: "Sin metadata" });
    expect(await acceptances(user)).toEqual([]);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.profiles where id = $1", [user]))).toBe(1);
  });

  it.each([
    ["an older version", { legal_terms_version: "1.0", legal_privacy_version: "1.0" }],
    ["a future version", { legal_terms_version: "9.9", legal_privacy_version: "99.0" }],
    ["malformed values", { legal_terms_version: "2.0'; drop table public.profiles; --", legal_privacy_version: null }]
  ])("versions sent by the client are ignored: %s still records only the current versions", async (_label, metadata) => {
    const user = await signUp({ full_name: "X", ...ACCEPTED, ...metadata });
    expect((await acceptances(user)).map((row) => `${row.document}@${row.version}`)).toEqual([`privacy@${CURRENT.privacy}`, `terms@${CURRENT.terms}`]);
  });

  it.each([
    ["versions without the acceptance flag (an old version cannot become an acceptance)", { legal_terms_version: "1.0", legal_privacy_version: "1.0" }],
    ["the current versions without the flag", { legal_terms_version: CURRENT.terms, legal_privacy_version: CURRENT.privacy }],
    ["the string \"true\"", { legal_accepted: "true" }],
    ["the number 1", { legal_accepted: 1 }],
    ["false", { legal_accepted: false }],
    ["null", { legal_accepted: null }],
    ["an object", { legal_accepted: { version: "2.0" } }]
  ])("records nothing for %s, without blocking the sign-up", async (_label, metadata) => {
    const user = await signUp({ full_name: "X", ...metadata });
    expect(await acceptances(user)).toEqual([]);
    expect(await t.asAdmin((tx) => count(tx, "select 1 from public.profiles where id = $1", [user]))).toBe(1);
  });
});

describe("integrity and access", () => {
  it("rows cannot be modified or deleted, even by the table owner", async () => {
    const user = await signUp(ACCEPTED);
    await expect(t.asAdmin((tx) => tx.query("update public.legal_acceptances set version = '9.9' where user_id = $1", [user]))).rejects.toThrow(/append-only/);
    await expect(t.asAdmin((tx) => tx.query("update public.legal_acceptances set accepted_at = now() - interval '1 year' where user_id = $1", [user]))).rejects.toThrow(
      /append-only/
    );
    await expect(t.asAdmin((tx) => tx.query("delete from public.legal_acceptances where user_id = $1", [user]))).rejects.toThrow(/append-only/);
    expect(await acceptances(user)).toHaveLength(2);
  });

  it("deleting the user removes its rows (cascade)", async () => {
    const user = await signUp(ACCEPTED);
    await t.asAdmin((tx) => tx.query("delete from auth.users where id = $1", [user]));
    expect(await acceptances(user)).toEqual([]);
  });

  it("neither the user (authenticated) nor anon can read or write the table, not even the user's own rows", async () => {
    const user = await signUp(ACCEPTED);
    await expect(t.asUser(user, (tx) => tx.query("select version from public.legal_acceptances"))).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(user, (tx) => tx.query("insert into public.legal_acceptances (user_id, document, version, source) values ($1, 'terms', '3.0', 'signup')", [user]))
    ).rejects.toThrow(/permission denied/);
    await expect(t.asAnon((tx) => tx.query("select 1 from public.legal_acceptances"))).rejects.toThrow(/permission denied/);
    await expect(
      t.asAnon((tx) => tx.query("insert into public.legal_acceptances (user_id, document, version, source) values ($1, 'terms', '3.0', 'signup')", [user]))
    ).rejects.toThrow(/permission denied/);
  });

  it("RLS is enabled and the trigger functions (and the versions mirror) are not executable by any API role", async () => {
    const rls = await t.asAdmin((tx) => one<{ on: boolean }>(tx, "select relrowsecurity as on from pg_class where oid = 'public.legal_acceptances'::regclass"));
    expect(rls.on).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const fn of ["private.record_signup_legal_acceptance()", "private.prevent_legal_acceptance_mutation()", "private.current_legal_versions()"]) {
        const row = await t.asAdmin((tx) => one<{ ok: boolean }>(tx, "select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn]));
        expect(row.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});

describe("re-acceptance after login (service role, API)", () => {
  const insertAs = "insert into public.legal_acceptances (user_id, document, version, source) values ($1, $2, $3, 'reacceptance')";

  it("an existing user without acceptance gets rows with the database time; source reacceptance", async () => {
    const user = await signUp({ full_name: "Existente" });
    expect(await acceptances(user)).toEqual([]);
    await t.asService(async (tx) => {
      await tx.query(insertAs, [user, "terms", "2.0"]);
      await tx.query(insertAs, [user, "privacy", "2.0"]);
    });
    expect(await acceptances(user)).toEqual([
      { document: "privacy", version: "2.0", source: "reacceptance", recent: true },
      { document: "terms", version: "2.0", source: "reacceptance", recent: true }
    ]);
    // The API reads the caller's rows with the same role.
    expect(await t.asService((tx) => count(tx, "select 1 from public.legal_acceptances where user_id = $1", [user]))).toBe(2);
  });

  it("a newer version is a new row; the older acceptance stays as it was", async () => {
    const user = await signUp(ACCEPTED);
    await t.asService((tx) => tx.query(insertAs, [user, "terms", "2.1"]));
    expect((await acceptances(user)).map((row) => `${row.document}@${row.version}/${row.source}`).sort()).toEqual([
      "privacy@2.0/signup",
      "terms@2.0/signup",
      "terms@2.1/reacceptance"
    ]);
  });

  it("the service role cannot choose the time or the id, nor change or delete a row", async () => {
    const user = await signUp({ full_name: "X" });
    await expect(
      t.asService((tx) =>
        tx.query(
          "insert into public.legal_acceptances (user_id, document, version, source, accepted_at) values ($1, 'terms', '2.0', 'reacceptance', now() - interval '1 year')",
          [user]
        )
      )
    ).rejects.toThrow(/permission denied/);
    await t.asService((tx) => tx.query(insertAs, [user, "terms", "2.0"]));
    await expect(t.asService((tx) => tx.query("update public.legal_acceptances set accepted_at = now() - interval '1 year' where user_id = $1", [user]))).rejects.toThrow(
      /permission denied/
    );
    await expect(t.asService((tx) => tx.query("delete from public.legal_acceptances where user_id = $1", [user]))).rejects.toThrow(/permission denied/);
  });

  it("rejects unknown users, documents, sources and malformed versions", async () => {
    const user = await signUp({ full_name: "X" });
    await expect(t.asService((tx) => tx.query(insertAs, ["00000000-0000-4000-8000-000000000000", "terms", "2.0"]))).rejects.toThrow(/foreign key/);
    await expect(t.asService((tx) => tx.query(insertAs, [user, "cookies", "2.0"]))).rejects.toThrow(/legal_acceptances_document/);
    await expect(t.asService((tx) => tx.query(insertAs, [user, "terms", "latest"]))).rejects.toThrow(/legal_acceptances_version_format/);
    await expect(
      t.asService((tx) => tx.query("insert into public.legal_acceptances (user_id, document, version, source) values ($1, 'terms', '2.0', 'admin')", [user]))
    ).rejects.toThrow(/legal_acceptances_source/);
  });

  it("deleting the user still removes its rows of both sources", async () => {
    const user = await signUp(ACCEPTED);
    await t.asService((tx) => tx.query(insertAs, [user, "terms", "2.1"]));
    await t.asAdmin((tx) => tx.query("delete from auth.users where id = $1", [user]));
    expect(await acceptances(user)).toEqual([]);
  });
});
