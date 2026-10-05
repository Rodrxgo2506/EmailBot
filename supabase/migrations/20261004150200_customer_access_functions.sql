-- ============================================================
-- EmailBot V2 - Phase 4: customer access and portal session functions
--
-- Neither secret_hash nor token_hash is readable or writable by any API
-- role. Every operation on credentials and sessions is one of these
-- SECURITY DEFINER functions (owner: postgres; search_path = ''; fully
-- qualified names; EXECUTE revoked from PUBLIC/anon and granted to exactly
-- one role):
--
--   authenticated (organization members, through the API with their JWT):
--     public.issue_customer_access     generate / regenerate (atomic)
--     public.revoke_customer_access    revoke the ACTIVE credential
--     public.revoke_customer_sessions  revoke one or every session
--   Authority: auth.uid() must be OWNER/ADMIN/OPERATOR of the customer's
--   organization, read from the database; customer_id is only the target.
--
--   service_role (the API portal endpoints; never the browser):
--     portal.create_session    exchange an Access ID hash for a session
--     portal.validate_session  authorize a request by its token hash
--     portal.end_session       logout
--   Authority: the secret (Access ID / session token hash). They accept no
--   customer_id or organization_id.
--
-- The portal schema is exposed to PostgREST for the service role only
-- (supabase/config.toml [api].schemas; production: Dashboard > API).
-- ============================================================

create schema if not exists portal;

revoke all on schema portal from public, anon, authenticated;

grant usage on schema portal to service_role;


-- ============================================================
-- ADMIN: GENERATE / REGENERATE AN ACCESS ID
--
-- In one transaction, serialized per customer (row lock): revokes the
-- ACTIVE credential (REGENERATED), revokes every open session of the
-- customer, inserts the new credential. Never two ACTIVE credentials.
-- ============================================================

create or replace function public.issue_customer_access(
  p_customer_id uuid,
  p_secret_hash text,
  p_last4 text,
  p_display_prefix text,
  p_expires_at timestamptz
)
returns table (
  credential_id uuid,
  organization_id uuid,
  previous_credential_id uuid,
  revoked_sessions integer,
  display_prefix text,
  last4 text,
  status public.customer_access_status,
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_organization_id uuid;
  v_previous uuid;
  v_sessions integer;
  v_new public.customer_access_credentials%rowtype;
begin

  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select c.organization_id
  into v_organization_id
  from public.customers c
  where c.id = p_customer_id
  for update;

  -- Missing and foreign customers are indistinguishable.
  if v_organization_id is null
     or not private.has_organization_role(
       v_organization_id,
       array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
     ) then
    raise exception 'Customer not found' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = v_organization_id and o.status = 'ACTIVE'
  ) then
    raise exception 'Organization is not active';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiration must be in the future';
  end if;

  update public.customer_access_credentials cr
  set status = 'REVOKED',
      revoked_at = now(),
      revoked_by = v_user_id,
      revoked_reason = 'REGENERATED'
  where cr.organization_id = v_organization_id
    and cr.customer_id = p_customer_id
    and cr.status = 'ACTIVE'
  returning cr.id
  into v_previous;

  update public.customer_sessions s
  set revoked_at = now(),
      revoked_reason = 'CREDENTIAL_REGENERATED'
  where s.organization_id = v_organization_id
    and s.customer_id = p_customer_id
    and s.revoked_at is null;
  get diagnostics v_sessions = row_count;

  insert into public.customer_access_credentials (
    organization_id,
    customer_id,
    display_prefix,
    secret_hash,
    last4,
    expires_at,
    created_by
  )
  values (
    v_organization_id,
    p_customer_id,
    p_display_prefix,
    p_secret_hash,
    p_last4,
    p_expires_at,
    v_user_id
  )
  returning * into v_new;

  return query
  select
    v_new.id,
    v_new.organization_id,
    v_previous,
    v_sessions,
    v_new.display_prefix,
    v_new.last4,
    v_new.status,
    v_new.expires_at,
    v_new.created_at;

end;
$$;


-- ============================================================
-- ADMIN: REVOKE THE ACCESS ID (and its sessions)
-- ============================================================

create or replace function public.revoke_customer_access(
  p_customer_id uuid
)
returns table (
  credential_id uuid,
  revoked_sessions integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_organization_id uuid;
  v_credential uuid;
  v_sessions integer;
begin

  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select c.organization_id
  into v_organization_id
  from public.customers c
  where c.id = p_customer_id
  for update;

  if v_organization_id is null
     or not private.has_organization_role(
       v_organization_id,
       array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
     ) then
    raise exception 'Customer not found' using errcode = '42501';
  end if;

  update public.customer_access_credentials cr
  set status = 'REVOKED',
      revoked_at = now(),
      revoked_by = v_user_id,
      revoked_reason = 'REVOKED'
  where cr.organization_id = v_organization_id
    and cr.customer_id = p_customer_id
    and cr.status = 'ACTIVE'
  returning cr.id
  into v_credential;

  update public.customer_sessions s
  set revoked_at = now(),
      revoked_reason = 'CREDENTIAL_REVOKED'
  where s.organization_id = v_organization_id
    and s.customer_id = p_customer_id
    and s.revoked_at is null;
  get diagnostics v_sessions = row_count;

  return query select v_credential, v_sessions;

end;
$$;


-- ============================================================
-- ADMIN: REVOKE ONE SESSION (p_session_id) OR EVERY SESSION
-- ============================================================

create or replace function public.revoke_customer_sessions(
  p_customer_id uuid,
  p_session_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_organization_id uuid;
  v_sessions integer;
begin

  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select c.organization_id
  into v_organization_id
  from public.customers c
  where c.id = p_customer_id;

  if v_organization_id is null
     or not private.has_organization_role(
       v_organization_id,
       array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
     ) then
    raise exception 'Customer not found' using errcode = '42501';
  end if;

  update public.customer_sessions s
  set revoked_at = now(),
      revoked_reason = case when p_session_id is null then 'REVOKED_ALL' else 'REVOKED' end
  where s.organization_id = v_organization_id
    and s.customer_id = p_customer_id
    and s.revoked_at is null
    and (p_session_id is null or s.id = p_session_id);
  get diagnostics v_sessions = row_count;

  return v_sessions;

end;
$$;


-- ============================================================
-- PORTAL: LOGIN (Access ID hash -> new session)
--
-- outcome: OK | INVALID | REVOKED | EXPIRED | CUSTOMER_INACTIVE |
-- ORGANIZATION_INACTIVE. The API answers every failure with the same generic
-- error; the category is only for audit/logs. organization_id/customer_id
-- are returned for failures of a KNOWN credential (organization audit) and
-- are never sent to the browser.
-- FOR SHARE serializes with a concurrent regeneration/revocation: a session
-- is never created for a credential revoked in the meantime.
-- ============================================================

create or replace function portal.create_session(
  p_secret_hash text,
  p_token_hash text,
  p_ip inet,
  p_user_agent text
)
returns table (
  outcome text,
  organization_id uuid,
  customer_id uuid,
  session_id uuid,
  display_name text,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.customer_access_credentials%rowtype;
  v_customer_status public.customer_status;
  v_display_name text;
  v_organization_status public.organization_status;
  v_absolute timestamptz;
  v_idle timestamptz;
  v_session_id uuid;
begin

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid session token hash';
  end if;

  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return query select 'INVALID'::text, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select cr.*
  into v_credential
  from public.customer_access_credentials cr
  where cr.secret_hash = p_secret_hash
  for share;

  if v_credential.id is null then
    return query select 'INVALID'::text, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select c.status, c.display_name
  into v_customer_status, v_display_name
  from public.customers c
  where c.organization_id = v_credential.organization_id
    and c.id = v_credential.customer_id;

  select o.status
  into v_organization_status
  from public.organizations o
  where o.id = v_credential.organization_id;

  if v_credential.status <> 'ACTIVE' then
    return query select 'REVOKED'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_credential.expires_at is not null and v_credential.expires_at <= now() then
    return query select 'EXPIRED'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_organization_status is distinct from 'ACTIVE' then
    return query select 'ORGANIZATION_INACTIVE'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_customer_status is distinct from 'ACTIVE' then
    return query select 'CUSTOMER_INACTIVE'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_absolute := now() + interval '30 days';
  if v_credential.expires_at is not null and v_credential.expires_at < v_absolute then
    v_absolute := v_credential.expires_at;
  end if;
  v_idle := least(now() + interval '7 days', v_absolute);

  insert into public.customer_sessions (
    organization_id,
    customer_id,
    credential_id,
    token_hash,
    idle_expires_at,
    absolute_expires_at,
    ip,
    user_agent
  )
  values (
    v_credential.organization_id,
    v_credential.customer_id,
    v_credential.id,
    p_token_hash,
    v_idle,
    v_absolute,
    p_ip,
    left(p_user_agent, 512)
  )
  returning id into v_session_id;

  return query select 'OK'::text, v_credential.organization_id, v_credential.customer_id, v_session_id, v_display_name, v_idle, v_absolute;

end;
$$;


-- ============================================================
-- PORTAL: AUTHORIZE A REQUEST (token hash -> customer context)
--
-- Valid only if: not revoked, idle and absolute expiry in the future,
-- credential ACTIVE and not expired, customer ACTIVE, organization ACTIVE.
-- Returns no row otherwise. last_seen_at / idle expiry slide at most once
-- every 5 minutes (bounded writes), never beyond the absolute expiry.
-- ============================================================

create or replace function portal.validate_session(
  p_token_hash text
)
returns table (
  session_id uuid,
  organization_id uuid,
  customer_id uuid,
  display_name text,
  customer_status public.customer_status,
  organization_name text,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz,
  bots jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.customer_sessions%rowtype;
  v_idle timestamptz;
begin

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select s.*
  into v_session
  from public.customer_sessions s
  join public.customer_access_credentials cr
    on cr.organization_id = s.organization_id
   and cr.customer_id = s.customer_id
   and cr.id = s.credential_id
  join public.customers c
    on c.organization_id = s.organization_id
   and c.id = s.customer_id
  join public.organizations o
    on o.id = s.organization_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.idle_expires_at > now()
    and s.absolute_expires_at > now()
    and cr.status = 'ACTIVE'
    and (cr.expires_at is null or cr.expires_at > now())
    and c.status = 'ACTIVE'
    and o.status = 'ACTIVE';

  if v_session.id is null then
    return;
  end if;

  v_idle := v_session.idle_expires_at;
  if v_session.last_seen_at < now() - interval '5 minutes' then
    v_idle := least(now() + interval '7 days', v_session.absolute_expires_at);
    update public.customer_sessions s
    set last_seen_at = now(),
        idle_expires_at = v_idle
    where s.id = v_session.id
      and s.revoked_at is null;
  end if;

  return query
  select
    v_session.id,
    v_session.organization_id,
    v_session.customer_id,
    c.display_name,
    c.status,
    o.name,
    v_idle,
    v_session.absolute_expires_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('name', b.name, 'portalSettings', b.portal_settings)
          order by b.name
        )
        from public.bot_customer_assignments a
        join public.bots b
          on b.organization_id = a.organization_id
         and b.id = a.bot_id
        where a.organization_id = v_session.organization_id
          and a.customer_id = v_session.customer_id
          and a.active
          and b.status = 'ACTIVE'
      ),
      '[]'::jsonb
    )
  from public.customers c
  join public.organizations o on o.id = c.organization_id
  where c.organization_id = v_session.organization_id
    and c.id = v_session.customer_id;

end;
$$;


-- ============================================================
-- PORTAL: LOGOUT (revokes only the session of this token)
-- ============================================================

create or replace function portal.end_session(
  p_token_hash text
)
returns table (
  session_id uuid,
  organization_id uuid,
  customer_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  update public.customer_sessions s
  set revoked_at = now(),
      revoked_reason = 'LOGOUT'
  where s.token_hash = p_token_hash
    and s.revoked_at is null
  returning s.id, s.organization_id, s.customer_id;

end;
$$;


-- ============================================================
-- EXECUTE: exactly one role per function
-- ============================================================

revoke all on function public.issue_customer_access(uuid, text, text, text, timestamptz)
from public, anon, authenticated, service_role;
revoke all on function public.revoke_customer_access(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.revoke_customer_sessions(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function portal.create_session(text, text, inet, text)
from public, anon, authenticated, service_role;
revoke all on function portal.validate_session(text)
from public, anon, authenticated, service_role;
revoke all on function portal.end_session(text)
from public, anon, authenticated, service_role;

grant execute on function public.issue_customer_access(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function public.revoke_customer_access(uuid) to authenticated;
grant execute on function public.revoke_customer_sessions(uuid, uuid) to authenticated;

grant execute on function portal.create_session(text, text, inet, text) to service_role;
grant execute on function portal.validate_session(text) to service_role;
grant execute on function portal.end_session(text) to service_role;
