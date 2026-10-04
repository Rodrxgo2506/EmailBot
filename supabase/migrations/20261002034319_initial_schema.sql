-- ============================================================
-- EmailBot - Initial Schema v2
--
-- Organizations, profiles, membership and secure RBAC
-- ============================================================


-- ============================================================
-- PRIVATE SCHEMA
--
-- Internal security-definer helpers.
-- This schema must NOT be exposed through the Data API.
-- ============================================================

create schema if not exists private;


-- ============================================================
-- ENUMS
-- ============================================================

create type public.organization_role as enum (
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'VIEWER'
);

create type public.organization_plan as enum (
  'FREE',
  'PRO',
  'BUSINESS'
);

create type public.organization_status as enum (
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED'
);


-- ============================================================
-- PROFILES
--
-- Application profile associated with a Supabase Auth user.
-- ============================================================

create table public.profiles (
  id uuid primary key
    references auth.users(id)
    on delete cascade,

  email text,

  full_name text,

  avatar_url text,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile associated with a Supabase Auth user.';


-- ============================================================
-- ORGANIZATIONS
--
-- Main tenant/workspace of EmailBot.
-- ============================================================

create table public.organizations (
  id uuid primary key default gen_random_uuid(),

  name text not null,

  slug text not null unique,

  plan public.organization_plan not null default 'FREE',

  status public.organization_status not null default 'ACTIVE',

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint organizations_name_length
    check (
      char_length(trim(name)) between 2 and 120
    ),

  constraint organizations_slug_format
    check (
      slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    )
);

comment on table public.organizations is
  'EmailBot tenant/workspace. All tenant-owned resources reference this table.';


-- ============================================================
-- ORGANIZATION MEMBERS
--
-- Links users to organizations with tenant-scoped RBAC.
-- ============================================================

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  user_id uuid not null
    references public.profiles(id)
    on delete cascade,

  role public.organization_role not null default 'VIEWER',

  created_at timestamptz not null default now(),

  constraint organization_members_unique_user
    unique (organization_id, user_id)
);

comment on table public.organization_members is
  'Users belonging to EmailBot organizations with tenant-scoped roles.';


-- ============================================================
-- INDEXES
-- ============================================================

create index organization_members_user_id_idx
  on public.organization_members(user_id);

create index organization_members_organization_id_idx
  on public.organization_members(organization_id);

create index organizations_status_idx
  on public.organizations(status);

-- Exactly one OWNER per organization.
--
-- Ownership changes are performed through the dedicated
-- transfer_organization_ownership() function.
create unique index organization_members_one_owner_idx
  on public.organization_members(organization_id)
  where role = 'OWNER';


-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();


create trigger organizations_set_updated_at
before update on public.organizations
for each row
execute function public.set_updated_at();


-- ============================================================
-- PROFILE AUTO-CREATION
--
-- Creates a profile whenever a Supabase Auth user is created.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  insert into public.profiles (
    id,
    email,
    full_name,
    avatar_url
  )
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
  set
    email = excluded.email,

    full_name = coalesce(
      excluded.full_name,
      public.profiles.full_name
    ),

    avatar_url = coalesce(
      excluded.avatar_url,
      public.profiles.avatar_url
    ),

    updated_at = now();

  return new;

end;
$$;


create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();


-- ============================================================
-- PROFILE SYNCHRONIZATION
--
-- Keeps email/name/avatar synchronized when the Auth user
-- changes its relevant metadata.
-- ============================================================

create or replace function public.handle_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  update public.profiles
  set
    email = new.email,

    full_name = coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      public.profiles.full_name
    ),

    avatar_url = coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      public.profiles.avatar_url
    ),

    updated_at = now()

  where id = new.id;

  return new;

end;
$$;


create trigger on_auth_user_updated
after update of email, raw_user_meta_data on auth.users
for each row
execute function public.handle_user_updated();


-- ============================================================
-- PRIVATE SECURITY HELPERS
-- ============================================================


-- ------------------------------------------------------------
-- Checks whether the authenticated user belongs to an
-- organization.
-- ------------------------------------------------------------

create or replace function private.is_organization_member(
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = target_organization_id
      and om.user_id = (select auth.uid())
  );
$$;


-- ------------------------------------------------------------
-- Checks whether the authenticated user has one of the
-- requested roles in an organization.
-- ------------------------------------------------------------

create or replace function private.has_organization_role(
  target_organization_id uuid,
  allowed_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = target_organization_id
      and om.user_id = (select auth.uid())
      and om.role = any(allowed_roles)
  );
$$;


-- ------------------------------------------------------------
-- Determines whether a profile belongs to someone who shares
-- an organization with the authenticated user.
-- ------------------------------------------------------------

create or replace function private.can_view_profile(
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_user_id = (select auth.uid())
    or exists (
      select 1
      from public.organization_members target_member
      join public.organization_members current_member
        on current_member.organization_id = target_member.organization_id
      where target_member.user_id = target_user_id
        and current_member.user_id = (select auth.uid())
    );
$$;


-- ============================================================
-- MEMBER IMMUTABILITY
--
-- organization_id and user_id must never be changed through
-- an UPDATE. Membership changes should affect only the role.
-- ============================================================

create or replace function private.prevent_membership_identity_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin

  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id cannot be changed for an existing membership';
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'user_id cannot be changed for an existing membership';
  end if;

  return new;

end;
$$;


create trigger organization_members_identity_immutable
before update on public.organization_members
for each row
execute function private.prevent_membership_identity_change();


-- ============================================================
-- OWNER INTEGRITY
--
-- Guarantees that an organization cannot finish a transaction
-- without an OWNER.
--
-- It is deferred so ownership transfer can happen atomically:
--
--   old OWNER -> ADMIN
--   new OWNER -> OWNER
--
-- inside the same transaction.
-- ============================================================

create or replace function private.enforce_organization_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
begin

  if tg_op = 'DELETE' then
    target_organization_id := old.organization_id;
  else
    target_organization_id := new.organization_id;
  end if;

  -- Allow organization deletion to cascade through members.
  if not exists (
    select 1
    from public.organizations o
    where o.id = target_organization_id
  ) then
    return null;
  end if;

  if not exists (
    select 1
    from public.organization_members om
    where om.organization_id = target_organization_id
      and om.role = 'OWNER'
  ) then
    raise exception
      'Organization % must always have an OWNER',
      target_organization_id;
  end if;

  return null;

end;
$$;


create constraint trigger organization_members_owner_integrity
after insert or update or delete
on public.organization_members
deferrable initially deferred
for each row
execute function private.enforce_organization_owner();


-- ============================================================
-- CREATE ORGANIZATION
--
-- This is the ONLY normal client-facing way to create an
-- organization.
--
-- The authenticated caller automatically becomes OWNER.
-- ============================================================

create or replace function public.create_organization(
  p_name text,
  p_slug text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_organization_id uuid;
  current_user_id uuid;
  normalized_name text;
  normalized_slug text;
begin

  current_user_id := (select auth.uid());

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  normalized_name := trim(p_name);
  normalized_slug := lower(trim(p_slug));

  if char_length(normalized_name) < 2 then
    raise exception 'Organization name must contain at least 2 characters';
  end if;

  if char_length(normalized_name) > 120 then
    raise exception 'Organization name cannot exceed 120 characters';
  end if;

  if normalized_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Invalid organization slug';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = current_user_id
  ) then
    raise exception 'User profile does not exist';
  end if;

  insert into public.organizations (
    name,
    slug
  )
  values (
    normalized_name,
    normalized_slug
  )
  returning id
  into new_organization_id;

  insert into public.organization_members (
    organization_id,
    user_id,
    role
  )
  values (
    new_organization_id,
    current_user_id,
    'OWNER'
  );

  return new_organization_id;

end;
$$;


-- ============================================================
-- TRANSFER ORGANIZATION OWNERSHIP
--
-- Only the current OWNER can execute this function.
--
-- The target user must already belong to the organization.
--
-- Ownership is transferred atomically:
--
--   current OWNER -> ADMIN
--   target member -> OWNER
--
-- ============================================================

create or replace function public.transfer_organization_ownership(
  target_organization_id uuid,
  new_owner_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  current_owner_id uuid;
  target_member_role public.organization_role;
begin

  current_user_id := (select auth.uid());

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Lock organization to serialize ownership transfers.
  perform 1
  from public.organizations
  where id = target_organization_id
  for update;

  if not found then
    raise exception 'Organization not found';
  end if;

  -- Identify current owner.
  select om.user_id
  into current_owner_id
  from public.organization_members om
  where om.organization_id = target_organization_id
    and om.role = 'OWNER'
  for update;

  if current_owner_id is null then
    raise exception 'Organization has no OWNER';
  end if;

  if current_owner_id <> current_user_id then
    raise exception 'Only the current OWNER can transfer ownership';
  end if;

  if new_owner_user_id = current_user_id then
    return current_user_id;
  end if;

  -- Lock target membership and verify it exists.
  select om.role
  into target_member_role
  from public.organization_members om
  where om.organization_id = target_organization_id
    and om.user_id = new_owner_user_id
  for update;

  if not found then
    raise exception
      'The new OWNER must already be a member of the organization';
  end if;

  -- Demote current owner first.
  update public.organization_members
  set role = 'ADMIN'
  where organization_id = target_organization_id
    and user_id = current_user_id;

  -- Promote target member.
  update public.organization_members
  set role = 'OWNER'
  where organization_id = target_organization_id
    and user_id = new_owner_user_id;

  return new_owner_user_id;

end;
$$;


-- ============================================================
-- RLS
-- ============================================================

alter table public.profiles
enable row level security;

alter table public.organizations
enable row level security;

alter table public.organization_members
enable row level security;


-- ============================================================
-- PROFILES POLICIES
-- ============================================================

create policy "Users can view profiles in their organizations"
on public.profiles
for select
to authenticated
using (
  (select private.can_view_profile(id))
);


create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (
  id = (select auth.uid())
)
with check (
  id = (select auth.uid())
);


-- ============================================================
-- ORGANIZATION POLICIES
-- ============================================================

create policy "Members can view their organization"
on public.organizations
for select
to authenticated
using (
  (select private.is_organization_member(id))
);


create policy "Owners and admins can update organization"
on public.organizations
for update
to authenticated
using (
  (select private.has_organization_role(
    id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
)
with check (
  (select private.has_organization_role(
    id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- ORGANIZATION MEMBER POLICIES
-- ============================================================

create policy "Members can view organization members"
on public.organization_members
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


-- OWNER and ADMIN can add members.
--
-- Direct insertion of OWNER is forbidden.
-- Ownership is assigned only by:
--
--   1. create_organization()
--   2. transfer_organization_ownership()
--
create policy "Owners and admins can add non-owner members"
on public.organization_members
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
  and role <> 'OWNER'
);


-- OWNER and ADMIN can update roles of existing non-owner
-- members.
--
-- OWNER cannot be changed through this policy.
-- OWNER transfer must use the dedicated RPC.
create policy "Owners and admins can update non-owner roles"
on public.organization_members
for update
to authenticated
using (
  role <> 'OWNER'
  and
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
)
with check (
  role <> 'OWNER'
  and
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- OWNER and ADMIN can remove non-owner members.
--
-- The OWNER itself cannot be deleted through this policy.
create policy "Owners and admins can remove non-owner members"
on public.organization_members
for delete
to authenticated
using (
  role <> 'OWNER'
  and
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS
--
-- We explicitly grant only the privileges required by the
-- authenticated application.
-- ============================================================

-- ------------------------------------------------------------
-- PROFILES
-- ------------------------------------------------------------

revoke all on table public.profiles
from anon, authenticated;

grant select
on table public.profiles
to authenticated;

grant update (full_name, avatar_url)
on table public.profiles
to authenticated;


-- ------------------------------------------------------------
-- ORGANIZATIONS
-- ------------------------------------------------------------

revoke all on table public.organizations
from anon, authenticated;

grant select
on table public.organizations
to authenticated;

-- Clients can modify only organization name and slug.
--
-- plan/status are intentionally NOT client-writable.
-- They will later be controlled by backend/billing/system logic.
grant update (name, slug)
on table public.organizations
to authenticated;


-- ------------------------------------------------------------
-- ORGANIZATION MEMBERS
-- ------------------------------------------------------------

revoke all on table public.organization_members
from anon, authenticated;

grant select
on table public.organization_members
to authenticated;

grant insert (organization_id, user_id, role)
on table public.organization_members
to authenticated;

grant update (role)
on table public.organization_members
to authenticated;

grant delete
on table public.organization_members
to authenticated;


-- ------------------------------------------------------------
-- PRIVATE SCHEMA
--
-- Required for security-definer helpers used by RLS.
-- The schema itself remains outside the Data API.
-- ------------------------------------------------------------

grant usage
on schema private
to authenticated;


-- ------------------------------------------------------------
-- PRIVATE SECURITY FUNCTIONS
-- ------------------------------------------------------------

revoke all on function private.is_organization_member(uuid)
from public, anon, authenticated;

grant execute on function private.is_organization_member(uuid)
to authenticated;


revoke all on function private.has_organization_role(
  uuid,
  public.organization_role[]
)
from public, anon, authenticated;

grant execute on function private.has_organization_role(
  uuid,
  public.organization_role[]
)
to authenticated;


revoke all on function private.can_view_profile(uuid)
from public, anon, authenticated;

grant execute on function private.can_view_profile(uuid)
to authenticated;


-- Trigger/helper functions are not Data API functions.
revoke all on function private.prevent_membership_identity_change()
from public, anon, authenticated;


revoke all on function private.enforce_organization_owner()
from public, anon, authenticated;


-- ------------------------------------------------------------
-- PUBLIC RPC FUNCTIONS
-- ------------------------------------------------------------

revoke all on function public.create_organization(text, text)
from public, anon, authenticated;

grant execute
on function public.create_organization(text, text)
to authenticated;


revoke all on function public.transfer_organization_ownership(uuid, uuid)
from public, anon, authenticated;

grant execute
on function public.transfer_organization_ownership(uuid, uuid)
to authenticated;


-- ------------------------------------------------------------
-- Auth trigger functions are internal only.
-- ------------------------------------------------------------

revoke all on function public.handle_new_user()
from public, anon, authenticated;

revoke all on function public.handle_user_updated()
from public, anon, authenticated;


-- ============================================================
-- FINAL SECURITY NOTES
-- ============================================================

comment on function public.create_organization(text, text) is
  'Creates an EmailBot organization and makes the authenticated caller its OWNER.';

comment on function public.transfer_organization_ownership(uuid, uuid) is
  'Atomically transfers organization ownership to an existing member.';

comment on index public.organization_members_one_owner_idx is
  'Guarantees at most one OWNER per organization.';


-- ============================================================
-- END OF INITIAL SCHEMA V2
-- ============================================================