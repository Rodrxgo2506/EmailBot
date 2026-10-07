-- ============================================================
-- EmailBot - Commercial V1, phase 1 (2/2): plan catalog, prices and
-- entitlements
--
-- Approved catalog (V1): BASIC / PRO / BUSINESS, monthly and yearly
-- prices in PEN, hard limits and features per plan. No free plan.
-- No payments here: Culqi (checkout, subscriptions, webhooks) is the next
-- phase and will change organizations.plan through the backend; until
-- then the Super Admin keeps changing it (admin.update_organization).
--
--   plan_catalog       one row per commercial plan (code = organization_plan)
--   plan_prices        price per plan / billing period / currency
--                      (numeric(10,2) + generated integer cents; never float)
--   plan_entitlements  LIMIT (bigint, NULL = unlimited) or FEATURE (boolean)
--                      per plan; keys are text so new limits / features are
--                      new rows, not schema changes
--
-- Organizations:
--   - plan default FREE -> BASIC (new organizations never get FREE);
--   - organizations.plan must exist in plan_catalog: foreign key NOT VALID.
--     PostgreSQL checks it on every INSERT and on UPDATEs that change the
--     plan, but NOT on existing rows, so organizations created before
--     Commercial V1 keep plan = FREE untouched (no silent data change).
--     public.organization_entitlements() applies BASIC to them (the most
--     restrictive commercial plan) until the Super Admin assigns a plan.
--     Once no FREE row is left:
--       alter table public.organizations validate constraint organizations_plan_in_catalog;
--
-- Read model for the API:
--   public.organization_entitlements(org)  plan, effective plan and every
--                                          entitlement row of that plan
--   public.organization_usage(org, keys)   current usage of the limits
-- Both are SECURITY INVOKER: members read their own organization through
-- the existing RLS; the service role (OAuth callback) gets SELECT on
-- organizations(plan), plan_catalog and plan_entitlements only.
--
-- RLS template:
--   plan_catalog / plan_prices / plan_entitlements:
--     SELECT  authenticated (public commercial information, every row)
--     INSERT / UPDATE / DELETE  nobody through the Data API (migrations only)
--     anon: none. service_role: SELECT on plan_catalog and plan_entitlements.
--   Cross-organization: n/a (no tenant data). Customer (portal): no.
--
-- Rollback (manual; documented in docs/commercial-plans.md): drop the two
-- functions and three tables, drop the foreign key, restore the FREE
-- default and the previous admin.create_organization / update_organization.
-- The BASIC enum value cannot be removed and is harmless.
-- ============================================================


-- ============================================================
-- ENUMS
-- ============================================================

create type public.billing_period as enum (
  'MONTHLY',
  'YEARLY'
);

create type public.plan_entitlement_kind as enum (
  'LIMIT',
  'FEATURE'
);


-- ============================================================
-- PLAN CATALOG
-- ============================================================

create table public.plan_catalog (
  id uuid primary key default gen_random_uuid(),

  code public.organization_plan not null unique,

  name text not null,

  description text,

  -- Commercial highlight shown with the plan (e.g. "Más elegido").
  badge text,

  sort_order smallint not null default 0,

  active boolean not null default true,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  -- FREE is a legacy value of organization_plan, never a commercial plan.
  constraint plan_catalog_not_legacy
    check (code <> 'FREE'),

  constraint plan_catalog_name_length
    check (char_length(trim(name)) between 1 and 60),

  constraint plan_catalog_description_length
    check (description is null or char_length(description) <= 500),

  constraint plan_catalog_badge_length
    check (badge is null or char_length(trim(badge)) between 1 and 40)
);

comment on table public.plan_catalog is
  'Commercial plans (Commercial V1: BASIC, PRO, BUSINESS). organizations.plan references code.';


-- ============================================================
-- PLAN PRICES
--
-- One ACTIVE price per plan / period / currency. A price change is a new
-- row (the old one is deactivated), so future subscriptions can keep the
-- price they were sold at.
-- ============================================================

create table public.plan_prices (
  id uuid primary key default gen_random_uuid(),

  plan_id uuid not null
    references public.plan_catalog(id)
    on delete restrict,

  billing_period public.billing_period not null,

  currency text not null default 'PEN',

  -- Major units (soles). Never a float.
  amount numeric(10, 2) not null,

  -- Minor units (céntimos), derived: what payment providers expect.
  amount_cents integer generated always as ((amount * 100)::integer) stored,

  active boolean not null default true,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint plan_prices_amount_positive
    check (amount > 0),

  constraint plan_prices_currency_format
    check (currency ~ '^[A-Z]{3}$')
);

comment on table public.plan_prices is
  'Price of a plan per billing period and currency (amount in major units, amount_cents derived).';

create unique index plan_prices_one_active_idx
  on public.plan_prices(plan_id, billing_period, currency)
  where active;

create index plan_prices_plan_idx
  on public.plan_prices(plan_id);


-- ============================================================
-- PLAN ENTITLEMENTS
--
-- kind LIMIT:   limit_value = maximum (NULL = unlimited), enabled NULL.
-- kind FEATURE: enabled = true/false, limit_value NULL.
-- Keys known by the code: packages/types/src/plans.ts. Unknown keys are
-- ignored by the API; a missing LIMIT counts as 0 and a missing FEATURE as
-- disabled (fail closed).
-- ============================================================

create table public.plan_entitlements (
  plan_id uuid not null
    references public.plan_catalog(id)
    on delete cascade,

  key text not null,

  kind public.plan_entitlement_kind not null,

  limit_value bigint,

  enabled boolean,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  primary key (plan_id, key),

  constraint plan_entitlements_key_format
    check (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),

  constraint plan_entitlements_value
    check (
      (kind = 'LIMIT' and enabled is null and (limit_value is null or limit_value >= 0))
      or (kind = 'FEATURE' and enabled is not null and limit_value is null)
    )
);

comment on table public.plan_entitlements is
  'Limits (LIMIT, NULL = unlimited) and features (FEATURE) of each plan.';


-- ============================================================
-- UPDATED_AT
-- ============================================================

create trigger plan_catalog_set_updated_at
before update on public.plan_catalog
for each row
execute function public.set_updated_at();

create trigger plan_prices_set_updated_at
before update on public.plan_prices
for each row
execute function public.set_updated_at();

create trigger plan_entitlements_set_updated_at
before update on public.plan_entitlements
for each row
execute function public.set_updated_at();


-- ============================================================
-- COMMERCIAL V1 CATALOG (approved values)
-- ============================================================

insert into public.plan_catalog (code, name, badge, sort_order)
values
  ('BASIC', 'Básico', null, 1),
  ('PRO', 'Pro', 'Más elegido', 2),
  ('BUSINESS', 'Business', null, 3);

insert into public.plan_prices (plan_id, billing_period, currency, amount)
select c.id, v.billing_period::public.billing_period, 'PEN', v.amount
from (
  values
    ('BASIC', 'MONTHLY', 19.90::numeric(10, 2)),
    ('BASIC', 'YEARLY', 199.00::numeric(10, 2)),
    ('PRO', 'MONTHLY', 39.90::numeric(10, 2)),
    ('PRO', 'YEARLY', 399.00::numeric(10, 2)),
    ('BUSINESS', 'MONTHLY', 89.90::numeric(10, 2)),
    ('BUSINESS', 'YEARLY', 899.00::numeric(10, 2))
) as v(code, billing_period, amount)
join public.plan_catalog c on c.code = v.code::public.organization_plan;

-- Storage in bytes (1 GB = 1024^3 bytes); retention in days.
insert into public.plan_entitlements (plan_id, key, kind, limit_value)
select c.id, v.key, 'LIMIT', v.limit_value
from (
  values
    ('BASIC', 'EMAIL_ACCOUNTS', 2::bigint),
    ('BASIC', 'RULES', 10),
    ('BASIC', 'BOTS', 2),
    ('BASIC', 'MONTHLY_EMAILS', 2000),
    ('BASIC', 'MEMBERS', 2),
    ('BASIC', 'CUSTOMERS', 500),
    ('BASIC', 'STORAGE_BYTES', 1073741824),
    ('BASIC', 'RETENTION_DAYS', 30),
    ('PRO', 'EMAIL_ACCOUNTS', 5),
    ('PRO', 'RULES', 30),
    ('PRO', 'BOTS', 10),
    ('PRO', 'MONTHLY_EMAILS', 15000),
    ('PRO', 'MEMBERS', 5),
    ('PRO', 'CUSTOMERS', 2500),
    ('PRO', 'STORAGE_BYTES', 5368709120),
    ('PRO', 'RETENTION_DAYS', 90),
    ('BUSINESS', 'EMAIL_ACCOUNTS', 20),
    ('BUSINESS', 'RULES', 100),
    ('BUSINESS', 'BOTS', 50),
    ('BUSINESS', 'MONTHLY_EMAILS', 75000),
    ('BUSINESS', 'MEMBERS', 20),
    ('BUSINESS', 'CUSTOMERS', 10000),
    ('BUSINESS', 'STORAGE_BYTES', 26843545600),
    ('BUSINESS', 'RETENTION_DAYS', 365)
) as v(code, key, limit_value)
join public.plan_catalog c on c.code = v.code::public.organization_plan;

insert into public.plan_entitlements (plan_id, key, kind, enabled)
select c.id, v.key, 'FEATURE', v.enabled
from (
  values
    ('BASIC', 'GMAIL', true),
    ('BASIC', 'MICROSOFT', false),
    ('BASIC', 'ADVANCED_STATS', false),
    ('BASIC', 'PORTAL', false),
    ('BASIC', 'API', false),
    ('BASIC', 'PRIORITY_SUPPORT', false),
    ('PRO', 'GMAIL', true),
    ('PRO', 'MICROSOFT', true),
    ('PRO', 'ADVANCED_STATS', true),
    ('PRO', 'PORTAL', true),
    ('PRO', 'API', false),
    ('PRO', 'PRIORITY_SUPPORT', true),
    ('BUSINESS', 'GMAIL', true),
    ('BUSINESS', 'MICROSOFT', true),
    ('BUSINESS', 'ADVANCED_STATS', true),
    ('BUSINESS', 'PORTAL', true),
    ('BUSINESS', 'API', true),
    ('BUSINESS', 'PRIORITY_SUPPORT', true)
) as v(code, key, enabled)
join public.plan_catalog c on c.code = v.code::public.organization_plan;


-- ============================================================
-- ORGANIZATIONS
-- ============================================================

alter table public.organizations
  alter column plan set default 'BASIC';

-- NOT VALID: enforced for new rows and plan changes; legacy FREE rows are kept.
alter table public.organizations
  add constraint organizations_plan_in_catalog
  foreign key (plan)
  references public.plan_catalog(code)
  not valid;

comment on column public.organizations.plan is
  'Commercial plan (plan_catalog.code). FREE = legacy (pre Commercial V1), entitled as BASIC. Changed only by the Super Admin until the payments phase.';


-- ============================================================
-- READ MODEL
-- ============================================================

-- Plan, effective plan (legacy FREE -> BASIC) and every entitlement row of
-- the effective plan. No row = organization not visible to the caller.
create or replace function public.organization_entitlements(
  p_organization_id uuid
)
returns table (
  plan public.organization_plan,
  effective_plan public.organization_plan,
  key text,
  kind public.plan_entitlement_kind,
  limit_value bigint,
  enabled boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.plan, c.code, e.key, e.kind, e.limit_value, e.enabled
  from public.organizations o
  join public.plan_catalog c
    on c.code = (case when o.plan = 'FREE' then 'BASIC' else o.plan end)::public.organization_plan
  left join public.plan_entitlements e
    on e.plan_id = c.id
  where o.id = p_organization_id
  order by e.key;
$$;

comment on function public.organization_entitlements(uuid) is
  'Plan, effective plan (legacy FREE counts as BASIC) and entitlements of an organization. SECURITY INVOKER (RLS applies).';


-- Current usage of the measurable limits (p_keys NULL = all of them):
--   EMAIL_ACCOUNTS  mailboxes not DISCONNECTED (a disconnected one keeps its
--                   emails but neither syncs nor counts; reconnecting counts)
--   RULES           every rule
--   BOTS            ACTIVE bots (bots with emails can only be paused)
--   MEMBERS         every member, OWNER included
--   CUSTOMERS       ACTIVE customers (customers are suspended, never deleted)
--   MONTHLY_EMAILS  emails stored since the start of the current calendar
--                   month in the organization's time zone (UTC if invalid)
--   STORAGE_BYTES   size of the stored attachments
-- One statement per key, each only when requested, so a caller only needs
-- privileges on the tables of the keys it asks for (the service role asks
-- EMAIL_ACCOUNTS only).
create or replace function public.organization_usage(
  p_organization_id uuid,
  p_keys text[] default null
)
returns table (
  key text,
  used bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_month_start timestamptz;
begin
  if p_keys is null or 'EMAIL_ACCOUNTS' = any(p_keys) then
    key := 'EMAIL_ACCOUNTS';
    select count(*) into used
    from public.email_accounts a
    where a.organization_id = p_organization_id
      and a.status <> 'DISCONNECTED';
    return next;
  end if;

  if p_keys is null or 'RULES' = any(p_keys) then
    key := 'RULES';
    select count(*) into used
    from public.email_rules r
    where r.organization_id = p_organization_id;
    return next;
  end if;

  if p_keys is null or 'BOTS' = any(p_keys) then
    key := 'BOTS';
    select count(*) into used
    from public.bots b
    where b.organization_id = p_organization_id
      and b.status = 'ACTIVE';
    return next;
  end if;

  if p_keys is null or 'MEMBERS' = any(p_keys) then
    key := 'MEMBERS';
    select count(*) into used
    from public.organization_members m
    where m.organization_id = p_organization_id;
    return next;
  end if;

  if p_keys is null or 'CUSTOMERS' = any(p_keys) then
    key := 'CUSTOMERS';
    select count(*) into used
    from public.customers c
    where c.organization_id = p_organization_id
      and c.status = 'ACTIVE';
    return next;
  end if;

  if p_keys is null or 'MONTHLY_EMAILS' = any(p_keys) then
    select s.timezone into v_timezone
    from public.organization_settings s
    where s.organization_id = p_organization_id;

    begin
      v_month_start := date_trunc('month', now() at time zone coalesce(v_timezone, 'UTC')) at time zone coalesce(v_timezone, 'UTC');
    exception
      when invalid_parameter_value then
        v_month_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
    end;

    key := 'MONTHLY_EMAILS';
    select count(*) into used
    from public.emails e
    where e.organization_id = p_organization_id
      and e.created_at >= v_month_start;
    return next;
  end if;

  if p_keys is null or 'STORAGE_BYTES' = any(p_keys) then
    key := 'STORAGE_BYTES';
    select coalesce(sum(x.file_size), 0)::bigint into used
    from public.email_attachments x
    where x.organization_id = p_organization_id
      and x.storage_uploaded;
    return next;
  end if;
end;
$$;

comment on function public.organization_usage(uuid, text[]) is
  'Current usage of the plan limits of an organization (only the requested keys). SECURITY INVOKER (RLS applies).';


-- ============================================================
-- SUPER ADMIN: BASIC by default, FREE never assigned again
--
-- Same signatures, bodies and audit as 20261005120100_admin_functions.sql;
-- only the default plan (FREE -> BASIC) and an explicit refusal of FREE
-- change. CREATE OR REPLACE keeps the existing EXECUTE grants.
-- ============================================================

create or replace function admin.create_organization(
  p_actor_id uuid,
  p_name text,
  p_slug text,
  p_plan public.organization_plan,
  p_owner_user_id uuid,
  p_request_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_plan public.organization_plan := coalesce(p_plan, 'BASIC');
begin
  perform private.assert_platform_admin(p_actor_id);

  if v_plan = 'FREE' then
    raise exception 'FREE is not a commercial plan';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'Organization name must contain between 2 and 120 characters';
  end if;

  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Invalid organization slug';
  end if;

  if p_owner_user_id is null
    or not exists (select 1 from public.profiles p where p.id = p_owner_user_id)
  then
    raise exception 'Owner user does not exist';
  end if;

  insert into public.organizations (name, slug, plan)
  values (v_name, v_slug, v_plan)
  returning id into v_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_organization_id, p_owner_user_id, 'OWNER');

  insert into public.platform_audit_logs (
    actor_user_id, action, target_type, target_id, organization_id, metadata, request_id
  )
  values (
    p_actor_id,
    'organization.created',
    'organization',
    v_organization_id,
    v_organization_id,
    jsonb_build_object('plan', v_plan, 'ownerUserId', p_owner_user_id),
    left(p_request_id, 200)
  );

  return v_organization_id;
end;
$$;


create or replace function admin.update_organization(
  p_actor_id uuid,
  p_organization_id uuid,
  p_plan public.organization_plan,
  p_status public.organization_status,
  p_request_id text
)
returns table (
  id uuid,
  plan public.organization_plan,
  status public.organization_status,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before record;
  v_after record;
begin
  perform private.assert_platform_admin(p_actor_id);

  -- A legacy FREE organization keeps FREE until a commercial plan is chosen (p_plan NULL = unchanged).
  if p_plan = 'FREE' then
    raise exception 'FREE is not a commercial plan';
  end if;

  select o.id, o.plan, o.status, o.updated_at
  into v_before
  from public.organizations o
  where o.id = p_organization_id
  for update;

  if v_before.id is null then
    return;
  end if;

  if coalesce(p_plan, v_before.plan) = v_before.plan
    and coalesce(p_status, v_before.status) = v_before.status
  then
    return query select v_before.id, v_before.plan, v_before.status, v_before.updated_at;
    return;
  end if;

  update public.organizations o
  set plan = coalesce(p_plan, o.plan),
      status = coalesce(p_status, o.status)
  where o.id = p_organization_id
  returning o.id, o.plan, o.status, o.updated_at into v_after;

  if v_after.plan is distinct from v_before.plan then
    insert into public.platform_audit_logs (
      actor_user_id, action, target_type, target_id, organization_id, metadata, request_id
    )
    values (
      p_actor_id,
      'organization.plan_changed',
      'organization',
      p_organization_id,
      p_organization_id,
      jsonb_build_object('from', v_before.plan, 'to', v_after.plan),
      left(p_request_id, 200)
    );
  end if;

  if v_after.status is distinct from v_before.status then
    insert into public.platform_audit_logs (
      actor_user_id, action, target_type, target_id, organization_id, metadata, request_id
    )
    values (
      p_actor_id,
      case v_after.status
        when 'ACTIVE' then 'organization.reactivated'
        when 'SUSPENDED' then 'organization.suspended'
        else 'organization.cancelled'
      end,
      'organization',
      p_organization_id,
      p_organization_id,
      jsonb_build_object('from', v_before.status, 'to', v_after.status),
      left(p_request_id, 200)
    );
  end if;

  return query select v_after.id, v_after.plan, v_after.status, v_after.updated_at;
end;
$$;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.plan_catalog enable row level security;
alter table public.plan_prices enable row level security;
alter table public.plan_entitlements enable row level security;

create policy "Authenticated users can view the plan catalog"
on public.plan_catalog
for select
to authenticated
using (true);

create policy "Authenticated users can view plan prices"
on public.plan_prices
for select
to authenticated
using (true);

create policy "Authenticated users can view plan entitlements"
on public.plan_entitlements
for select
to authenticated
using (true);


-- ============================================================
-- PRIVILEGES
-- ============================================================

revoke all on table
  public.plan_catalog,
  public.plan_prices,
  public.plan_entitlements
from public, anon, authenticated, service_role;

grant select
on table public.plan_catalog, public.plan_prices, public.plan_entitlements
to authenticated;

-- API OAuth callback (service role): plan and entitlements of the organization only.
grant select
on table public.plan_catalog, public.plan_entitlements
to service_role;

grant select (plan)
on table public.organizations
to service_role;

revoke all on function public.organization_entitlements(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.organization_entitlements(uuid)
to authenticated, service_role;

revoke all on function public.organization_usage(uuid, text[])
from public, anon, authenticated, service_role;

grant execute on function public.organization_usage(uuid, text[])
to authenticated, service_role;
