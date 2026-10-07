-- ============================================================
-- EmailBot - Commercial V1, phase 1.1: mandatory subscription
--
-- EmailBot is a paid service: no free plan, no trial, no free BASIC. The
-- commercial source of truth becomes
--
--   organization -> subscription (ACTIVE, period not ended) -> plan_price
--                -> plan_catalog -> plan_entitlements
--
-- and organizations.plan is only a CACHE of the plan of the ACTIVE
-- subscription, written exclusively by private.sync_organization_plan().
--
--   - New organizations have NO plan (plan NULL, no default) and no access
--     to the commercial features until a subscription is activated.
--   - subscriptions: one OPEN subscription (ACTIVE / PAST_DUE / SUSPENDED)
--     per organization (partial unique index); CANCELED / EXPIRED are
--     terminal and kept as history. Renewals and plan changes update the
--     open subscription (no proration, credits or refunds here).
--   - payment_events: idempotent record of payments (unique
--     external_event_id), ready for the Culqi webhooks of the next phase.
--   - private.activate_subscription(): the ONLY way to activate / renew /
--     change the plan of a subscription. Today it is reached through
--     admin.activate_subscription (Super Admin, manual payments: YAPE, CASH,
--     TRANSFER, MANUAL); the Culqi webhook will call it with origin CULQI.
--   - private.change_subscription_status(): suspend, reactivate, cancel,
--     expire (and PAST_DUE for the payment provider).
--   - Every change is audited in platform_audit_logs (same transaction).
--
-- LEGACY: organizations created before this phase keep their plan (FREE,
-- PRO, ...) untouched. While an organization has NEVER had a subscription,
-- organization_entitlements() keeps granting that plan (FREE -> BASIC):
-- nothing real changes at deploy time. Its first subscription ends the
-- legacy grant (audited, with the previous plan). No data is converted here.
--
-- Prices shown to customers include IGV (decision recorded in
-- docs/commercial-plans.md; no tax / SUNAT logic here).
--
-- RLS template:
--   subscriptions   SELECT members of the organization; no writes through
--                   the Data API (functions only). service_role: SELECT
--                   (entitlements in the OAuth callback).
--   payment_events  nobody through the Data API (admin.* functions only).
--   Super Admin: admin.* functions (actor re-checked). Customer (portal): no.
-- ============================================================


-- ============================================================
-- ENUMS
-- ============================================================

create type public.subscription_status as enum (
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELED',
  'EXPIRED'
);

create type public.payment_method as enum (
  'CULQI',
  'YAPE',
  'CASH',
  'TRANSFER',
  'MANUAL'
);

-- Who activated the subscription: the Super Admin (manual payment) or the
-- payment provider (webhook, next phase).
create type public.subscription_origin as enum (
  'ADMIN',
  'CULQI'
);


-- ============================================================
-- ORGANIZATIONS: no plan by default
-- ============================================================

alter table public.organizations
  alter column plan drop default;

alter table public.organizations
  alter column plan drop not null;

comment on column public.organizations.plan is
  'CACHE of the plan of the ACTIVE subscription (NULL = none), written only by private.sync_organization_plan(). Legacy rows (never subscribed) keep their pre-subscription plan; FREE = legacy, entitled as BASIC.';


-- ============================================================
-- SUBSCRIPTIONS
-- ============================================================

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  plan_price_id uuid not null
    references public.plan_prices(id)
    on delete restrict,

  status public.subscription_status not null,

  payment_method public.payment_method not null,

  origin public.subscription_origin not null,

  -- Subscription id at the payment provider (Culqi, next phase).
  external_subscription_id text,

  started_at timestamptz not null,

  current_period_start timestamptz not null,

  current_period_end timestamptz not null,

  canceled_at timestamptz,

  suspended_at timestamptz,

  expired_at timestamptz,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint subscriptions_period
    check (
      current_period_end > current_period_start
      and current_period_end <= current_period_start + interval '2 years'
    ),

  constraint subscriptions_started
    check (started_at <= current_period_start),

  constraint subscriptions_suspended_at
    check ((status = 'SUSPENDED') = (suspended_at is not null)),

  constraint subscriptions_canceled_at
    check ((status = 'CANCELED') = (canceled_at is not null)),

  constraint subscriptions_expired_at
    check ((status = 'EXPIRED') = (expired_at is not null)),

  constraint subscriptions_external_id_length
    check (external_subscription_id is null or char_length(external_subscription_id) between 1 and 200)
);

comment on table public.subscriptions is
  'Commercial subscription of an organization. One open (ACTIVE / PAST_DUE / SUSPENDED) per organization; CANCELED / EXPIRED are history. Written only by private.* subscription functions.';

-- At most one open subscription per organization (a plain UNIQUE would also forbid history rows).
create unique index subscriptions_one_open_per_organization
  on public.subscriptions(organization_id)
  where status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED');

create unique index subscriptions_external_id_unique
  on public.subscriptions(external_subscription_id)
  where external_subscription_id is not null;

create index subscriptions_organization_created_idx
  on public.subscriptions(organization_id, created_at desc);

-- Expiration sweep (private.expire_due_subscriptions).
create index subscriptions_due_idx
  on public.subscriptions(current_period_end)
  where status in ('ACTIVE', 'PAST_DUE');

create index subscriptions_plan_price_idx
  on public.subscriptions(plan_price_id);

create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row
execute function public.set_updated_at();


-- ============================================================
-- PAYMENT EVENTS
--
-- external_event_id is UNIQUE: a provider event (or a manual payment
-- reference) is processed once. Rows outlive the organization (SET NULL).
-- ============================================================

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),

  external_event_id text unique,

  organization_id uuid
    references public.organizations(id)
    on delete set null,

  subscription_id uuid
    references public.subscriptions(id)
    on delete set null,

  -- "payment.manual", later the provider's events ("charge.succeeded", ...).
  event_type text not null,

  payment_method public.payment_method not null,

  amount numeric(10, 2),

  currency text not null default 'PEN',

  status text not null default 'RECEIVED',

  metadata jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null default now(),

  processed_at timestamptz,

  recorded_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  constraint payment_events_external_id_length
    check (external_event_id is null or char_length(external_event_id) between 1 and 200),

  constraint payment_events_type_format
    check (char_length(event_type) <= 100 and event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),

  constraint payment_events_amount_nonnegative
    check (amount is null or amount >= 0),

  constraint payment_events_currency_format
    check (currency ~ '^[A-Z]{3}$'),

  constraint payment_events_status
    check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),

  constraint payment_events_processed_at
    check (status = 'RECEIVED' or processed_at is not null),

  constraint payment_events_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.payment_events is
  'Idempotent payment record (unique external_event_id): manual payments now, payment provider webhooks later. Written only by private.* functions.';

create index payment_events_organization_idx
  on public.payment_events(organization_id, occurred_at desc);

create index payment_events_subscription_idx
  on public.payment_events(subscription_id);


-- ============================================================
-- organizations.plan IS A CACHE
--
-- Only private.sync_organization_plan() may set it (it raises a
-- transaction-local flag around its UPDATE). Everything else - API, admin
-- functions, the dashboard - gets an error, so organizations.plan can never
-- disagree with the subscription.
-- ============================================================

create or replace function private.guard_organization_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('emailbot.subscription_sync', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' and new.plan is not null then
    raise exception 'organizations.plan is derived from the subscription and cannot be set directly';
  end if;

  if tg_op = 'UPDATE' and new.plan is distinct from old.plan then
    raise exception 'organizations.plan is derived from the subscription and cannot be set directly';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_organization_plan()
from public, anon, authenticated, service_role;

create trigger organizations_guard_plan
before insert or update of plan on public.organizations
for each row
execute function private.guard_organization_plan();


-- Recomputes the cache from the subscriptions. An organization that never
-- had a subscription (legacy) keeps its plan.
create or replace function private.sync_organization_plan(
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.organization_plan;
begin
  if not exists (select 1 from public.subscriptions s where s.organization_id = p_organization_id) then
    return;
  end if;

  select c.code
  into v_plan
  from public.subscriptions s
  join public.plan_prices p on p.id = s.plan_price_id
  join public.plan_catalog c on c.id = p.plan_id
  where s.organization_id = p_organization_id
    and s.status = 'ACTIVE';

  perform set_config('emailbot.subscription_sync', 'on', true);

  update public.organizations o
  set plan = v_plan
  where o.id = p_organization_id
    and o.plan is distinct from v_plan;

  perform set_config('emailbot.subscription_sync', 'off', true);
end;
$$;

revoke all on function private.sync_organization_plan(uuid)
from public, anon, authenticated, service_role;


-- ============================================================
-- CORE: activate / renew / change plan
--
-- One transaction: idempotency (payment event first, unique
-- external_event_id), the open subscription updated or a new one created,
-- the plan cache, the payment event linked and processed, the audit trail.
-- Outcomes: ACTIVATED (new subscription), RENEWED (same price, new period,
-- also reactivates SUSPENDED / PAST_DUE), PLAN_CHANGED (another price),
-- DUPLICATE (external_event_id already recorded: nothing changes).
-- ============================================================

create or replace function private.activate_subscription(
  p_organization_id uuid,
  p_plan_price_id uuid,
  p_payment_method public.payment_method,
  p_origin public.subscription_origin,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_amount numeric,
  p_currency text,
  p_external_event_id text,
  p_event_type text,
  p_actor_id uuid,
  p_request_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  subscription_id uuid,
  outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org record;
  v_price record;
  v_open record;
  v_event_id uuid;
  v_subscription_id uuid;
  v_outcome text;
  v_from_plan public.organization_plan;
  v_from_period public.billing_period;
begin
  if p_organization_id is null or p_plan_price_id is null or p_payment_method is null or p_origin is null then
    raise exception 'Organization, price, payment method and origin are required';
  end if;

  if p_origin = 'CULQI' and p_payment_method <> 'CULQI' then
    raise exception 'A CULQI activation must use the CULQI payment method';
  end if;

  if p_origin = 'ADMIN' and p_payment_method = 'CULQI' then
    raise exception 'CULQI payments are activated by the payment provider, not manually';
  end if;

  -- Idempotency: the same provider event / payment reference is applied once.
  if p_external_event_id is not null or p_amount is not null then
    insert into public.payment_events (
      external_event_id, organization_id, event_type, payment_method, amount, currency, status, metadata, recorded_by
    )
    values (
      p_external_event_id,
      p_organization_id,
      coalesce(p_event_type, 'payment.manual'),
      p_payment_method,
      p_amount,
      coalesce(p_currency, 'PEN'),
      'RECEIVED',
      coalesce(p_metadata, '{}'::jsonb),
      p_actor_id
    )
    on conflict (external_event_id) do nothing
    returning id into v_event_id;

    if v_event_id is null then
      return query
        select e.subscription_id, 'DUPLICATE'::text
        from public.payment_events e
        where e.external_event_id = p_external_event_id;
      return;
    end if;
  end if;

  select o.id, o.plan into v_org
  from public.organizations o
  where o.id = p_organization_id
  for update;

  if v_org.id is null then
    raise exception 'Organization does not exist';
  end if;

  select p.id, p.active, p.billing_period, p.currency, c.code as plan
  into v_price
  from public.plan_prices p
  join public.plan_catalog c on c.id = p.plan_id
  where p.id = p_plan_price_id;

  if v_price.id is null or not v_price.active then
    raise exception 'The price does not exist or is not active';
  end if;

  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'The period must end after it starts';
  end if;

  if p_period_end <= now() then
    raise exception 'The period has already ended';
  end if;

  if p_amount is not null and coalesce(p_currency, 'PEN') <> v_price.currency then
    raise exception 'The payment currency does not match the price';
  end if;

  select s.id, s.status, s.plan_price_id, s.current_period_end
  into v_open
  from public.subscriptions s
  where s.organization_id = p_organization_id
    and s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
  for update;

  if v_open.id is null then
    insert into public.subscriptions (
      organization_id, plan_price_id, status, payment_method, origin,
      started_at, current_period_start, current_period_end, created_by
    )
    values (
      p_organization_id, p_plan_price_id, 'ACTIVE', p_payment_method, p_origin,
      p_period_start, p_period_start, p_period_end, p_actor_id
    )
    returning id into v_subscription_id;
    v_outcome := 'ACTIVATED';
  else
    select c.code, p.billing_period into v_from_plan, v_from_period
    from public.plan_prices p
    join public.plan_catalog c on c.id = p.plan_id
    where p.id = v_open.plan_price_id;

    update public.subscriptions s
    set plan_price_id = p_plan_price_id,
        status = 'ACTIVE',
        payment_method = p_payment_method,
        origin = p_origin,
        started_at = least(s.started_at, p_period_start),
        current_period_start = p_period_start,
        current_period_end = p_period_end,
        suspended_at = null
    where s.id = v_open.id;

    v_subscription_id := v_open.id;
    v_outcome := case when v_open.plan_price_id = p_plan_price_id then 'RENEWED' else 'PLAN_CHANGED' end;
  end if;

  perform private.sync_organization_plan(p_organization_id);

  if v_event_id is not null then
    update public.payment_events e
    set subscription_id = v_subscription_id,
        status = 'PROCESSED',
        processed_at = now()
    where e.id = v_event_id;
  end if;

  insert into public.platform_audit_logs (
    actor_user_id, action, target_type, target_id, organization_id, metadata, request_id
  )
  values (
    p_actor_id,
    case v_outcome
      when 'ACTIVATED' then 'subscription.activated'
      when 'RENEWED' then 'subscription.renewed'
      else 'subscription.plan_changed'
    end,
    'subscription',
    v_subscription_id,
    p_organization_id,
    jsonb_strip_nulls(jsonb_build_object(
      'plan', v_price.plan,
      'billingPeriod', v_price.billing_period,
      'paymentMethod', p_payment_method,
      'origin', p_origin,
      'periodStart', p_period_start,
      'periodEnd', p_period_end,
      'previousStatus', v_open.status,
      'fromPlan', v_from_plan,
      'fromBillingPeriod', v_from_period,
      -- First subscription of a pre-subscription organization (e.g. legacy FREE).
      'previousOrganizationPlan', case when v_outcome = 'ACTIVATED' then v_org.plan end
    )),
    left(p_request_id, 200)
  );

  if v_event_id is not null then
    insert into public.platform_audit_logs (
      actor_user_id, action, target_type, target_id, organization_id, metadata, request_id
    )
    values (
      p_actor_id,
      'payment.recorded',
      'payment_event',
      v_event_id,
      p_organization_id,
      jsonb_strip_nulls(jsonb_build_object(
        'paymentMethod', p_payment_method,
        'amount', p_amount,
        'currency', coalesce(p_currency, 'PEN'),
        'reference', p_external_event_id,
        'subscriptionId', v_subscription_id
      )),
      left(p_request_id, 200)
    );
  end if;

  return query select v_subscription_id, v_outcome;
end;
$$;

revoke all on function private.activate_subscription(uuid, uuid, public.payment_method, public.subscription_origin, timestamptz, timestamptz, numeric, text, text, text, uuid, text, jsonb)
from public, anon, authenticated, service_role;


-- ============================================================
-- CORE: status changes
--
--   SUSPENDED  from ACTIVE / PAST_DUE        (admin decision, non payment, incident)
--   ACTIVE     from SUSPENDED / PAST_DUE     (reactivation; only inside the paid period)
--   PAST_DUE   from ACTIVE                   (payment provider, next phase)
--   CANCELED   from ACTIVE / PAST_DUE / SUSPENDED (terminal; access ends now)
--   EXPIRED    from ACTIVE / PAST_DUE / SUSPENDED once the period ended (terminal)
-- Nothing is deleted: only the subscription row and the plan cache change.
-- ============================================================

create or replace function private.change_subscription_status(
  p_subscription_id uuid,
  p_status public.subscription_status,
  p_actor_id uuid,
  p_reason text,
  p_request_id text,
  p_now timestamptz default now()
)
returns table (
  subscription_id uuid,
  status public.subscription_status
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub record;
  v_allowed boolean;
begin
  select s.id, s.organization_id, s.status, s.current_period_end
  into v_sub
  from public.subscriptions s
  where s.id = p_subscription_id
  for update;

  if v_sub.id is null then
    return;
  end if;

  v_allowed := case p_status
    when 'SUSPENDED' then v_sub.status in ('ACTIVE', 'PAST_DUE')
    when 'ACTIVE' then v_sub.status in ('SUSPENDED', 'PAST_DUE')
    when 'PAST_DUE' then v_sub.status = 'ACTIVE'
    when 'CANCELED' then v_sub.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
    when 'EXPIRED' then v_sub.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
    else false
  end;

  if not v_allowed then
    raise exception 'A % subscription cannot become %', v_sub.status, p_status;
  end if;

  if p_status = 'ACTIVE' and v_sub.current_period_end <= p_now then
    raise exception 'The paid period has ended: activate a new period instead';
  end if;

  if p_status = 'EXPIRED' and v_sub.current_period_end > p_now then
    raise exception 'The period has not ended yet: suspend or cancel instead';
  end if;

  update public.subscriptions s
  set status = p_status,
      suspended_at = case when p_status = 'SUSPENDED' then p_now end,
      canceled_at = case when p_status = 'CANCELED' then p_now end,
      expired_at = case when p_status = 'EXPIRED' then p_now end
  where s.id = p_subscription_id;

  perform private.sync_organization_plan(v_sub.organization_id);

  insert into public.platform_audit_logs (
    actor_user_id, action, target_type, target_id, organization_id, metadata, request_id
  )
  values (
    p_actor_id,
    case p_status
      when 'SUSPENDED' then 'subscription.suspended'
      when 'ACTIVE' then 'subscription.reactivated'
      when 'PAST_DUE' then 'subscription.past_due'
      when 'CANCELED' then 'subscription.canceled'
      else 'subscription.expired'
    end,
    'subscription',
    p_subscription_id,
    v_sub.organization_id,
    jsonb_strip_nulls(jsonb_build_object('from', v_sub.status, 'to', p_status, 'reason', nullif(trim(p_reason), ''))),
    left(p_request_id, 200)
  );

  return query select p_subscription_id, p_status;
end;
$$;

revoke all on function private.change_subscription_status(uuid, public.subscription_status, uuid, text, text, timestamptz)
from public, anon, authenticated, service_role;


-- Marks ACTIVE / PAST_DUE / SUSPENDED subscriptions whose period ended as
-- EXPIRED. NOT scheduled yet (no automatic renewal or expiration job in this
-- phase); organization_entitlements() already denies access once the period
-- ended, so access is right even before this runs.
create or replace function private.expire_due_subscriptions(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select s.id
    from public.subscriptions s
    where s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
      and s.current_period_end <= p_now
    order by s.current_period_end
  loop
    perform private.change_subscription_status(v_id, 'EXPIRED', null, 'period_ended', null, p_now);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.expire_due_subscriptions(timestamptz)
from public, anon, authenticated, service_role;


-- ============================================================
-- ENTITLEMENTS: from the subscription
--
-- access SUBSCRIPTION  ACTIVE subscription whose period has not ended
-- access LEGACY        never had a subscription and has a pre-subscription
--                      plan (FREE -> BASIC)
-- access NONE          anything else: no commercial plan (effective_plan
--                      NULL, no entitlement rows)
-- (Return type changes: drop and create.)
-- ============================================================

drop function if exists public.organization_entitlements(uuid);

create function public.organization_entitlements(
  p_organization_id uuid
)
returns table (
  plan public.organization_plan,
  effective_plan public.organization_plan,
  access text,
  subscription_status public.subscription_status,
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
  with org as (
    select o.id, o.plan
    from public.organizations o
    where o.id = p_organization_id
  ),
  latest as (
    -- The open subscription, or else the most recent one (history).
    select s.status, s.current_period_end, c.code
    from public.subscriptions s
    join public.plan_prices p on p.id = s.plan_price_id
    join public.plan_catalog c on c.id = p.plan_id
    where s.organization_id = p_organization_id
    order by (s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')) desc, s.created_at desc
    limit 1
  ),
  decision as (
    select
      org.plan,
      case
        when l.status = 'ACTIVE' and l.current_period_end > now() then l.code
        when l.status is null and org.plan is not null
          then (case when org.plan = 'FREE' then 'BASIC' else org.plan end)::public.organization_plan
      end as effective_plan,
      case
        when l.status = 'ACTIVE' and l.current_period_end > now() then 'SUBSCRIPTION'
        when l.status is null and org.plan is not null then 'LEGACY'
        else 'NONE'
      end as access,
      l.status as subscription_status
    from org
    left join latest l on true
  )
  select d.plan, d.effective_plan, d.access, d.subscription_status, e.key, e.kind, e.limit_value, e.enabled
  from decision d
  left join public.plan_catalog c on c.code = d.effective_plan
  left join public.plan_entitlements e on e.plan_id = c.id
  order by e.key;
$$;

comment on function public.organization_entitlements(uuid) is
  'Plan cache, effective plan, access (SUBSCRIPTION / LEGACY / NONE), subscription status and entitlements of an organization. SECURITY INVOKER (RLS applies).';

revoke all on function public.organization_entitlements(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.organization_entitlements(uuid)
to authenticated, service_role;


-- ============================================================
-- SUPER ADMIN
-- ============================================================

-- Organizations are created WITHOUT a plan; the plan comes from a
-- subscription (admin.activate_subscription). Same signatures as before so
-- the grants stay; a plan argument is now refused.
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
begin
  perform private.assert_platform_admin(p_actor_id);

  if p_plan is not null then
    raise exception 'The plan comes from a subscription: create the organization, then activate its subscription';
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

  insert into public.organizations (name, slug)
  values (v_name, v_slug)
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
    jsonb_build_object('ownerUserId', p_owner_user_id),
    left(p_request_id, 200)
  );

  return v_organization_id;
end;
$$;


-- Status only (organizations.status: ACTIVE / SUSPENDED / CANCELLED, the
-- operational state). The plan changes only through subscriptions.
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

  if p_plan is not null then
    raise exception 'The plan comes from a subscription: use admin.activate_subscription';
  end if;

  select o.id, o.plan, o.status, o.updated_at
  into v_before
  from public.organizations o
  where o.id = p_organization_id
  for update;

  if v_before.id is null then
    return;
  end if;

  if p_status is null or p_status = v_before.status then
    return query select v_before.id, v_before.plan, v_before.status, v_before.updated_at;
    return;
  end if;

  update public.organizations o
  set status = p_status
  where o.id = p_organization_id
  returning o.id, o.plan, o.status, o.updated_at into v_after;

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

  return query select v_after.id, v_after.plan, v_after.status, v_after.updated_at;
end;
$$;


-- Active catalog prices (what the Super Admin can sell).
create or replace function admin.list_plan_prices(
  p_actor_id uuid
)
returns table (
  plan_price_id uuid,
  plan public.organization_plan,
  plan_name text,
  billing_period public.billing_period,
  currency text,
  amount numeric,
  amount_cents integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
    select p.id, c.code, c.name, p.billing_period, p.currency, p.amount, p.amount_cents
    from public.plan_prices p
    join public.plan_catalog c on c.id = p.plan_id
    where p.active and c.active
    order by c.sort_order, p.billing_period;
end;
$$;


-- Subscriptions of an organization, newest first (the open one, then history).
create or replace function admin.list_subscriptions(
  p_actor_id uuid,
  p_organization_id uuid
)
returns table (
  id uuid,
  plan public.organization_plan,
  billing_period public.billing_period,
  currency text,
  list_amount numeric,
  status public.subscription_status,
  payment_method public.payment_method,
  origin public.subscription_origin,
  started_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  suspended_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
    select s.id, c.code, p.billing_period, p.currency, p.amount, s.status, s.payment_method, s.origin,
           s.started_at, s.current_period_start, s.current_period_end, s.canceled_at, s.suspended_at,
           s.expired_at, s.created_at, s.updated_at
    from public.subscriptions s
    join public.plan_prices p on p.id = s.plan_price_id
    join public.plan_catalog c on c.id = p.plan_id
    where s.organization_id = p_organization_id
    order by (s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')) desc, s.created_at desc;
end;
$$;


create or replace function admin.list_payment_events(
  p_actor_id uuid,
  p_organization_id uuid,
  p_limit integer
)
returns table (
  id uuid,
  subscription_id uuid,
  event_type text,
  payment_method public.payment_method,
  amount numeric,
  currency text,
  status text,
  reference text,
  note text,
  occurred_at timestamptz,
  processed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
    select e.id, e.subscription_id, e.event_type, e.payment_method, e.amount, e.currency, e.status,
           e.external_event_id, e.metadata ->> 'note', e.occurred_at, e.processed_at
    from public.payment_events e
    where e.organization_id = p_organization_id
    order by e.occurred_at desc
    limit least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;


-- Manual payment (YAPE / CASH / TRANSFER / MANUAL) registered by the Super
-- Admin: resolves the ACTIVE price of plan + period and calls the core.
-- p_reference (operation number, receipt...) makes the registration
-- idempotent: the same method + reference is recorded once.
create or replace function admin.activate_subscription(
  p_actor_id uuid,
  p_organization_id uuid,
  p_plan public.organization_plan,
  p_billing_period public.billing_period,
  p_payment_method public.payment_method,
  p_amount numeric,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_reference text,
  p_note text,
  p_request_id text
)
returns table (
  subscription_id uuid,
  outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price_id uuid;
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform private.assert_platform_admin(p_actor_id);

  if p_payment_method is null or p_payment_method = 'CULQI' then
    raise exception 'Manual activations use YAPE, CASH, TRANSFER or MANUAL';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'The amount paid must be greater than zero';
  end if;

  if v_reference is not null and char_length(v_reference) > 100 then
    raise exception 'The payment reference cannot exceed 100 characters';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'The note cannot exceed 500 characters';
  end if;

  select p.id into v_price_id
  from public.plan_prices p
  join public.plan_catalog c on c.id = p.plan_id
  where c.code = p_plan
    and c.active
    and p.billing_period = p_billing_period
    and p.currency = 'PEN'
    and p.active;

  if v_price_id is null then
    raise exception 'There is no active price for that plan and period';
  end if;

  return query
    select a.subscription_id, a.outcome
    from private.activate_subscription(
      p_organization_id,
      v_price_id,
      p_payment_method,
      'ADMIN',
      p_period_start,
      p_period_end,
      p_amount,
      'PEN',
      case when v_reference is null then null else lower(p_payment_method::text) || ':' || v_reference end,
      'payment.manual',
      p_actor_id,
      p_request_id,
      jsonb_strip_nulls(jsonb_build_object('note', v_note))
    ) a;
end;
$$;


-- SUSPEND / REACTIVATE / CANCEL / EXPIRE.
create or replace function admin.update_subscription_status(
  p_actor_id uuid,
  p_subscription_id uuid,
  p_action text,
  p_reason text,
  p_request_id text
)
returns table (
  subscription_id uuid,
  organization_id uuid,
  status public.subscription_status
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.subscription_status;
begin
  perform private.assert_platform_admin(p_actor_id);

  v_target := case p_action
    when 'SUSPEND' then 'SUSPENDED'
    when 'REACTIVATE' then 'ACTIVE'
    when 'CANCEL' then 'CANCELED'
    when 'EXPIRE' then 'EXPIRED'
  end::public.subscription_status;

  if v_target is null then
    raise exception 'Unknown subscription action';
  end if;

  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'The reason cannot exceed 500 characters';
  end if;

  return query
    select c.subscription_id, s.organization_id, c.status
    from private.change_subscription_status(p_subscription_id, v_target, p_actor_id, p_reason, p_request_id) c
    join public.subscriptions s on s.id = c.subscription_id;
end;
$$;


revoke all on function admin.list_plan_prices(uuid) from public, anon, authenticated, service_role;
revoke all on function admin.list_subscriptions(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function admin.list_payment_events(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function admin.activate_subscription(uuid, uuid, public.organization_plan, public.billing_period, public.payment_method, numeric, timestamptz, timestamptz, text, text, text) from public, anon, authenticated, service_role;
revoke all on function admin.update_subscription_status(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;

grant execute on function admin.list_plan_prices(uuid) to service_role;
grant execute on function admin.list_subscriptions(uuid, uuid) to service_role;
grant execute on function admin.list_payment_events(uuid, uuid, integer) to service_role;
grant execute on function admin.activate_subscription(uuid, uuid, public.organization_plan, public.billing_period, public.payment_method, numeric, timestamptz, timestamptz, text, text, text) to service_role;
grant execute on function admin.update_subscription_status(uuid, uuid, text, text, text) to service_role;


-- ============================================================
-- ROW LEVEL SECURITY AND PRIVILEGES
-- ============================================================

alter table public.subscriptions enable row level security;
alter table public.payment_events enable row level security;

create policy "Members can view their organization subscriptions"
on public.subscriptions
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);

revoke all on table public.subscriptions, public.payment_events
from public, anon, authenticated, service_role;

-- Members read their subscription (Settings > Plan); nobody writes through the Data API.
grant select on table public.subscriptions to authenticated;

-- OAuth callback (service role): organization_entitlements joins subscription -> price -> plan.
grant select on table public.subscriptions to service_role;
grant select on table public.plan_prices to service_role;
