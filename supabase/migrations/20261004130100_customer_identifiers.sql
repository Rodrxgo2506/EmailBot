-- ============================================================
-- EmailBot V2 - Phase 2: customer identifiers
--
-- Values that identify a customer inside an email (account email, phone,
-- username...). They are NOT credentials (the portal Access ID is a later
-- phase and is never stored here).
--
-- normalized_value is computed by the single normalizer of
-- @emailbot/validation (normalizeIdentifier). The checks below only enforce
-- invariants of its output (no logic duplicated in SQL):
--   EMAIL    lowercase, one "@", no whitespace (dots and +alias are kept)
--   PHONE    optional leading "+" and 6-15 digits
--   others   no leading/trailing whitespace, no ASCII uppercase
--
-- Uniqueness policy:
--   UNIQUE NULLS NOT DISTINCT (customer_id, type, normalized_value, bot_id)
--   - no exact duplicate for the same customer and scope;
--   - the same value MAY belong to several customers (shared accounts):
--     the bot's onMultipleMatches policy decides at delivery time (phase 3).
--
-- Scope: bot_id NULL = every bot the customer is assigned to; a bot id =
-- only that bot. The bot must belong to the identifier's organization
-- (composite foreign key). A bot that still scopes identifiers cannot be
-- deleted (NO ACTION): nothing is deleted or widened silently.
--
-- RLS (who can do what):
--   SELECT  members of the organization (all roles)
--   INSERT / UPDATE / DELETE  OWNER/ADMIN/OPERATOR
--   UPDATE  value, normalized_value, bot_id, active (never customer / organization / type)
--   cross-organization: impossible (RLS + composite foreign keys)
--   customers (portal) / platform admins: no access
--   service_role: no privilege yet (phase 3)
-- ============================================================

create type public.customer_identifier_type as enum ('EMAIL', 'PHONE', 'USERNAME', 'EXTERNAL_ID', 'CUSTOM');

create table public.customer_identifiers (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  customer_id uuid not null,

  type public.customer_identifier_type not null,

  -- As entered (trimmed), shown to the organization.
  value text not null,

  -- Canonical form used for lookups.
  normalized_value text not null,

  bot_id uuid,

  active boolean not null default true,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint customer_identifiers_customer_fkey
    foreign key (organization_id, customer_id)
    references public.customers(organization_id, id)
    on delete cascade,

  constraint customer_identifiers_bot_fkey
    foreign key (organization_id, bot_id)
    references public.bots(organization_id, id),

  constraint customer_identifiers_value_length
    check (char_length(trim(value)) between 1 and 320),

  constraint customer_identifiers_normalized_length
    check (char_length(normalized_value) between 1 and 320),

  constraint customer_identifiers_normalized_format
    check (
      case type
        when 'EMAIL' then normalized_value ~ '^[^@[:space:]]+@[^@[:space:]]+$'
          and normalized_value !~ '[A-Z]'
        when 'PHONE' then normalized_value ~ '^\+?[0-9]{6,15}$'
        else normalized_value = btrim(normalized_value)
          and normalized_value !~ '[A-Z]'
      end
    ),

  constraint customer_identifiers_unique_scope
    unique nulls not distinct (customer_id, type, normalized_value, bot_id)
);

comment on table public.customer_identifiers is
  'Values that identify a customer in emails (EmailBot V2). Not credentials. The same value may belong to several customers.';

-- Resolver lookup (phase 3): one indexed query per email.
create index customer_identifiers_lookup_idx
  on public.customer_identifiers(organization_id, type, normalized_value)
  where active;

create index customer_identifiers_customer_idx
  on public.customer_identifiers(organization_id, customer_id);

create index customer_identifiers_bot_idx
  on public.customer_identifiers(organization_id, bot_id)
  where bot_id is not null;

create trigger customer_identifiers_set_updated_at
before update on public.customer_identifiers
for each row
execute function public.set_updated_at();


-- ============================================================
-- RLS
-- ============================================================

alter table public.customer_identifiers enable row level security;

create policy "Members can view customer identifiers"
on public.customer_identifiers
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);

create policy "Operators and above can create customer identifiers"
on public.customer_identifiers
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);

create policy "Operators and above can update customer identifiers"
on public.customer_identifiers
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

create policy "Operators and above can delete customer identifiers"
on public.customer_identifiers
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

revoke all on table public.customer_identifiers
from anon, authenticated, service_role;

grant select
on table public.customer_identifiers
to authenticated;

grant insert (
  organization_id,
  customer_id,
  type,
  value,
  normalized_value,
  bot_id,
  active
)
on table public.customer_identifiers
to authenticated;

grant update (
  value,
  normalized_value,
  bot_id,
  active
)
on table public.customer_identifiers
to authenticated;

grant delete
on table public.customer_identifiers
to authenticated;
