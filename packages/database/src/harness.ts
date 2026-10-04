import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";

/*
 * Test harness that runs the REAL files in supabase/migrations against an
 * embedded PostgreSQL (PGlite, WASM). A small shim reproduces the parts of
 * the Supabase platform the migrations depend on:
 *
 *   - roles anon / authenticated / service_role (BYPASSRLS)
 *   - Supabase default privileges on the public schema, either as the
 *     local CLI stack grants them or as EmailBot Production has them
 *   - auth.users and auth.uid() (reads request.jwt.claim(s) like Supabase)
 *   - storage.buckets
 *
 * It is not a replacement for `supabase db reset` against the real stack,
 * but it executes every policy, trigger and function for real, so RLS and
 * tenant isolation are verified without Docker.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, "../../../supabase/migrations");

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create schema storage;
create schema extensions;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant all on all tables in schema storage to service_role;
`;

/*
 * Default privileges for objects that postgres creates in schema public.
 * They differ between environments, and migrations must not depend on them.
 */
export const DEFAULT_PRIVILEGES = {
  /** Supabase CLI local stack: every API role gets everything. */
  local: `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`,
  /**
   * EmailBot Production (pg_default_acl read on 2026-10-03):
   *   tables    -> anon/authenticated/service_role = Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN)
   *   sequences -> postgres only
   *   functions -> postgres only (no PUBLIC EXECUTE)
   */
  production: `
alter default privileges in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public;
`
} as const;

export type DefaultPrivilegesProfile = keyof typeof DEFAULT_PRIVILEGES;

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export type Tx = Transaction;

export interface TestDatabase {
  db: PGlite;
  /** Runs fn as the `authenticated` role with auth.uid() = userId. Rolled back on error. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs fn as service_role (bypasses RLS, like the backend/worker). */
  asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs fn as the anonymous role. */
  asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs fn as the database owner (session role, like postgres in Supabase:
   * owns the tables, runs migrations and the dashboard). Used to seed data and
   * to prove that triggers protect invariants even against the owner.
   */
  asAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Creates an auth user (which also creates its profile through the trigger). */
  createUser(email: string): Promise<string>;
  close(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** SQL executed after the platform shim and before the migrations (e.g. objects found on the remote project). */
  preMigrationSql?: string;
  /** Which environment's default privileges to emulate (default: "local"). */
  defaultPrivileges?: DefaultPrivilegesProfile;
  /** Apply migrations up to, but excluding, the first file whose name starts with this prefix. */
  stopBefore?: string;
}

export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  await db.exec(DEFAULT_PRIVILEGES[options.defaultPrivileges ?? "local"]);
  if (options.preMigrationSql) await db.exec(options.preMigrationSql);

  for (const file of listMigrationFiles()) {
    if (options.stopBefore && file.startsWith(options.stopBefore)) break;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }

  async function runAs<T>(role: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
      await tx.exec(`set local role ${role}`);
      return fn(tx);
    });
  }

  return {
    db,
    asUser: (userId, fn) => runAs("authenticated", userId, fn),
    asService: (fn) => runAs("service_role", null, fn),
    asAnon: (fn) => runAs("anon", null, fn),
    asAdmin: (fn) => db.transaction(fn),
    async createUser(email) {
      const result = await db.query<{ id: string }>(
        "insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id",
        [email, JSON.stringify({ full_name: email.split("@")[0] })]
      );
      return (result.rows[0] as { id: string }).id;
    },
    close: () => db.close()
  };
}
