-- ============================================================
-- EmailBot - IMAP phase E1: security and database groundwork
--
-- IMAP stays DISABLED after this migration (API flag off, no worker adapter).
-- It prepares, additively:
--
--   1. plan feature IMAP: PRO and BUSINESS true, BASIC false. IMAP mailboxes
--      share the existing EMAIL_ACCOUNTS limit (no extra quota). No price,
--      limit or other entitlement changes.
--
--   2. least privilege on public.email_accounts for `authenticated` (Data API
--      with a member's JWT). Until now OWNER / ADMIN could INSERT rows and
--      UPDATE provider, email_address, provider_metadata (an IMAP host!),
--      sync_cursor, last_error_*... directly, bypassing the API (plan limit,
--      validation, SSRF checks). The API only writes status and display_name
--      with the member's JWT (PATCH /api/email-accounts/:id); every other
--      write goes through the service role. So:
--        - no INSERT at all;
--        - UPDATE only (status, display_name);
--        - SELECT and DELETE unchanged (column SELECT already excludes the
--          credentials; DELETE keeps the API's delete with RLS OWNER / ADMIN).
--      REVOKE of a table privilege also revokes its column privileges.
--
--   3. private.guard_email_account_member_update: the status a member may set
--      through that UPDATE grant follows the API's rules (pause / resume
--      only, never a DISCONNECTED mailbox, never ERROR / DISCONNECTED, and an
--      IMAP mailbox cannot be resumed while IMAP synchronization does not
--      exist). The service role (API privileged layer, worker) is not
--      affected.
--
--   4. public.connect_imap_email_account: the only write of an IMAP mailbox,
--      modeled on public.connect_oauth_email_account (20261007160000):
--        - per-organization lock (FOR NO KEY UPDATE) + the mailbox row locked;
--        - plan feature IMAP from public.organization_entitlements (no
--          commercial access, unknown plan or no catalog row = refused);
--        - EMAIL_ACCOUNTS with the same counting rules (a mailbox counts while
--          not DISCONNECTED; a new or DISCONNECTED one needs used + 1 <= limit;
--          NULL limit = unlimited; no access = 0);
--        - one row per (organization, provider, lower(address)): reconnection
--          reuses it;
--        - the same address already connected with another provider in the
--          organization is refused (it would be ingested twice);
--        - the password must already be encrypted, in the v2 format bound to
--          the mailbox (SecretBox.encryptBound + imapCredentialContext);
--        - only 993/TLS or 143/STARTTLS, host a DNS name (the network checks
--          are done by the API / worker with resolveImapDestination);
--        - the mailbox is stored PAUSED with IMAP_SYNC_NOT_IMPLEMENTED: it is
--          never made ACTIVE and nothing is queued (E3 replaces this).
--      Outcomes: CREATED, RECONNECTED, PLAN_LIMIT_REACHED,
--      FEATURE_NOT_AVAILABLE, DUPLICATE_ACCOUNT (expected refusals return a
--      row and write nothing; invalid input raises).
--      Cursor (sync_cursor): a NEW or DISCONNECTED mailbox takes the caller's
--      cursor (the server position at connection time, or NULL = "start from
--      the newest message": no history is imported). A mailbox that still
--      counts (ACTIVE / PAUSED / ERROR) KEEPS its cursor when the server
--      (host, port, username) is unchanged, so nothing received meanwhile is
--      skipped; a different server starts from the caller's cursor.
--
-- Rollback (manual, if ever needed; no data depends on it while IMAP is off):
--   drop function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text);
--   drop trigger email_accounts_guard_member_update on public.email_accounts;
--   drop function private.guard_email_account_member_update();
--   grant insert (organization_id, provider, status, email_address, display_name, provider_account_id,
--     token_expires_at, provider_metadata, sync_cursor, last_synced_at, last_error_code, last_error_message)
--     on table public.email_accounts to authenticated;
--   grant update (provider, status, email_address, display_name, provider_account_id, token_expires_at,
--     provider_metadata, sync_cursor, last_synced_at, last_error_code, last_error_message)
--     on table public.email_accounts to authenticated;
--   delete from public.plan_entitlements where key = 'IMAP';
-- ============================================================


-- ============================================================
-- 1. Plan feature IMAP (PRO, BUSINESS)
-- ============================================================

insert into public.plan_entitlements (plan_id, key, kind, enabled)
select c.id, 'IMAP', 'FEATURE', v.enabled
from (
  values
    ('BASIC', false),
    ('PRO', true),
    ('BUSINESS', true)
) as v(code, enabled)
join public.plan_catalog c on c.code = v.code::public.organization_plan;

do $$
declare
  rows_found integer;
begin
  select count(*)
  into rows_found
  from public.plan_entitlements e
  join public.plan_catalog c on c.id = e.plan_id
  where e.key = 'IMAP'
    and e.kind = 'FEATURE'
    and e.enabled = (c.code in ('PRO', 'BUSINESS'));
  if rows_found <> 3 then
    raise exception 'IMAP feature: expected 3 catalog rows, found %', rows_found;
  end if;
end;
$$;


-- ============================================================
-- 2. Least privilege for members (Data API)
-- ============================================================

revoke insert on table public.email_accounts from authenticated;
revoke update on table public.email_accounts from authenticated;

grant update (status, display_name)
on table public.email_accounts
to authenticated;

comment on policy "Owners and admins can create email accounts" on public.email_accounts is
  'Inactive since 20261014120000: authenticated has no INSERT privilege (mailboxes are created by the service role only).';


-- ============================================================
-- 3. Status transitions a member may make
-- ============================================================

create or replace function private.guard_email_account_member_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only the Data API with a member's JWT; the service role and the owner are not restricted here.
  if current_user <> 'authenticated' then
    return new;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'DISCONNECTED' then
      raise exception 'A disconnected mailbox must be connected again';
    end if;
    if new.status not in ('ACTIVE', 'PAUSED') then
      raise exception 'Only pausing and resuming a mailbox are allowed';
    end if;
    if new.status = 'ACTIVE' and old.provider = 'IMAP' then
      raise exception 'IMAP synchronization is not available yet';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.guard_email_account_member_update() is
  'Members (authenticated) may only pause / resume a mailbox that is not DISCONNECTED; an IMAP mailbox cannot be resumed yet. Service role unaffected.';

revoke all on function private.guard_email_account_member_update() from public, anon, authenticated, service_role;

create trigger email_accounts_guard_member_update
before update on public.email_accounts
for each row
execute function private.guard_email_account_member_update();


-- ============================================================
-- 4. public.connect_imap_email_account
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
      'IMAP_SYNC_NOT_IMPLEMENTED', 'IMAP synchronization is not available yet. Credentials were stored encrypted.'
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
      last_error_code = 'IMAP_SYNC_NOT_IMPLEMENTED',
      last_error_message = 'IMAP synchronization is not available yet. Credentials were stored encrypted.'
  where a.id = v_row.id;

  return query select 'RECONNECTED'::text, v_row.id, v_row.status, v_used, v_limit;
end;
$$;

comment on function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text) is
  'IMAP mailbox connection (E1): per-organization lock, plan feature IMAP, EMAIL_ACCOUNTS limit and insert/reconnect in one transaction; stores the v2-encrypted password and keeps the mailbox PAUSED. Returns CREATED, RECONNECTED, PLAN_LIMIT_REACHED, FEATURE_NOT_AVAILABLE or DUPLICATE_ACCOUNT. service_role only.';

revoke all on function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.connect_imap_email_account(uuid, text, text, text, text, integer, text, text, text)
to service_role;
