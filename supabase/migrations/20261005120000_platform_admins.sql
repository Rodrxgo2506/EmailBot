-- ============================================================
-- EmailBot V2 - Phase 6: platform administrators (Super Admin)
--
-- Platform administration is a separate plane, NOT an organization role:
--   auth.users -> profiles -> platform_admins -> /api/admin/* (service role)
--
-- - public.platform_admins is the only source of truth. Not a profile flag,
--   not JWT metadata, not organization_members.role. Revoked at once by
--   deleting the row. Rows are created with SQL by the database owner only
--   (docs/v2-implementation.md, "Fase 6"); no API creates platform admins.
-- - public.platform_audit_logs records every administrative action
--   (immutable, like audit_logs). Organization audit_logs stay untouched.
-- - No existing RLS policy changes: there is NO "or is_platform_admin()"
--   exception anywhere. The admin plane reads metadata through the admin.*
--   functions (next migration), never e-mail content or credentials.
--
-- RLS template (both tables):
--   SELECT / INSERT / UPDATE / DELETE  nobody through the Data API:
--     RLS enabled without policies, no grant to anon, authenticated or
--     service_role. Access only through SECURITY DEFINER admin.* functions.
--   Cross-organization: n/a (platform scope).
--   Customer (portal): no.
--   Super Admin: through admin.* only (identity re-checked in each call).
--   service_role: EXECUTE on admin.* only (no table privilege).
-- ============================================================


-- ============================================================
-- PLATFORM ADMINS
-- ============================================================

create table public.platform_admins (
  id uuid primary key default gen_random_uuid(),

  -- profiles.id is auth.users.id (cascade): an admin is always an existing
  -- Supabase Auth user, and deleting the user removes the privilege.
  user_id uuid not null
    references public.profiles(id)
    on delete cascade,

  created_at timestamptz not null default now(),

  -- Who granted it (NULL when granted with SQL or after that user was deleted).
  created_by uuid
    references public.profiles(id)
    on delete set null,

  constraint platform_admins_user_unique
    unique (user_id)
);

comment on table public.platform_admins is
  'EmailBot platform administrators (Super Admin). Separate from organization roles; managed with SQL by the database owner.';

alter table public.platform_admins enable row level security;

revoke all on table public.platform_admins
from public, anon, authenticated, service_role;


-- ============================================================
-- PLATFORM AUDIT LOGS (immutable)
-- ============================================================

create table public.platform_audit_logs (
  id uuid primary key default gen_random_uuid(),

  actor_user_id uuid
    references public.profiles(id)
    on delete set null,

  -- "organization.created", "organization.suspended", ...
  action text not null,

  target_type text not null,

  target_id uuid,

  -- The audit trail outlives the organization (SET NULL, never cascade).
  organization_id uuid
    references public.organizations(id)
    on delete set null,

  metadata jsonb not null default '{}'::jsonb,

  request_id text,

  created_at timestamptz not null default now(),

  constraint platform_audit_logs_action_format
    check (
      char_length(action) <= 100
      and action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    ),

  constraint platform_audit_logs_target_type_length
    check (char_length(target_type) between 1 and 100),

  constraint platform_audit_logs_metadata_object
    check (jsonb_typeof(metadata) = 'object'),

  constraint platform_audit_logs_request_id_length
    check (request_id is null or char_length(request_id) <= 200)
);

comment on table public.platform_audit_logs is
  'Immutable trail of platform administration actions (EmailBot V2 phase 6). Never contains secrets or e-mail content.';

create index platform_audit_logs_created_idx
  on public.platform_audit_logs(created_at desc, id desc);

create index platform_audit_logs_organization_idx
  on public.platform_audit_logs(organization_id, created_at desc)
  where organization_id is not null;

alter table public.platform_audit_logs enable row level security;

revoke all on table public.platform_audit_logs
from public, anon, authenticated, service_role;


-- Same technique as private.prevent_audit_log_mutation: records never
-- change, except the ON DELETE SET NULL of a deleted actor profile or a
-- deleted organization (every other column unchanged). DELETE is refused.
create or replace function private.prevent_platform_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  if tg_op = 'UPDATE'
    and (
      new.id,
      new.action,
      new.target_type,
      new.target_id,
      new.metadata,
      new.request_id,
      new.created_at
    ) is not distinct from (
      old.id,
      old.action,
      old.target_type,
      old.target_id,
      old.metadata,
      old.request_id,
      old.created_at
    )
    and (
      new.actor_user_id is not distinct from old.actor_user_id
      or (
        new.actor_user_id is null
        and not exists (select 1 from public.profiles p where p.id = old.actor_user_id)
      )
    )
    and (
      new.organization_id is not distinct from old.organization_id
      or (
        new.organization_id is null
        and not exists (select 1 from public.organizations o where o.id = old.organization_id)
      )
    )
  then
    return new;
  end if;

  raise exception
    'Platform audit logs are immutable and cannot be modified or deleted';

end;
$$;

revoke all on function private.prevent_platform_audit_log_mutation()
from public, anon, authenticated, service_role;

create trigger platform_audit_logs_prevent_update
before update on public.platform_audit_logs
for each row
execute function private.prevent_platform_audit_log_mutation();

create trigger platform_audit_logs_prevent_delete
before delete on public.platform_audit_logs
for each row
execute function private.prevent_platform_audit_log_mutation();


-- ============================================================
-- private.is_platform_admin
--
-- auth.uid() by default; only platform_admins decides (no metadata).
-- SECURITY INVOKER on purpose: it is only called inside the admin.*
-- SECURITY DEFINER functions (owner context) and is never used in an RLS
-- policy, so it needs no elevated rights. EXECUTE granted to no API role.
-- ============================================================

create or replace function private.is_platform_admin(
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.platform_admins pa
      where pa.user_id = p_user_id
    );
$$;

revoke all on function private.is_platform_admin(uuid)
from public, anon, authenticated, service_role;

-- Raises 42501 (insufficient_privilege) unless the actor is a platform admin.
create or replace function private.assert_platform_admin(
  p_actor_id uuid
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.is_platform_admin(p_actor_id) then
    raise exception 'Platform administrator access required'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.assert_platform_admin(uuid)
from public, anon, authenticated, service_role;
