-- ============================================================
-- EmailBot - Migration 2
--
-- Email accounts, categories and rule engine foundation
-- ============================================================


-- ============================================================
-- ENUMS
-- ============================================================

create type public.email_provider as enum (
  'GMAIL',
  'MICROSOFT',
  'IMAP'
);

create type public.email_account_status as enum (
  'ACTIVE',
  'PAUSED',
  'ERROR',
  'DISCONNECTED'
);

create type public.rule_match_mode as enum (
  'AND',
  'OR'
);


-- ============================================================
-- EMAIL ACCOUNTS
-- ============================================================

create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  provider public.email_provider not null,

  status public.email_account_status not null default 'ACTIVE',

  email_address text not null,

  display_name text,

  provider_account_id text,

  -- OAuth / IMAP credentials are expected to be stored encrypted.
  -- Never expose these fields directly to the frontend.
  access_token_encrypted text,
  refresh_token_encrypted text,

  token_expires_at timestamptz,

  -- Provider-specific information that does not belong
  -- in the normalized application model.
  provider_metadata jsonb not null default '{}'::jsonb,

  -- Provider synchronization cursor/state.
  sync_cursor text,

  last_synced_at timestamptz,

  last_error_code text,

  last_error_message text,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint email_accounts_email_length
    check (char_length(trim(email_address)) between 3 and 320),

  constraint email_accounts_email_format
    check (
      email_address ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),

  constraint email_accounts_display_name_length
    check (
      display_name is null
      or char_length(display_name) <= 200
    ),

  constraint email_accounts_provider_account_id_length
    check (
      provider_account_id is null
      or char_length(provider_account_id) <= 500
    ),

  constraint email_accounts_provider_metadata_object
    check (jsonb_typeof(provider_metadata) = 'object'),

  constraint email_accounts_error_code_length
    check (
      last_error_code is null
      or char_length(last_error_code) <= 100
    ),

  constraint email_accounts_error_message_length
    check (
      last_error_message is null
      or char_length(last_error_message) <= 2000
    )
);

comment on table public.email_accounts is
  'External email accounts connected to an EmailBot organization.';

comment on column public.email_accounts.access_token_encrypted is
  'Encrypted provider access token. Backend/worker only.';

comment on column public.email_accounts.refresh_token_encrypted is
  'Encrypted provider refresh token. Backend/worker only.';

comment on column public.email_accounts.provider_metadata is
  'Provider-specific metadata that is not part of the normalized email model.';


create index email_accounts_organization_id_idx
  on public.email_accounts(organization_id);

create index email_accounts_status_idx
  on public.email_accounts(organization_id, status);

create index email_accounts_provider_idx
  on public.email_accounts(organization_id, provider);

create unique index email_accounts_unique_address_idx
  on public.email_accounts(
    organization_id,
    provider,
    lower(email_address)
  );


-- ============================================================
-- CATEGORIES
-- ============================================================

create table public.categories (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  name text not null,

  slug text not null,

  description text,

  color text,

  icon text,

  is_system boolean not null default false,

  sort_order integer not null default 0,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint categories_name_length
    check (char_length(trim(name)) between 1 and 100),

  constraint categories_slug_format
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),

  constraint categories_description_length
    check (
      description is null
      or char_length(description) <= 500
    ),

  constraint categories_color_format
    check (
      color is null
      or color ~ '^#[0-9A-Fa-f]{6}$'
    ),

  constraint categories_icon_length
    check (
      icon is null
      or char_length(icon) <= 100
    ),

  constraint categories_sort_order_nonnegative
    check (sort_order >= 0)
);

comment on table public.categories is
  'Organization-scoped categories used to classify processed emails.';


create unique index categories_organization_slug_idx
  on public.categories(
    organization_id,
    slug
  );

create index categories_organization_sort_idx
  on public.categories(
    organization_id,
    sort_order,
    name
  );


-- ============================================================
-- EMAIL RULES
-- ============================================================

create table public.email_rules (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  category_id uuid
    references public.categories(id)
    on delete set null,

  name text not null,

  description text,

  enabled boolean not null default true,

  priority integer not null default 100,

  stop_processing boolean not null default false,

  match_mode public.rule_match_mode not null default 'AND',

  /*
    Conditions are intentionally stored as JSONB.

    Example:

    {
      "conditions": [
        {
          "field": "sender",
          "operator": "contains",
          "value": "netflix.com"
        },
        {
          "field": "subject",
          "operator": "contains",
          "value": "código temporal"
        }
      ]
    }
  */
  conditions jsonb not null default
    '{"conditions":[]}'::jsonb,

  /*
    Example:

    {
      "actions": [
        {
          "type": "CATEGORY",
          "category_id": "..."
        },
        {
          "type": "EXTRACT",
          "name": "verification_code",
          "pattern": "\\b[0-9]{6}\\b"
        },
        {
          "type": "MARK_IMPORTANT"
        },
        {
          "type": "NOTIFY"
        }
      ]
    }
  */
  actions jsonb not null default
    '{"actions":[]}'::jsonb,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  updated_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint email_rules_name_length
    check (char_length(trim(name)) between 1 and 150),

  constraint email_rules_description_length
    check (
      description is null
      or char_length(description) <= 1000
    ),

  constraint email_rules_priority_nonnegative
    check (priority >= 0),

  constraint email_rules_conditions_object
    check (jsonb_typeof(conditions) = 'object'),

  constraint email_rules_actions_object
    check (jsonb_typeof(actions) = 'object'),

  constraint email_rules_conditions_array
    check (
      jsonb_typeof(conditions -> 'conditions') = 'array'
    ),

  constraint email_rules_actions_array
    check (
      jsonb_typeof(actions -> 'actions') = 'array'
    )
);

comment on table public.email_rules is
  'Organization-scoped data-driven rules used to classify and process incoming emails.';

comment on column public.email_rules.conditions is
  'JSONB rule conditions evaluated by the EmailBot rule engine.';

comment on column public.email_rules.actions is
  'JSONB actions executed when the rule matches.';


create index email_rules_organization_id_idx
  on public.email_rules(organization_id);

create index email_rules_execution_idx
  on public.email_rules(
    organization_id,
    enabled,
    priority
  );

create index email_rules_category_id_idx
  on public.email_rules(category_id);

create index email_rules_conditions_gin_idx
  on public.email_rules
  using gin (conditions);

create index email_rules_actions_gin_idx
  on public.email_rules
  using gin (actions);


-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

create trigger email_accounts_set_updated_at
before update on public.email_accounts
for each row
execute function public.set_updated_at();


create trigger categories_set_updated_at
before update on public.categories
for each row
execute function public.set_updated_at();


create trigger email_rules_set_updated_at
before update on public.email_rules
for each row
execute function public.set_updated_at();


-- ============================================================
-- RLS
-- ============================================================

alter table public.email_accounts
enable row level security;

alter table public.categories
enable row level security;

alter table public.email_rules
enable row level security;


-- ============================================================
-- EMAIL ACCOUNTS POLICIES
-- ============================================================

create policy "Members can view email accounts"
on public.email_accounts
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


create policy "Owners and admins can create email accounts"
on public.email_accounts
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


create policy "Owners and admins can update email accounts"
on public.email_accounts
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
);


create policy "Owners and admins can delete email accounts"
on public.email_accounts
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- CATEGORY POLICIES
-- ============================================================

create policy "Members can view categories"
on public.categories
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


create policy "Owners and admins can create categories"
on public.categories
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


create policy "Owners and admins can update categories"
on public.categories
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
);


create policy "Owners and admins can delete categories"
on public.categories
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- RULE POLICIES
-- ============================================================

create policy "Members can view email rules"
on public.email_rules
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


create policy "Owners and admins can create email rules"
on public.email_rules
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
  and
  (
    created_by is null
    or created_by = (select auth.uid())
  )
);


create policy "Owners and admins can update email rules"
on public.email_rules
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
);


create policy "Owners and admins can delete email rules"
on public.email_rules
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS
-- ============================================================

revoke all on table public.email_accounts
from anon, authenticated;

grant select
on table public.email_accounts
to authenticated;

grant insert (
  organization_id,
  provider,
  status,
  email_address,
  display_name,
  provider_account_id,
  access_token_encrypted,
  refresh_token_encrypted,
  token_expires_at,
  provider_metadata,
  sync_cursor,
  last_synced_at,
  last_error_code,
  last_error_message
)
on table public.email_accounts
to authenticated;

grant update (
  provider,
  status,
  email_address,
  display_name,
  provider_account_id,
  access_token_encrypted,
  refresh_token_encrypted,
  token_expires_at,
  provider_metadata,
  sync_cursor,
  last_synced_at,
  last_error_code,
  last_error_message
)
on table public.email_accounts
to authenticated;

grant delete
on table public.email_accounts
to authenticated;


revoke all on table public.categories
from anon, authenticated;

grant select
on table public.categories
to authenticated;

grant insert (
  organization_id,
  name,
  slug,
  description,
  color,
  icon,
  is_system,
  sort_order
)
on table public.categories
to authenticated;

grant update (
  name,
  slug,
  description,
  color,
  icon,
  is_system,
  sort_order
)
on table public.categories
to authenticated;

grant delete
on table public.categories
to authenticated;


revoke all on table public.email_rules
from anon, authenticated;

grant select
on table public.email_rules
to authenticated;

grant insert (
  organization_id,
  category_id,
  name,
  description,
  enabled,
  priority,
  stop_processing,
  match_mode,
  conditions,
  actions,
  created_by,
  updated_by
)
on table public.email_rules
to authenticated;

grant update (
  category_id,
  name,
  description,
  enabled,
  priority,
  stop_processing,
  match_mode,
  conditions,
  actions,
  updated_by
)
on table public.email_rules
to authenticated;

grant delete
on table public.email_rules
to authenticated;


-- ============================================================
-- COMMENTS
-- ============================================================

comment on table public.email_accounts is
  'Connected Gmail, Microsoft or IMAP accounts belonging to an EmailBot organization.';

comment on table public.categories is
  'Custom organization categories used to classify emails.';

comment on table public.email_rules is
  'Data-driven rules defining how matching emails should be classified and processed.';