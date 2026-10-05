-- ============================================================
-- EmailBot V2 - Phase 5: manual deliveries + portal read state
--
-- MANUAL deliveries follow exactly the same rules as AUTOMATIC ones: same
-- organization, delivery bot = email bot (composite FKs) and, for every new
-- or reactivated delivery, bot ACTIVE + customer ACTIVE + active assignment
-- (trigger validate_email_delivery_eligibility). There is no exception for
-- MANUAL.
--
-- Removal is a SOFT removal (removed_at / removed_by) and only applies to
-- MANUAL deliveries: the row, the email, the customer and the history stay;
-- the customer stops seeing the email in the portal. Delivering the same
-- email to the same customer again reactivates that row (unique
-- (email_id, customer_id) is kept).
--
-- customer_read_at: per-customer read state in the portal (the panel's
-- emails.is_read belongs to the organization's operators).
--
-- Writes by members only through SECURITY DEFINER functions (atomic, role
-- checked inside, organization derived from the email):
--   public.add_manual_delivery(email_id, customer_id)
--   public.remove_manual_delivery(delivery_id)
-- Permission deliveries:manage = OWNER/ADMIN/OPERATOR (never VIEWER).
-- ============================================================

alter table public.email_deliveries
  add column removed_at timestamptz,
  add column removed_by uuid references public.profiles(id) on delete set null,
  add column customer_read_at timestamptz;

alter table public.email_deliveries
  add constraint email_deliveries_removal
    check (
      (removed_at is null and removed_by is null)
      or (removed_at is not null and resolution = 'MANUAL')
    );

comment on column public.email_deliveries.removed_at is
  'Soft removal of a MANUAL delivery (the customer no longer sees the email; history kept).';
comment on column public.email_deliveries.customer_read_at is
  'First time the customer opened the email in the portal.';

-- Portal inbox: the customer's visible deliveries, newest first (keyset).
create index email_deliveries_portal_inbox_idx
  on public.email_deliveries(customer_id, created_at desc, id desc)
  where removed_at is null;

create index email_deliveries_email_idx
  on public.email_deliveries(email_id);

-- Reactivating a removed delivery is a new delivery: same eligibility rules.
create trigger email_deliveries_validate_reactivation
before update of removed_at on public.email_deliveries
for each row
when (old.removed_at is not null and new.removed_at is null)
execute function private.validate_email_delivery_eligibility();


-- ============================================================
-- ADD A MANUAL DELIVERY
--
-- Returns the delivery and what happened: CREATED, REACTIVATED, or EXISTING
-- (an active delivery already exists: nothing is duplicated). Errors use
-- P0001 messages written here (safe to show) except authorization, which is
-- 42501 "Email not found" for missing and foreign emails alike.
-- ============================================================

create or replace function public.add_manual_delivery(
  p_email_id uuid,
  p_customer_id uuid
)
returns table (
  delivery_id uuid,
  outcome text,
  organization_id uuid,
  bot_id uuid,
  resolution public.delivery_resolution
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email public.emails%rowtype;
  v_existing public.email_deliveries%rowtype;
  v_id uuid;
begin

  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select e.* into v_email
  from public.emails e
  where e.id = p_email_id;

  if v_email.id is null
     or not private.has_organization_role(
       v_email.organization_id,
       array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
     ) then
    raise exception 'Email not found' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = v_email.organization_id and o.status = 'ACTIVE'
  ) then
    raise exception 'Organization is not active';
  end if;

  if v_email.bot_id is null then
    raise exception 'The email has no bot: it cannot be delivered';
  end if;

  if not exists (
    select 1 from public.customers c
    where c.organization_id = v_email.organization_id and c.id = p_customer_id
  ) then
    raise exception 'Customer not found in this organization';
  end if;

  if not exists (
    select 1 from public.bots b
    where b.organization_id = v_email.organization_id and b.id = v_email.bot_id and b.status = 'ACTIVE'
  ) then
    raise exception 'Bot is not active';
  end if;

  if not exists (
    select 1 from public.customers c
    where c.organization_id = v_email.organization_id and c.id = p_customer_id and c.status = 'ACTIVE'
  ) then
    raise exception 'Customer is not active';
  end if;

  if not exists (
    select 1 from public.bot_customer_assignments a
    where a.organization_id = v_email.organization_id
      and a.bot_id = v_email.bot_id
      and a.customer_id = p_customer_id
      and a.active
  ) then
    raise exception 'Customer is not assigned to the bot';
  end if;

  select d.* into v_existing
  from public.email_deliveries d
  where d.email_id = p_email_id and d.customer_id = p_customer_id
  for update;

  if v_existing.id is not null and v_existing.removed_at is null then
    return query select v_existing.id, 'EXISTING'::text, v_existing.organization_id, v_existing.bot_id, v_existing.resolution;
    return;
  end if;

  if v_existing.id is not null then
    update public.email_deliveries d
    set removed_at = null,
        removed_by = null,
        resolution = 'MANUAL',
        created_by = v_user_id
    where d.id = v_existing.id;
    return query select v_existing.id, 'REACTIVATED'::text, v_existing.organization_id, v_existing.bot_id, 'MANUAL'::public.delivery_resolution;
    return;
  end if;

  insert into public.email_deliveries (
    organization_id,
    email_id,
    customer_id,
    bot_id,
    resolution,
    created_by
  )
  values (
    v_email.organization_id,
    p_email_id,
    p_customer_id,
    v_email.bot_id,
    'MANUAL',
    v_user_id
  )
  on conflict (email_id, customer_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- A concurrent request created it first.
    select d.id into v_id from public.email_deliveries d where d.email_id = p_email_id and d.customer_id = p_customer_id;
    return query select v_id, 'EXISTING'::text, v_email.organization_id, v_email.bot_id, 'MANUAL'::public.delivery_resolution;
    return;
  end if;

  return query select v_id, 'CREATED'::text, v_email.organization_id, v_email.bot_id, 'MANUAL'::public.delivery_resolution;

end;
$$;


-- ============================================================
-- REMOVE (SOFT) A MANUAL DELIVERY
--
-- Only MANUAL deliveries, only of the caller's organization (role checked
-- on the delivery's organization). AUTOMATIC deliveries are not removable.
-- Returns the delivery and whether it was removed now (false = already
-- removed).
-- ============================================================

create or replace function public.remove_manual_delivery(
  p_delivery_id uuid
)
returns table (
  delivery_id uuid,
  removed boolean,
  organization_id uuid,
  email_id uuid,
  customer_id uuid,
  bot_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_delivery public.email_deliveries%rowtype;
begin

  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select d.* into v_delivery
  from public.email_deliveries d
  where d.id = p_delivery_id
  for update;

  if v_delivery.id is null
     or not private.has_organization_role(
       v_delivery.organization_id,
       array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
     ) then
    raise exception 'Delivery not found' using errcode = '42501';
  end if;

  if v_delivery.resolution <> 'MANUAL' then
    raise exception 'Only manual deliveries can be removed';
  end if;

  if v_delivery.removed_at is not null then
    return query select v_delivery.id, false, v_delivery.organization_id, v_delivery.email_id, v_delivery.customer_id, v_delivery.bot_id;
    return;
  end if;

  update public.email_deliveries d
  set removed_at = now(),
      removed_by = v_user_id
  where d.id = v_delivery.id;

  return query select v_delivery.id, true, v_delivery.organization_id, v_delivery.email_id, v_delivery.customer_id, v_delivery.bot_id;

end;
$$;


-- ============================================================
-- EXECUTE
-- ============================================================

revoke all on function public.add_manual_delivery(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.remove_manual_delivery(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.add_manual_delivery(uuid, uuid) to authenticated;
grant execute on function public.remove_manual_delivery(uuid) to authenticated;
