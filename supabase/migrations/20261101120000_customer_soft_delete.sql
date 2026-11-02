-- ============================================================
-- EmailBot V2: customer deletion (soft delete)
--
-- A deleted customer is hidden from the panel, but NOTHING is physically
-- removed: email deliveries, identifiers, bot assignments, Access IDs,
-- portal sessions and audit logs stay for history, statistics and audit.
--
--   deleted_at / deleted_by  when and by whom (the member) it was deleted
--   status = 'SUSPENDED'     forced while deleted (check below), so every
--                            existing guard applies unchanged: no new
--                            automatic or manual deliveries (eligibility
--                            trigger + add_manual_delivery), no portal
--                            session or data (portal_session_scope), not
--                            counted in the CUSTOMERS plan limit, and the
--                            worker's resolver skips it (customer ACTIVE)
--
-- Deletion only through public.delete_customer (SECURITY DEFINER, atomic,
-- OWNER/ADMIN of the customer's organization, read from the database):
-- revokes the ACTIVE Access ID and every open portal session, suspends and
-- marks the customer. It is final: members have no grant on deleted_at /
-- deleted_by, and a deleted customer, its identifiers and its bot
-- assignments can no longer be changed, nor a new Access ID issued
-- (triggers below), for every role.
--
-- external_ref stays unique among the customers that are NOT deleted, so a
-- deleted customer's reference can be reused.
--
-- Additive and backward compatible: nullable columns, no backfill (every
-- existing row is not deleted), no data rewritten.
-- ============================================================

alter table public.customers
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles(id) on delete set null;

alter table public.customers
  add constraint customers_deleted_is_suspended
    check (deleted_at is null or status = 'SUSPENDED'),
  add constraint customers_deleted_by_requires_deleted_at
    check (deleted_by is null or deleted_at is not null);

comment on column public.customers.deleted_at is
  'Soft deletion (public.delete_customer). The customer stays SUSPENDED and its history is kept.';
comment on column public.customers.deleted_by is
  'Member who deleted the customer.';

drop index public.customers_organization_external_ref_idx;

create unique index customers_organization_external_ref_idx
  on public.customers(organization_id, external_ref)
  where external_ref is not null and deleted_at is null;


-- ============================================================
-- A DELETED CUSTOMER IS FINAL
--
-- Its own columns cannot change any more (created_by / deleted_by may still
-- be cleared by ON DELETE SET NULL when a profile is deleted), and its
-- identifiers and bot assignments can be neither created nor changed.
-- Deleting the organization still removes everything (cascade: DELETE).
-- ============================================================

create or replace function private.guard_deleted_customer()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin

  if old.deleted_at is not null
     and (new.organization_id, new.display_name, new.status, new.external_ref, new.notes, new.deleted_at)
       is distinct from
         (old.organization_id, old.display_name, old.status, old.external_ref, old.notes, old.deleted_at) then
    raise exception 'Customer is deleted'
      using errcode = 'check_violation';
  end if;

  return new;

end;
$$;

revoke all on function private.guard_deleted_customer()
from public, anon, authenticated, service_role;

create trigger customers_guard_deleted
before update on public.customers
for each row
execute function private.guard_deleted_customer();


-- SECURITY DEFINER: the check must see the customer whatever the writing
-- role may read (also inside other SECURITY DEFINER functions).
create or replace function private.reject_links_to_deleted_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  if exists (
    select 1 from public.customers c
    where c.organization_id = new.organization_id
      and c.id = new.customer_id
      and c.deleted_at is not null
  ) then
    raise exception 'Customer is deleted'
      using errcode = 'check_violation';
  end if;

  return new;

end;
$$;

revoke all on function private.reject_links_to_deleted_customer()
from public, anon, authenticated, service_role;

-- UPDATE OF lists the member-writable columns only, so ON DELETE SET NULL of
-- created_by (profile deleted) keeps working.
create trigger bot_customer_assignments_reject_deleted_customer
before insert or update of active on public.bot_customer_assignments
for each row
execute function private.reject_links_to_deleted_customer();

create trigger customer_identifiers_reject_deleted_customer
before insert or update of value, normalized_value, bot_id, active on public.customer_identifiers
for each row
execute function private.reject_links_to_deleted_customer();

-- No new Access ID either (public.issue_customer_access inserts here).
create trigger customer_access_credentials_reject_deleted_customer
before insert on public.customer_access_credentials
for each row
execute function private.reject_links_to_deleted_customer();


-- ============================================================
-- ADMIN: DELETE A CUSTOMER
--
-- In one transaction, serialized per customer (row lock): revokes the
-- ACTIVE Access ID (REVOKED) and every open portal session
-- (CREDENTIAL_REVOKED), then suspends and marks the customer. Missing,
-- foreign and already deleted customers are indistinguishable (42501
-- "Customer not found"). OPERATOR and VIEWER cannot delete.
-- ============================================================

create or replace function public.delete_customer(
  p_customer_id uuid
)
returns table (
  customer_id uuid,
  organization_id uuid,
  deleted_at timestamptz,
  revoked_credential_id uuid,
  revoked_sessions integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_customer public.customers%rowtype;
  v_credential uuid;
  v_sessions integer;
  v_deleted_at timestamptz := now();
begin

  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select c.* into v_customer
  from public.customers c
  where c.id = p_customer_id
  for update;

  if v_customer.id is null
     or v_customer.deleted_at is not null
     or not private.has_organization_role(
       v_customer.organization_id,
       array['OWNER', 'ADMIN']::public.organization_role[]
     ) then
    raise exception 'Customer not found' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = v_customer.organization_id and o.status = 'ACTIVE'
  ) then
    raise exception 'Organization is not active';
  end if;

  update public.customer_access_credentials cr
  set status = 'REVOKED',
      revoked_at = v_deleted_at,
      revoked_by = v_user_id,
      revoked_reason = 'REVOKED'
  where cr.organization_id = v_customer.organization_id
    and cr.customer_id = v_customer.id
    and cr.status = 'ACTIVE'
  returning cr.id
  into v_credential;

  update public.customer_sessions s
  set revoked_at = v_deleted_at,
      revoked_reason = 'CREDENTIAL_REVOKED'
  where s.organization_id = v_customer.organization_id
    and s.customer_id = v_customer.id
    and s.revoked_at is null;
  get diagnostics v_sessions = row_count;

  update public.customers c
  set status = 'SUSPENDED',
      deleted_at = v_deleted_at,
      deleted_by = v_user_id
  where c.id = v_customer.id;

  return query select v_customer.id, v_customer.organization_id, v_deleted_at, v_credential, v_sessions;

end;
$$;

revoke all on function public.delete_customer(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.delete_customer(uuid) to authenticated;
