-- ============================================================
-- EmailBot - OAuth mailbox connection: atomic plan limit and reconnection
--
-- public.connect_oauth_email_account is now the only way the API stores an
-- OAuth (Gmail / Microsoft) mailbox. In ONE transaction it:
--
--   1. locks the organization row (FOR NO KEY UPDATE: concurrent connections
--      of the same organization are serialized; foreign-key checks of other
--      tables, which take FOR KEY SHARE, are not blocked);
--   2. finds the existing mailbox by (organization, provider, lower(address))
--      (the key of email_accounts_unique_address_idx) and locks it;
--   3. applies the EMAIL_ACCOUNTS limit with the same semantics as before
--      (organization_usage + organization_entitlements):
--        - a mailbox counts while status <> 'DISCONNECTED';
--        - re-authorizing an ACTIVE / PAUSED / ERROR mailbox takes no new slot;
--        - a new or DISCONNECTED mailbox takes one: used + 1 <= limit;
--        - the limit is the EMAIL_ACCOUNTS LIMIT entitlement of the effective
--          plan; no commercial access or no catalog row = 0 (fail closed);
--          a NULL limit_value = unlimited;
--   4. inserts or updates the row (never a second row for the same address).
--
-- Before this function the API counted and inserted in separate requests, so
-- two concurrent callbacks could both see room and exceed the limit.
--
-- Outcomes (no exception for an expected refusal; nothing is written then):
--   CREATED                new row
--   RECONNECTED            existing row reused (same id)
--   PLAN_LIMIT_REACHED     a new / DISCONNECTED mailbox does not fit
--   MISSING_REFRESH_TOKEN  no refresh token returned and none stored
--                          (offline access is required)
--
-- Reconnection: status ACTIVE, access token replaced, refresh token replaced
-- only when the provider returned one, last_error_* cleared. The Gmail sync
-- cursor (historyId) of a mailbox in ERROR is KEPT, so the messages received
-- while the authorization was broken are still synchronized (an expired
-- cursor is handled by the worker's history-gap recovery). Every other case
-- (new, DISCONNECTED, ACTIVE, PAUSED, Microsoft) stores the cursor given by
-- the caller, as before.
--
-- SECURITY DEFINER (owner postgres), search_path = '', EXECUTE: service_role
-- only (the OAuth callback has no user session; the route re-checks the
-- member role and the plan before calling it).
-- ============================================================

create or replace function public.connect_oauth_email_account(
  p_organization_id uuid,
  p_provider public.email_provider,
  p_email_address text,
  p_display_name text,
  p_provider_account_id text,
  p_access_token_encrypted text,
  p_refresh_token_encrypted text,
  p_token_expires_at timestamptz,
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
  v_refresh text := nullif(p_refresh_token_encrypted, '');
  v_row record;
  v_has_limit boolean := false;
  v_limit bigint;
  v_used bigint;
  v_id uuid;
begin
  if p_organization_id is null then
    raise exception 'An organization is required';
  end if;
  if p_provider is null or p_provider not in ('GMAIL', 'MICROSOFT') then
    raise exception 'Only OAuth providers (GMAIL, MICROSOFT) can be connected here';
  end if;
  if v_email = '' then
    raise exception 'An email address is required';
  end if;
  if coalesce(p_access_token_encrypted, '') = '' then
    raise exception 'An access token is required';
  end if;

  -- Serializes every connection of this organization until the transaction ends.
  perform 1
  from public.organizations o
  where o.id = p_organization_id
  for no key update;

  if not found then
    raise exception 'Organization not found';
  end if;

  select a.id, a.status, a.provider, a.sync_cursor, a.refresh_token_encrypted
  into v_row
  from public.email_accounts a
  where a.organization_id = p_organization_id
    and a.provider = p_provider
    and lower(a.email_address) = v_email
  for update;

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

    -- No commercial access or no catalog row: fail closed.
    if not coalesce(v_has_limit, false) then
      v_limit := 0;
    end if;

    if v_limit is not null and v_used + 1 > v_limit then
      return query select 'PLAN_LIMIT_REACHED'::text, v_row.id, v_row.status, v_used, v_limit;
      return;
    end if;
  end if;

  if v_refresh is null and (v_row.id is null or v_row.refresh_token_encrypted is null) then
    return query select 'MISSING_REFRESH_TOKEN'::text, v_row.id, v_row.status, v_used, v_limit;
    return;
  end if;

  if v_row.id is null then
    insert into public.email_accounts (
      organization_id, provider, email_address, status, display_name, provider_account_id,
      access_token_encrypted, refresh_token_encrypted, token_expires_at, sync_cursor,
      last_error_code, last_error_message
    )
    values (
      p_organization_id, p_provider, v_email, 'ACTIVE', p_display_name, p_provider_account_id,
      p_access_token_encrypted, v_refresh, p_token_expires_at, p_sync_cursor,
      null, null
    )
    returning id into v_id;

    return query select 'CREATED'::text, v_id, null::public.email_account_status, v_used, v_limit;
    return;
  end if;

  update public.email_accounts a
  set status = 'ACTIVE',
      -- Same address (case-insensitive key); stored lower-case like every other write, so the
      -- exact-match lookups of the push webhook and the worker find it.
      email_address = v_email,
      display_name = p_display_name,
      provider_account_id = p_provider_account_id,
      access_token_encrypted = p_access_token_encrypted,
      refresh_token_encrypted = coalesce(v_refresh, a.refresh_token_encrypted),
      token_expires_at = p_token_expires_at,
      sync_cursor = case
        when v_row.provider = 'GMAIL' and v_row.status = 'ERROR' and v_row.sync_cursor is not null then v_row.sync_cursor
        else p_sync_cursor
      end,
      last_error_code = null,
      last_error_message = null
  where a.id = v_row.id;

  return query select 'RECONNECTED'::text, v_row.id, v_row.status, v_used, v_limit;
end;
$$;

comment on function public.connect_oauth_email_account(uuid, public.email_provider, text, text, text, text, text, timestamptz, text) is
  'OAuth mailbox connection: per-organization lock, EMAIL_ACCOUNTS limit and insert/update in one transaction. Returns CREATED, RECONNECTED, PLAN_LIMIT_REACHED or MISSING_REFRESH_TOKEN. Keeps the Gmail cursor of an ERROR mailbox. service_role only.';

revoke all on function public.connect_oauth_email_account(uuid, public.email_provider, text, text, text, text, text, timestamptz, text)
from public, anon, authenticated, service_role;

grant execute on function public.connect_oauth_email_account(uuid, public.email_provider, text, text, text, text, text, timestamptz, text)
to service_role;
