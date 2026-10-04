-- ============================================================
-- EmailBot - Migration 4
--
-- Organization settings and immutable audit logs
-- ============================================================


-- ============================================================
-- ENUMS
-- ============================================================

create type public.audit_actor_type as enum (
  'USER',
  'SYSTEM'
);

create type public.audit_action as enum (
  'CREATE',
  'UPDATE',
  'DELETE',
  'CONNECT',
  'DISCONNECT',
  'LOGIN',
  'LOGOUT',
  'PROCESS',
  'FAIL',
  'READ',
  'ARCHIVE',
  'UNARCHIVE',
  'MARK_READ',
  'MARK_UNREAD',
  'MARK_IMPORTANT',
  'MARK_NOT_IMPORTANT',
  'ROLE_CHANGE',
  'OWNERSHIP_TRANSFER'
);


-- ============================================================
-- ORGANIZATION SETTINGS
-- ============================================================

create table public.organization_settings (
  organization_id uuid primary key
    references public.organizations(id)
    on delete cascade,

  -- ----------------------------------------------------------
  -- Localization
  -- ----------------------------------------------------------

  timezone text not null default 'America/Lima',

  language text not null default 'es',

  -- ----------------------------------------------------------
  -- Email processing
  -- ----------------------------------------------------------

  auto_processing_enabled boolean not null default true,

  process_attachments boolean not null default true,

  -- ----------------------------------------------------------
  -- Notifications
  -- ----------------------------------------------------------

  notifications_enabled boolean not null default true,

  email_notifications_enabled boolean not null default true,

  -- ----------------------------------------------------------
  -- Retention
  -- ----------------------------------------------------------

  email_retention_days integer,

  -- ----------------------------------------------------------
  -- UI / inbox defaults
  -- ----------------------------------------------------------

  default_inbox_filter text not null default 'ALL',

  -- ----------------------------------------------------------
  -- Timestamps
  -- ----------------------------------------------------------

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),


  -- ==========================================================
  -- CONSTRAINTS
  -- ==========================================================

  constraint organization_settings_timezone_length
    check (
      char_length(trim(timezone)) between 1 and 100
    ),

  constraint organization_settings_language_format
    check (
      language ~ '^[a-z]{2}(?:-[A-Z]{2})?$'
    ),

  constraint organization_settings_retention_positive
    check (
      email_retention_days is null
      or email_retention_days >= 1
    ),

  constraint organization_settings_inbox_filter
    check (
      default_inbox_filter in (
        'ALL',
        'UNREAD',
        'IMPORTANT',
        'ATTACHMENTS'
      )
    )
);


comment on table public.organization_settings is
  'Organization-level EmailBot processing, notification and localization settings.';

comment on column public.organization_settings.timezone is
  'IANA timezone identifier used for organization-local dates and schedules.';

comment on column public.organization_settings.email_retention_days is
  'Optional number of days after which processed emails may be eligible for retention cleanup.';


-- ============================================================
-- ORGANIZATION SETTINGS INDEXES
-- ============================================================

create index organization_settings_timezone_idx
  on public.organization_settings(timezone);


-- ============================================================
-- ORGANIZATION SETTINGS UPDATED_AT
-- ============================================================

create trigger organization_settings_set_updated_at
before update on public.organization_settings
for each row
execute function public.set_updated_at();


-- ============================================================
-- AUTOMATIC DEFAULT SETTINGS
--
-- Every new organization automatically receives its settings.
-- This is executed server-side through a SECURITY DEFINER
-- function and does not depend on frontend privileges.
-- ============================================================

create or replace function private.create_default_organization_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  insert into public.organization_settings (
    organization_id
  )
  values (
    new.id
  )
  on conflict (organization_id) do nothing;

  return new;
end;
$$;


create trigger organizations_create_default_settings
after insert on public.organizations
for each row
execute function private.create_default_organization_settings();


-- ============================================================
-- AUDIT LOGS
-- ============================================================

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  -- ----------------------------------------------------------
  -- Actor
  -- ----------------------------------------------------------

  actor_type public.audit_actor_type not null default 'USER',

  actor_user_id uuid
    references public.profiles(id)
    on delete set null,

  -- ----------------------------------------------------------
  -- Action
  -- ----------------------------------------------------------

  action public.audit_action not null,

  -- ----------------------------------------------------------
  -- Target resource
  -- ----------------------------------------------------------

  entity_type text,

  entity_id uuid,

  -- ----------------------------------------------------------
  -- Human-readable description
  -- ----------------------------------------------------------

  description text,

  -- ----------------------------------------------------------
  -- Additional structured information
  -- ----------------------------------------------------------

  metadata jsonb not null default '{}'::jsonb,

  -- ----------------------------------------------------------
  -- Request correlation
  -- ----------------------------------------------------------

  request_id text,

  -- ----------------------------------------------------------
  -- Timestamp
  -- ----------------------------------------------------------

  created_at timestamptz not null default now(),


  -- ==========================================================
  -- CONSTRAINTS
  -- ==========================================================

  constraint audit_logs_entity_type_length
    check (
      entity_type is null
      or char_length(entity_type) between 1 and 100
    ),

  constraint audit_logs_description_length
    check (
      description is null
      or char_length(description) <= 2000
    ),

  constraint audit_logs_metadata_object
    check (
      jsonb_typeof(metadata) = 'object'
    ),

  constraint audit_logs_request_id_length
    check (
      request_id is null
      or char_length(request_id) <= 200
    ),

  constraint audit_logs_system_actor_consistency
    check (
      (
        actor_type = 'SYSTEM'
        and actor_user_id is null
      )
      or
      (
        actor_type = 'USER'
        and actor_user_id is not null
      )
    )
);


comment on table public.audit_logs is
  'Immutable organization-scoped audit trail for security and operational events.';

comment on column public.audit_logs.actor_user_id is
  'Authenticated user responsible for the action. Null when the action is performed by the system.';

comment on column public.audit_logs.metadata is
  'Structured contextual information associated with the audited action.';

comment on column public.audit_logs.request_id is
  'Optional request or job identifier used to correlate backend operations.';


-- ============================================================
-- AUDIT LOG INDEXES
-- ============================================================

create index audit_logs_organization_created_idx
  on public.audit_logs(
    organization_id,
    created_at desc
  );


create index audit_logs_actor_idx
  on public.audit_logs(
    organization_id,
    actor_user_id,
    created_at desc
  );


create index audit_logs_action_idx
  on public.audit_logs(
    organization_id,
    action,
    created_at desc
  );


create index audit_logs_entity_idx
  on public.audit_logs(
    organization_id,
    entity_type,
    entity_id,
    created_at desc
  );


create index audit_logs_request_id_idx
  on public.audit_logs(
    organization_id,
    request_id
  );


create index audit_logs_metadata_gin_idx
  on public.audit_logs
  using gin(metadata);


-- ============================================================
-- RLS - ORGANIZATION SETTINGS
-- ============================================================

alter table public.organization_settings
enable row level security;


create policy "Members can view organization settings"
on public.organization_settings
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


create policy "Owners and admins can update organization settings"
on public.organization_settings
for update
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
)
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- RLS - AUDIT LOGS
-- ============================================================

alter table public.audit_logs
enable row level security;


create policy "Owners and admins can view audit logs"
on public.audit_logs
for select
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS - ORGANIZATION SETTINGS
-- ============================================================

revoke all on table public.organization_settings
from anon, authenticated;


grant select
on table public.organization_settings
to authenticated;


grant update (
  timezone,
  language,
  auto_processing_enabled,
  process_attachments,
  notifications_enabled,
  email_notifications_enabled,
  email_retention_days,
  default_inbox_filter
)
on table public.organization_settings
to authenticated;


-- ============================================================
-- GRANTS - AUDIT LOGS
--
-- No INSERT / UPDATE / DELETE privileges are granted to the
-- authenticated frontend role.
--
-- Audit records are created by the backend/worker using its
-- server-side privileged connection.
-- ============================================================

revoke all on table public.audit_logs
from anon, authenticated;


grant select
on table public.audit_logs
to authenticated;


-- ============================================================
-- FUNCTION PERMISSIONS
-- ============================================================

revoke all on function private.create_default_organization_settings()
from public, anon, authenticated;


-- ============================================================
-- SECURITY: PREVENT AUDIT LOG MODIFICATION
--
-- Even if privileges are accidentally expanded later, these
-- triggers make audit records immutable at the database layer.
-- ============================================================

create or replace function private.prevent_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  raise exception
    'Audit logs are immutable and cannot be modified or deleted';

end;
$$;


create trigger audit_logs_prevent_update
before update on public.audit_logs
for each row
execute function private.prevent_audit_log_mutation();


create trigger audit_logs_prevent_delete
before delete on public.audit_logs
for each row
execute function private.prevent_audit_log_mutation();


revoke all on function private.prevent_audit_log_mutation()
from public, anon, authenticated;


-- ============================================================
-- TENANT CONSISTENCY FOR AUDIT ACTOR
--
-- If an audit record is associated with a USER actor, that
-- user must belong to the same organization.
-- ============================================================

create or replace function private.validate_audit_log_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  if new.actor_type = 'SYSTEM' then

    if new.actor_user_id is not null then
      raise exception
        'SYSTEM audit events cannot have an actor_user_id';
    end if;

    return new;

  end if;


  if new.actor_user_id is null then
    raise exception
      'USER audit events require actor_user_id';
  end if;


  if not exists (
    select 1
    from public.organization_members om
    where om.organization_id = new.organization_id
      and om.user_id = new.actor_user_id
  ) then
    raise exception
      'Audit actor does not belong to the organization';
  end if;


  return new;
end;
$$;


create trigger audit_logs_validate_actor
before insert on public.audit_logs
for each row
execute function private.validate_audit_log_actor();


revoke all on function private.validate_audit_log_actor()
from public, anon, authenticated;


-- ============================================================
-- COMMENTS
-- ============================================================

comment on function private.create_default_organization_settings() is
  'Automatically creates default settings for every new organization.';

comment on function private.prevent_audit_log_mutation() is
  'Prevents modification or deletion of immutable audit records.';

comment on function private.validate_audit_log_actor() is
  'Ensures user audit actors belong to the organization being audited.';