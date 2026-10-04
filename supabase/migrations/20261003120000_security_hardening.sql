-- ============================================================
-- EmailBot - Migration 6
--
-- Security hardening found during the production-readiness audit.
-- Additive only: revokes privileges, adds one validation trigger.
-- No table/column is dropped and no data is modified.
-- ============================================================


-- ============================================================
-- 1. ATTACHMENT STORAGE LOCATION IS SERVER-OWNED
--
-- Migration 3 granted INSERT/UPDATE on storage_bucket, storage_path
-- and storage_uploaded to the authenticated role (OPERATOR and above
-- through RLS). The API signs download URLs with the service role
-- using these columns, so a user able to write them could point an
-- attachment of their own tenant at ANY object of ANY bucket and get
-- a signed URL for it (confused deputy / cross-tenant read).
--
-- Only the worker (service role) uploads objects and records where
-- they live. The API additionally validates the exact path layout
-- before signing (defense in depth).
-- ============================================================

revoke insert (storage_bucket, storage_path, storage_uploaded)
on table public.email_attachments
from authenticated;

revoke update (storage_bucket, storage_path, storage_uploaded)
on table public.email_attachments
from authenticated;


-- ============================================================
-- 2. RULE CATEGORY MUST BELONG TO THE RULE'S ORGANIZATION
--
-- email_rules.category_id only had a foreign key. Through the Data API
-- an OWNER/ADMIN could reference a category of another organization.
-- It could not leak data (emails enforce tenant consistency), but it
-- made every matching email fail processing. Same pattern as
-- private.validate_email_tenant_relationships() (migration 3).
-- ============================================================

create or replace function private.validate_rule_tenant_relationships()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  category_organization_id uuid;
begin

  if new.category_id is null then
    return new;
  end if;

  select c.organization_id
  into category_organization_id
  from public.categories c
  where c.id = new.category_id;

  if category_organization_id is null then
    raise exception 'Category not found';
  end if;

  if category_organization_id <> new.organization_id then
    raise exception 'Category does not belong to the rule organization';
  end if;

  return new;
end;
$$;

create trigger email_rules_validate_tenant_relationships
before insert or update of category_id, organization_id
on public.email_rules
for each row
execute function private.validate_rule_tenant_relationships();

revoke all on function private.validate_rule_tenant_relationships()
from public, anon, authenticated;

comment on function private.validate_rule_tenant_relationships() is
  'Ensures a rule only references a category of its own organization.';


-- ============================================================
-- 3. public.rls_auto_enable() (NOT created by this repository)
--
-- Found on the remote project: an event-trigger function (SECURITY
-- DEFINER, owner postgres) used by the "ensure_rls" event trigger that
-- enables RLS on every new table in public. Its ACL is the default,
-- so EXECUTE is granted to PUBLIC (hence anon/authenticated), which the
-- Supabase linter reports.
--
-- It returns event_trigger, so PostgreSQL refuses direct calls (it can
-- only run as an event trigger): not exploitable through the Data API.
-- Revoking EXECUTE is still the correct least-privilege state and does
-- not affect the event trigger (event triggers do not check EXECUTE).
--
-- Conditional: the function does not exist in a fresh/local database.
-- ============================================================

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
