-- ============================================================
-- EmailBot - IMAP M1: lifecycle of an IMAP mailbox (explicit activation)
--
-- IMAP stays DISABLED after this migration (API and worker flags off in code).
-- Additive; 20261014120000_imap_e1_security.sql is not modified:
--
--   1. public.connect_imap_email_account is replaced with the SAME signature,
--      grants and checks. Only the state written changes its wording: a
--      (re)connected mailbox is still stored PAUSED, now with the neutral code
--      IMAP_ACTIVATION_PENDING ("connected, resume it to start") instead of
--      IMAP_SYNC_NOT_IMPLEMENTED. A reconnection of an ACTIVE mailbox also
--      leaves it PAUSED: synchronization only starts after an explicit
--      activation.
--
--   2. public.activate_imap_email_account (service_role only): the ONLY way to
--      make an IMAP mailbox ACTIVE. Under the per-organization lock:
--        - the mailbox belongs to the organization and is IMAP;
--        - PAUSED -> ACTIVE; ACTIVE is a no-op; DISCONNECTED is refused
--          (connect it again); ERROR is refused too (RECONNECT_REQUIRED): a
--          mailbox the worker stopped (refused login, certificate, TLS...) is
--          only resumed by connecting it again, i.e. through the API connection
--          test and its abuse limits (E4), which leaves it PAUSED;
--        - the stored password is a v2 SecretBox value and the stored settings
--          pass the same rules as at connection time;
--        - plan feature IMAP with commercial access (organization_entitlements);
--        - the previous error is cleared only on a valid activation.
--      Outcomes: ACTIVATED, ALREADY_ACTIVE, NOT_FOUND, NOT_IMAP, DISCONNECTED,
--      RECONNECT_REQUIRED, CREDENTIALS_MISSING, SETTINGS_INVALID,
--      FEATURE_NOT_AVAILABLE (refusals
--      write nothing; invalid input raises).
--
--   private.guard_email_account_member_update (E1) is unchanged: members
--   (authenticated, Data API) still cannot set an IMAP mailbox ACTIVE.
--
-- Rollback (manual, if ever needed; nothing depends on it while IMAP is off):
--   drop function public.activate_imap_email_account(uuid, uuid);
--   and re-run section 4 of 20261014120000_imap_e1_security.sql (connect_imap_email_account).
-- ============================================================


-- ============================================================
-- 1. public.connect_imap_email_account (same signature, PAUSED + IMAP_ACTIVATION_PENDING)
-- ============================================================

create or replace function public.connect_imap_email_account(
  p_organization_id uuid,
  p_email_address text,
  p_display_name text,
  p_username text,
  p_host text,
  p_port integer,
  p_security text,
  p_password_encrypted text,
  p_sync_cursor text
)
returns table (
  outcome text,
  email_account_id uuid,
  previous_status public.email_account_status,
  used bigint,
  limit_value bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email_address, '')));
  v_host text := lower(trim(coalesce(p_host, '')));
  v_username text := trim(coalesce(p_username, ''));
  v_display_name text := nullif(trim(coalesce(p_display_name, '')), '');
  v_row record;
  v_feature boolean;
  v_has_limit boolean := false;
  v_limit bigint;
  v_used bigint;
  v_id uuid;
  v_same_server boolean;
  v_imap jsonb;
begin
  -- Invalid input is a programming error of the caller (the API validates first): raise.
  if p_organization_id is null then
    raise exception 'An organization is required';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    raise exception 'A valid email address is required';
  end if;
  if char_length(v_host) > 253
     or v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' then
    raise exception 'The IMAP server must be a DNS name';
  end if;
  if v_host ~ '(^|\.)(localhost|local|localdomain|internal|intranet|private|corp|home|lan|arpa|test|example|invalid|onion|alt)$' then
    raise exception 'The IMAP server must be a public DNS name';
  end if;
  if not ((p_port = 993 and p_security = 'TLS') or (p_port = 143 and p_security = 'STARTTLS')) then
    raise exception 'Only port 993 with TLS or port 143 with STARTTLS is allowed';
  end if;
  if char_length(v_username) not between 1 and 320 then
    raise exception 'An IMAP username is required';
  end if;
  -- Never a plaintext password: only the v2 SecretBox format (iv 12 bytes, tag 16 bytes, base64url).
  if coalesce(p_password_encrypted, '') !~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' then
    raise exception 'The IMAP password must be encrypted (v2 format)';
  end if;
  if v_display_name is not null and char_length(v_display_name) > 200 then
    raise exception 'The display name is too long';
  end if;

  -- Serializes every connection of this organization until the transaction ends.
  perform 1
  from public.organizations o
  where o.id = p_organization_id
  for no key update;

  if not found then
    raise exception 'Organization not found';
  end if;

  -- Plan feature, from the same source as every entitlement (fail closed).
  select e.enabled
  into v_feature
  from public.organization_entitlements(p_organization_id) e
  where e.access in ('SUBSCRIPTION', 'LEGACY')
    and e.effective_plan in ('BASIC', 'PRO', 'BUSINESS')
    and e.kind = 'FEATURE'
    and e.key = 'IMAP'
  limit 1;

  if not coalesce(v_feature, false) then
    return query select 'FEATURE_NOT_AVAILABLE'::text, null::uuid, null::public.email_account_status, null::bigint, null::bigint;
    return;
  end if;

  select a.id, a.status, a.sync_cursor, a.provider_metadata
  into v_row
  from public.email_accounts a
  where a.organization_id = p_organization_id
    and a.provider = 'IMAP'
    and lower(a.email_address) = v_email
  for update;

  -- The same mailbox already connected through Gmail / Microsoft would be ingested twice.
  if exists (
    select 1
    from public.email_accounts a
    where a.organization_id = p_organization_id
      and a.provider <> 'IMAP'
      and lower(a.email_address) = v_email
      and a.status <> 'DISCONNECTED'
  ) then
    return query select 'DUPLICATE_ACCOUNT'::text, v_row.id, v_row.status, null::bigint, null::bigint;
    return;
  end if;

  -- A new or DISCONNECTED mailbox takes a slot; one that already counts does not.
  if v_row.id is null or v_row.status = 'DISCONNECTED' then
    select true, e.limit_value
    into v_has_limit, v_limit
    from public.organization_entitlements(p_organization_id) e
    where e.access in ('SUBSCRIPTION', 'LEGACY')
      and e.effective_plan in ('BASIC', 'PRO', 'BUSINESS')
      and e.kind = 'LIMIT'
      and e.key = 'EMAIL_ACCOUNTS'
    limit 1;

    select count(*)
    into v_used
    from public.email_accounts a
    where a.organization_id = p_organization_id
      and a.status <> 'DISCONNECTED';

    if not coalesce(v_has_limit, false) then
      v_limit := 0;
    end if;

    if v_limit is not null and v_used + 1 > v_limit then
      return query select 'PLAN_LIMIT_REACHED'::text, v_row.id, v_row.status, v_used, v_limit;
      return;
    end if;
  end if;

  v_imap := jsonb_build_object('host', v_host, 'port', p_port, 'security', p_security, 'username', v_username);

  if v_row.id is null then
    insert into public.email_accounts (
      organization_id, provider, email_address, status, display_name, provider_account_id,
      access_token_encrypted, refresh_token_encrypted, token_expires_at, provider_metadata, sync_cursor,
      last_error_code, last_error_message
    )
    values (
      p_organization_id, 'IMAP', v_email, 'PAUSED', v_display_name, null,
      p_password_encrypted, null, null, jsonb_build_object('imap', v_imap), p_sync_cursor,
      'IMAP_ACTIVATION_PENDING', 'Mailbox connected and paused. Resume it to start synchronizing new mail.'
    )
    returning id into v_id;

    return query select 'CREATED'::text, v_id, null::public.email_account_status, v_used, v_limit;
    return;
  end if;

  v_same_server := v_row.status <> 'DISCONNECTED'
    and coalesce(v_row.provider_metadata -> 'imap' ->> 'host', '') = v_host
    and coalesce(v_row.provider_metadata -> 'imap' ->> 'port', '') = p_port::text
    and coalesce(v_row.provider_metadata -> 'imap' ->> 'username', '') = v_username;

  update public.email_accounts a
  set status = 'PAUSED',
      email_address = v_email,
      display_name = v_display_name,
      provider_account_id = null,
      access_token_encrypted = p_password_encrypted,
      refresh_token_encrypted = null,
      token_expires_at = null,
      provider_metadata = coalesce(a.provider_metadata, '{}'::jsonb) || jsonb_build_object('imap', v_imap),
      sync_cursor = case when v_same_server and v_row.sync_cursor is not null then v_row.sync_cursor else p_sync_cursor end,
      last_error_code = 'IMAP_ACTIVATION_PENDING',
      last_error_message = 'Mailbox connected and paused. Resume it to start synchronizing new mail.'
  where a.id = v_row.id;

  return query select 'RECONNECTED'::text, v_row.id, v_row.status, v_used, v_limit;
end;
$$;

comment on function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text) is
  'IMAP mailbox connection (E1): per-organization lock, plan feature IMAP, EMAIL_ACCOUNTS limit and insert/reconnect in one transaction; stores the v2-encrypted password and keeps the mailbox PAUSED (IMAP_ACTIVATION_PENDING) until activate_imap_email_account. Returns CREATED, RECONNECTED, PLAN_LIMIT_REACHED, FEATURE_NOT_AVAILABLE or DUPLICATE_ACCOUNT. service_role only.';

revoke all on function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)
to service_role;


-- ============================================================
-- 2. public.activate_imap_email_account
-- ============================================================

create or replace function public.activate_imap_email_account(
  p_organization_id uuid,
  p_email_account_id uuid
)
returns table (
  outcome text,
  email_account_id uuid,
  previous_status public.email_account_status
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_imap jsonb;
  v_host text;
  v_port integer;
  v_feature boolean;
begin
  -- Invalid input is a programming error of the caller (the API validates first): raise.
  if p_organization_id is null or p_email_account_id is null then
    raise exception 'An organization and a mailbox are required';
  end if;

  -- Same per-organization lock as connect_imap_email_account / connect_oauth_email_account: a
  -- (re)connection, a plan change checked here and this activation never interleave.
  perform 1
  from public.organizations o
  where o.id = p_organization_id
  for no key update;

  if not found then
    raise exception 'Organization not found';
  end if;

  -- Only this organization's row; locked so a concurrent disconnection waits for this decision
  -- (or this activation sees the row already DISCONNECTED).
  select a.id, a.provider, a.status, a.access_token_encrypted, a.provider_metadata
  into v_row
  from public.email_accounts a
  where a.id = p_email_account_id
    and a.organization_id = p_organization_id
  for update;

  if v_row.id is null then
    return query select 'NOT_FOUND'::text, null::uuid, null::public.email_account_status;
    return;
  end if;
  if v_row.provider <> 'IMAP' then
    return query select 'NOT_IMAP'::text, v_row.id, v_row.status;
    return;
  end if;
  if v_row.status = 'DISCONNECTED' then
    return query select 'DISCONNECTED'::text, v_row.id, v_row.status;
    return;
  end if;
  if v_row.status = 'ACTIVE' then
    return query select 'ALREADY_ACTIVE'::text, v_row.id, v_row.status;
    return;
  end if;
  -- ERROR: the worker stopped this mailbox (refused login, certificate, TLS, settings...). Resuming it would
  -- make the worker log in again outside the connection-test abuse limits (E4): it must be connected again.
  if v_row.status = 'ERROR' then
    return query select 'RECONNECT_REQUIRED'::text, v_row.id, v_row.status;
    return;
  end if;
  -- Only PAUSED remains (the enum has no other value).

  -- The stored login must still be usable: the v2 SecretBox password bound to the mailbox...
  if coalesce(v_row.access_token_encrypted, '') !~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' then
    return query select 'CREDENTIALS_MISSING'::text, v_row.id, v_row.status;
    return;
  end if;

  -- ...and the connection settings, with the same rules as connect_imap_email_account.
  v_imap := v_row.provider_metadata -> 'imap';
  v_host := coalesce(v_imap ->> 'host', '');
  v_port := case when coalesce(v_imap ->> 'port', '') ~ '^[0-9]{1,5}$' then (v_imap ->> 'port')::integer else null end;
  if v_imap is null
     or jsonb_typeof(v_imap) <> 'object'
     or char_length(v_host) > 253
     or v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})$'
     or v_host ~ '(^|\.)(localhost|local|localdomain|internal|intranet|private|corp|home|lan|arpa|test|example|invalid|onion|alt)$'
     -- coalesce: a missing port / security must refuse (NULL would make the whole condition NULL, i.e. pass).
     or not ((coalesce(v_port, 0) = 993 and coalesce(v_imap ->> 'security', '') = 'TLS')
             or (coalesce(v_port, 0) = 143 and coalesce(v_imap ->> 'security', '') = 'STARTTLS'))
     or char_length(trim(coalesce(v_imap ->> 'username', ''))) not between 1 and 320 then
    return query select 'SETTINGS_INVALID'::text, v_row.id, v_row.status;
    return;
  end if;

  -- Plan feature IMAP with commercial access, from the same source as every entitlement (fail closed).
  -- The mailbox already counts for EMAIL_ACCOUNTS (it is not DISCONNECTED): no new slot is needed.
  select e.enabled
  into v_feature
  from public.organization_entitlements(p_organization_id) e
  where e.access in ('SUBSCRIPTION', 'LEGACY')
    and e.effective_plan in ('BASIC', 'PRO', 'BUSINESS')
    and e.kind = 'FEATURE'
    and e.key = 'IMAP'
  limit 1;

  if not coalesce(v_feature, false) then
    return query select 'FEATURE_NOT_AVAILABLE'::text, v_row.id, v_row.status;
    return;
  end if;

  -- The previous error (IMAP_ACTIVATION_PENDING, a refused login...) is cleared only now.
  update public.email_accounts a
  set status = 'ACTIVE',
      last_error_code = null,
      last_error_message = null
  where a.id = v_row.id;

  return query select 'ACTIVATED'::text, v_row.id, v_row.status;
end;
$$;

comment on function public.activate_imap_email_account(uuid, uuid) is
  'IMAP M1: the only way to make an IMAP mailbox ACTIVE. Per-organization lock; PAUSED only (ERROR: RECONNECT_REQUIRED, connect it again); v2 password and valid settings; plan feature IMAP with commercial access. Returns ACTIVATED, ALREADY_ACTIVE, NOT_FOUND, NOT_IMAP, DISCONNECTED, RECONNECT_REQUIRED, CREDENTIALS_MISSING, SETTINGS_INVALID or FEATURE_NOT_AVAILABLE. service_role only.';

revoke all on function public.activate_imap_email_account(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.activate_imap_email_account(uuid, uuid)
to service_role;
