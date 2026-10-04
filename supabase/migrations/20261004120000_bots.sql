-- ============================================================
-- EmailBot V2 - Phase 1: bots
--
-- A bot is an organization-scoped email service (Netflix, Yape, ...)
-- whose rules decide which processed emails belong to it. Customer
-- routing (customer_resolution) and portal exposure (portal_settings)
-- are configured here and used by later phases; the API validates both
-- documents (packages/validation/src/bots.ts) and the worker re-validates
-- before use.
--
-- Additive only: new type, new table, policies and grants.
--
-- RLS (who can do what):
--   SELECT  members of the organization (all roles)
--   INSERT  OWNER/ADMIN of the organization; created_by = caller or NULL
--   UPDATE  OWNER/ADMIN; organization_id is not updatable (column grants);
--           updated_by = caller or NULL
--   DELETE  OWNER/ADMIN (the API keeps bots that already own emails)
--   cross-organization: impossible (RLS + composite foreign keys that
--           reference (organization_id, id), see migration rule_and_email_bot)
--   customers (portal): no access to this table
--   platform admins: no RLS exception (API + service role, phase 7)
--   service_role: SELECT (id, organization_id, status) for the worker
-- ============================================================

create type public.bot_status as enum ('ACTIVE', 'PAUSED');

create table public.bots (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  name text not null,

  slug text not null,

  description text,

  status public.bot_status not null default 'ACTIVE',

  customer_resolution jsonb not null
    default '{"source": "NONE", "onMultipleMatches": "LEAVE_UNASSIGNED"}'::jsonb,

  portal_settings jsonb not null
    default '{"showBody": false, "showAttachments": false, "fields": []}'::jsonb,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  updated_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  -- Target of the composite foreign keys that keep references inside one organization.
  constraint bots_organization_id_id_key
    unique (organization_id, id),

  constraint bots_organization_slug_key
    unique (organization_id, slug),

  constraint bots_name_length
    check (char_length(trim(name)) between 1 and 100),

  constraint bots_slug_format
    check (
      slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      and char_length(slug) <= 100
    ),

  constraint bots_description_length
    check (
      description is null
      or char_length(description) <= 500
    ),

  constraint bots_customer_resolution_object
    check (jsonb_typeof(customer_resolution) = 'object'),

  constraint bots_portal_settings_object
    check (jsonb_typeof(portal_settings) = 'object')
);

comment on table public.bots is
  'Organization-scoped email services (EmailBot V2). Rules with bot_id belong to the bot; PAUSED bots keep their history but their rules are not evaluated.';

comment on column public.bots.customer_resolution is
  'How a bot email is matched to customers (source, identifierType, field, onMultipleMatches). Validated by the API.';

comment on column public.bots.portal_settings is
  'What the customer portal may show for this bot (showBody, showAttachments, fields). Validated by the API.';

-- organization_id-leading lookups are served by the two unique indexes above.

create trigger bots_set_updated_at
before update on public.bots
for each row
execute function public.set_updated_at();


-- ============================================================
-- RLS
-- ============================================================

alter table public.bots enable row level security;

create policy "Members can view bots"
on public.bots
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);

create policy "Owners and admins can create bots"
on public.bots
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
  and (created_by is null or created_by = (select auth.uid()))
  and (updated_by is null or updated_by = (select auth.uid()))
);

create policy "Owners and admins can update bots"
on public.bots
for update
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
)
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
  and (updated_by is null or updated_by = (select auth.uid()))
);

create policy "Owners and admins can delete bots"
on public.bots
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS (explicit: default privileges differ between environments)
-- ============================================================

revoke all on table public.bots
from anon, authenticated, service_role;

grant select
on table public.bots
to authenticated;

grant insert (
  organization_id,
  name,
  slug,
  description,
  status,
  customer_resolution,
  portal_settings,
  created_by,
  updated_by
)
on table public.bots
to authenticated;

grant update (
  name,
  slug,
  description,
  status,
  customer_resolution,
  portal_settings,
  updated_by
)
on table public.bots
to authenticated;

grant delete
on table public.bots
to authenticated;

-- Worker: which rules belong to a paused bot.
grant select (id, organization_id, status)
on table public.bots
to service_role;
