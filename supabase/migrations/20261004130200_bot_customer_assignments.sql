-- ============================================================
-- EmailBot V2 - Phase 2: bot <-> customer assignments
--
-- Which bots' emails a customer may receive (N:M). One row per pair
-- (primary key bot_id, customer_id). Both composite foreign keys use the
-- row's organization_id, so bot and customer always belong to the same
-- organization - for every role, including the service role and the owner.
--
-- active = false keeps the relation (and the history) but makes the customer
-- ineligible for that bot. A suspended customer or a paused bot keeps its
-- assignments. A bot that still has assignments cannot be deleted
-- (NO ACTION); deleting the organization removes everything (cascade).
--
-- RLS (who can do what):
--   SELECT  members of the organization (all roles)
--   INSERT  OWNER/ADMIN/OPERATOR; created_by = caller or NULL
--   UPDATE  OWNER/ADMIN/OPERATOR; only active
--   DELETE  OWNER/ADMIN/OPERATOR (unassign)
--   cross-organization: impossible (RLS + composite foreign keys)
--   customers (portal) / platform admins: no access
--   service_role: no privilege yet (phase 3)
-- ============================================================

create table public.bot_customer_assignments (
  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  bot_id uuid not null,

  customer_id uuid not null,

  active boolean not null default true,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint bot_customer_assignments_pkey
    primary key (bot_id, customer_id),

  constraint bot_customer_assignments_bot_fkey
    foreign key (organization_id, bot_id)
    references public.bots(organization_id, id),

  constraint bot_customer_assignments_customer_fkey
    foreign key (organization_id, customer_id)
    references public.customers(organization_id, id)
    on delete cascade
);

comment on table public.bot_customer_assignments is
  'Bots whose emails a customer may receive (EmailBot V2). Bot and customer always share the organization.';

create index bot_customer_assignments_customer_idx
  on public.bot_customer_assignments(organization_id, customer_id);

create index bot_customer_assignments_bot_idx
  on public.bot_customer_assignments(organization_id, bot_id)
  where active;

create trigger bot_customer_assignments_set_updated_at
before update on public.bot_customer_assignments
for each row
execute function public.set_updated_at();


-- ============================================================
-- RLS
-- ============================================================

alter table public.bot_customer_assignments enable row level security;

create policy "Members can view bot customer assignments"
on public.bot_customer_assignments
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);

create policy "Operators and above can create bot customer assignments"
on public.bot_customer_assignments
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
  and (created_by is null or created_by = (select auth.uid()))
);

create policy "Operators and above can update bot customer assignments"
on public.bot_customer_assignments
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

create policy "Operators and above can delete bot customer assignments"
on public.bot_customer_assignments
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS
-- ============================================================

revoke all on table public.bot_customer_assignments
from anon, authenticated, service_role;

grant select
on table public.bot_customer_assignments
to authenticated;

grant insert (
  organization_id,
  bot_id,
  customer_id,
  active,
  created_by
)
on table public.bot_customer_assignments
to authenticated;

grant update (
  active
)
on table public.bot_customer_assignments
to authenticated;

grant delete
on table public.bot_customer_assignments
to authenticated;
