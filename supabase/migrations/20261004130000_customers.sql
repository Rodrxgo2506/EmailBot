-- ============================================================
-- EmailBot V2 - Phase 2: customers
--
-- End customers of an organization (NOT Supabase Auth users: they will
-- access the portal with their own credential in a later phase).
--
-- Customers are never hard-deleted by members: a customer leaves through
-- status = SUSPENDED, which keeps its history (deliveries, phase 3) and its
-- identifiers / bot assignments. Only deleting the whole organization removes
-- them (ON DELETE CASCADE from organizations).
--
-- RLS (who can do what):
--   SELECT  members of the organization (all roles)
--   INSERT  OWNER/ADMIN/OPERATOR; created_by = caller or NULL
--   UPDATE  OWNER/ADMIN/OPERATOR; organization_id / created_by not updatable
--   DELETE  nobody (no grant, no policy)
--   cross-organization: impossible (RLS + composite foreign keys that
--           reference (organization_id, id), see identifiers / assignments)
--   customers (portal): no access to this table
--   platform admins: no RLS exception (phase 7)
--   service_role: no privilege yet (the worker needs it in phase 3)
-- ============================================================

create type public.customer_status as enum ('ACTIVE', 'SUSPENDED');

create table public.customers (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  display_name text not null,

  status public.customer_status not null default 'ACTIVE',

  -- The organization's own reference for the customer (CRM id, contract...).
  external_ref text,

  notes text,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  -- Target of the composite foreign keys that keep references inside one organization.
  constraint customers_organization_id_id_key
    unique (organization_id, id),

  constraint customers_display_name_length
    check (char_length(trim(display_name)) between 1 and 120),

  constraint customers_external_ref_length
    check (
      external_ref is null
      or char_length(trim(external_ref)) between 1 and 100
    ),

  constraint customers_notes_length
    check (
      notes is null
      or char_length(notes) <= 2000
    )
);

comment on table public.customers is
  'End customers of an organization (EmailBot V2). Not auth users. Suspended instead of deleted to keep history.';

create unique index customers_organization_external_ref_idx
  on public.customers(organization_id, external_ref)
  where external_ref is not null;

create index customers_organization_name_idx
  on public.customers(organization_id, display_name);

create trigger customers_set_updated_at
before update on public.customers
for each row
execute function public.set_updated_at();


-- ============================================================
-- RLS
-- ============================================================

alter table public.customers enable row level security;

create policy "Members can view customers"
on public.customers
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);

create policy "Operators and above can create customers"
on public.customers
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
  and (created_by is null or created_by = (select auth.uid()))
);

create policy "Operators and above can update customers"
on public.customers
for update
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
)
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS (explicit: default privileges differ between environments)
-- ============================================================

revoke all on table public.customers
from anon, authenticated, service_role;

grant select
on table public.customers
to authenticated;

grant insert (
  organization_id,
  display_name,
  status,
  external_ref,
  notes,
  created_by
)
on table public.customers
to authenticated;

grant update (
  display_name,
  status,
  external_ref,
  notes
)
on table public.customers
to authenticated;
