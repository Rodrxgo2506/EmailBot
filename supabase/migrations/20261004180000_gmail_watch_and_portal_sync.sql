-- ============================================================
-- EmailBot V2 - Phase 5.6: Gmail push (users.watch) state and portal
-- manual sync scope
--
-- Ingestion = event-driven (Gmail watch -> Pub/Sub -> webhook -> BullMQ ->
-- worker -> History API) + recovery polling + manual sync, all ending in the
-- same processing pipeline. The history cursor already exists
-- (email_accounts.sync_cursor = Gmail historyId; last_synced_at = last
-- successful sync). This migration only adds the watch state the worker
-- needs to renew watches before they expire (7 days) and to record
-- failures, plus the portal function that scopes a customer's manual sync.
--
-- Grants: the service role already has table-level SELECT/INSERT/UPDATE on
-- email_accounts (migration 7), which covers these columns; members
-- (authenticated) have column-level SELECT only and do not get them.
-- ============================================================

alter table public.email_accounts
  add column watch_expires_at timestamptz,
  add column watch_renewed_at timestamptz,
  add column watch_error_code text,
  add column watch_error_at timestamptz;

alter table public.email_accounts
  add constraint email_accounts_watch_error_code_length
    check (watch_error_code is null or char_length(watch_error_code) <= 100);

comment on column public.email_accounts.watch_expires_at is
  'Gmail users.watch expiration (push notifications stop after it unless renewed).';
comment on column public.email_accounts.watch_error_code is
  'Last watch creation/renewal failure (category only); the account keeps being polled.';

-- Renewal scan: active Gmail accounts whose watch is missing or expiring.
create index email_accounts_watch_renewal_idx
  on public.email_accounts(provider, watch_expires_at nulls first)
  where status = 'ACTIVE';


-- ============================================================
-- PORTAL: scope of a customer's manual sync
--
-- session -> customer -> organization -> active assignments ->
-- the organization's ACTIVE email accounts. Nothing when the customer has no
-- active assignment (nothing it could see would change). Returns internal
-- ids to the API only (service role); the API never sends them to the
-- browser. Same contract as the other portal functions: the session token
-- hash is the only authority.
-- ============================================================

create or replace function portal.sync_scope(
  p_token_hash text
)
returns table (
  email_account_id uuid,
  organization_id uuid,
  provider public.email_provider,
  last_synced_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope record;
begin

  select sc.organization_id, sc.customer_id
  into v_scope
  from private.portal_session_scope(p_token_hash) sc;

  if v_scope.customer_id is null then
    return;
  end if;

  if not exists (
    select 1 from public.bot_customer_assignments a
    where a.organization_id = v_scope.organization_id
      and a.customer_id = v_scope.customer_id
      and a.active
  ) then
    return;
  end if;

  return query
  select ea.id, ea.organization_id, ea.provider, ea.last_synced_at
  from public.email_accounts ea
  where ea.organization_id = v_scope.organization_id
    and ea.status = 'ACTIVE'
  order by ea.id;

end;
$$;

revoke all on function portal.sync_scope(text)
from public, anon, authenticated, service_role;

grant execute on function portal.sync_scope(text) to service_role;
