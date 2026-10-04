-- ============================================================
-- EmailBot - Migration 7
--
-- Explicit, minimal table privileges for service_role.
--
-- Why: migrations 1-6 never granted anything to service_role; they
-- relied on the Supabase default privileges for objects created by
-- postgres in schema public. Those defaults differ between
-- environments (inspected read-only on 2026-10-03):
--
--   local (Supabase CLI)  service_role = arwdDxtm (ALL) on new tables
--   EmailBot Production   service_role = Dxtm only (no SELECT, INSERT,
--                         UPDATE or DELETE) on new tables
--
-- In production the API privileged layer and the worker would get
-- "permission denied" on every table. Relying on defaults also gave
-- service_role far more than it needs locally.
--
-- Fix: make the privileges explicit and identical everywhere.
--   1. revoke whatever service_role inherited on EmailBot tables;
--   2. grant only what apps/api (repositories/supabase/privileged.ts)
--      and apps/worker (infrastructure/supabase-stores.ts) use.
--
-- service_role has BYPASSRLS, so RLS does not limit it: these grants
-- ARE its boundary. No DELETE, TRUNCATE, REFERENCES, TRIGGER or
-- MAINTAIN is granted. Tables not listed below (organizations,
-- categories) get no privileges: the backend never accesses them with
-- the service role. Foreign-key checks and SECURITY DEFINER triggers
-- run with the table owner's privileges and are not affected.
--
-- anon/authenticated/postgres privileges are not changed.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Start from a clean, deterministic state.
-- ------------------------------------------------------------

revoke all on table
  public.profiles,
  public.organizations,
  public.organization_members,
  public.organization_settings,
  public.email_accounts,
  public.categories,
  public.email_rules,
  public.emails,
  public.email_attachments,
  public.audit_logs
from service_role;


-- ------------------------------------------------------------
-- 2. Minimal grants.
-- ------------------------------------------------------------

-- API: OAuth connect (select existing / insert / update with encrypted
-- tokens), IMAP create, disconnect. Worker: load account, save
-- refreshed tokens, sync state and errors.
grant select, insert, update
on table public.email_accounts
to service_role;

-- Worker: duplicate pre-check and idempotent insert
-- (INSERT ... ON CONFLICT DO NOTHING RETURNING id).
grant select, insert
on table public.emails
to service_role;

-- Worker: attachment metadata (INSERT ... RETURNING) and storage
-- location once the object is uploaded (UPDATE).
grant select, insert, update
on table public.email_attachments
to service_role;

-- API: immutable audit trail writes (no RETURNING, no reads).
grant insert
on table public.audit_logs
to service_role;

-- API: add member by email (only confirmed users).
grant select
on table public.profiles
to service_role;

-- API: re-check OWNER/ADMIN in the OAuth callback.
grant select
on table public.organization_members
to service_role;

-- Worker: enabled rules of the organization.
grant select
on table public.email_rules
to service_role;

-- Worker: processing / attachments / notification settings.
grant select
on table public.organization_settings
to service_role;


-- ------------------------------------------------------------
-- 3. SECURITY DEFINER functions in public.
--
-- Migrations 1-6 revoked EXECUTE from public/anon/authenticated only.
-- With the local default privileges service_role could still execute
-- them (production defaults never granted it). The backend never calls
-- them with the service role: user RPCs run with the caller's JWT and
-- the auth triggers only run as triggers. Revoke for parity.
-- ------------------------------------------------------------

revoke execute on function
  public.create_organization(text, text),
  public.transfer_organization_ownership(uuid, uuid),
  public.handle_new_user(),
  public.handle_user_updated()
from service_role;
