-- ============================================================
-- EmailBot V2 - Phase 3: email deliveries
--
-- Who may see a processed email (N:M email <-> customer). One email is never
-- duplicated per customer: a shared account gets one email row and N
-- deliveries. Deliveries are created by the worker (resolution AUTOMATIC);
-- MANUAL is reserved for a later phase (created_by = the member).
--
-- Database-enforced integrity (every role, including the service role and
-- the table owner):
--   - (organization_id, email_id, bot_id) -> emails(organization_id, id, bot_id):
--     the email belongs to the organization AND its bot_id is exactly the
--     delivery's bot. An email without a bot (general rule, ambiguous tie)
--     can never be delivered.
--   - (organization_id, customer_id) -> customers: same organization.
--   - (organization_id, customer_id, identifier_id) -> customer_identifiers:
--     the identifier that matched belongs to THAT customer; deleting it only
--     clears identifier_id.
--   - (organization_id, bot_id) -> bots: a bot with deliveries cannot be
--     deleted (NO ACTION); deleting an email removes its deliveries (cascade).
--   - unique (email_id, customer_id): idempotent worker inserts.
--
-- RLS (who can do what):
--   SELECT  members of the organization (all roles)
--   INSERT / UPDATE / DELETE  no member (no grant, no policy) in phase 3
--   cross-organization: impossible (RLS + composite foreign keys)
--   customers (portal): later phase, through SECURITY DEFINER functions only
--   platform admins: no RLS exception
--   service_role: INSERT of automatic deliveries + SELECT of the ids it returns
-- ============================================================

create type public.delivery_resolution as enum ('AUTOMATIC', 'MANUAL');

-- Targets of the composite foreign keys (additive unique constraints).
alter table public.emails
  add constraint emails_organization_id_id_bot_id_key
  unique (organization_id, id, bot_id);

alter table public.customer_identifiers
  add constraint customer_identifiers_organization_customer_id_key
  unique (organization_id, customer_id, id);

create table public.email_deliveries (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  email_id uuid not null,

  customer_id uuid not null,

  bot_id uuid not null,

  resolution public.delivery_resolution not null,

  identifier_id uuid,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  constraint email_deliveries_email_customer_key
    unique (email_id, customer_id),

  constraint email_deliveries_email_fkey
    foreign key (organization_id, email_id, bot_id)
    references public.emails(organization_id, id, bot_id)
    on delete cascade,

  constraint email_deliveries_customer_fkey
    foreign key (organization_id, customer_id)
    references public.customers(organization_id, id)
    on delete cascade,

  constraint email_deliveries_bot_fkey
    foreign key (organization_id, bot_id)
    references public.bots(organization_id, id),

  constraint email_deliveries_identifier_fkey
    foreign key (organization_id, customer_id, identifier_id)
    references public.customer_identifiers(organization_id, customer_id, id)
    on delete set null (identifier_id),

  -- Automatic deliveries have no human author.
  constraint email_deliveries_automatic_without_author
    check (resolution = 'MANUAL' or created_by is null)
);

comment on table public.email_deliveries is
  'Customers that may see a processed email (EmailBot V2). The email bot and the delivery bot are always the same.';

create index email_deliveries_customer_idx
  on public.email_deliveries(organization_id, customer_id, created_at desc);

create index email_deliveries_bot_idx
  on public.email_deliveries(organization_id, bot_id, created_at desc);


-- ============================================================
-- ELIGIBILITY (new deliveries only; history is never touched)
--
-- A new delivery requires an ACTIVE bot, an ACTIVE customer and an active
-- assignment of that customer to that bot. Existing deliveries stay when a
-- bot is paused or a customer is suspended. SECURITY INVOKER: the inserting
-- role must be able to read these columns (the worker has column grants;
-- members read through RLS).
-- ============================================================

create or replace function private.validate_email_delivery_eligibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin

  if not exists (
    select 1 from public.bots b
    where b.organization_id = new.organization_id
      and b.id = new.bot_id
      and b.status = 'ACTIVE'
  ) then
    raise exception 'Bot is not active'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.customers c
    where c.organization_id = new.organization_id
      and c.id = new.customer_id
      and c.status = 'ACTIVE'
  ) then
    raise exception 'Customer is not active'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.bot_customer_assignments a
    where a.organization_id = new.organization_id
      and a.bot_id = new.bot_id
      and a.customer_id = new.customer_id
      and a.active
  ) then
    raise exception 'Customer is not assigned to the bot'
      using errcode = 'check_violation';
  end if;

  return new;

end;
$$;

revoke all on function private.validate_email_delivery_eligibility()
from public, anon, authenticated, service_role;

create trigger email_deliveries_validate_eligibility
before insert on public.email_deliveries
for each row
execute function private.validate_email_delivery_eligibility();


-- ============================================================
-- RLS
-- ============================================================

alter table public.email_deliveries enable row level security;

create policy "Members can view email deliveries"
on public.email_deliveries
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


-- ============================================================
-- GRANTS
-- ============================================================

revoke all on table public.email_deliveries
from anon, authenticated, service_role;

grant select
on table public.email_deliveries
to authenticated;

-- Worker: idempotent INSERT ... ON CONFLICT (email_id, customer_id) DO NOTHING RETURNING customer_id.
grant insert (organization_id, email_id, customer_id, bot_id, resolution, identifier_id)
on table public.email_deliveries
to service_role;

grant select (id, email_id, customer_id)
on table public.email_deliveries
to service_role;
