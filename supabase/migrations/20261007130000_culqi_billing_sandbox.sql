-- ============================================================
-- EmailBot - Commercial V1, phase 2 (SANDBOX): Culqi recurring subscriptions
--
-- Limited to Culqi's integration environment: the API and the worker refuse
-- live keys (sk_live_ / pk_live_) in this phase. No real charges.
--
-- Builds on the existing commercial core (20261006130000 / 20261006140000):
--
--   organization -> subscription (ACTIVE, period) -> plan_price -> catalog
--
-- public.subscriptions stays the ONLY source of commercial access, written
-- only by private.activate_subscription() (now also with origin CULQI). This
-- migration adds the provider side:
--
--   billing_provider_plans   EmailBot plan_price <-> Culqi plan id, per
--                            environment (EmailBot stays the source of
--                            prices; the Culqi plan is checked against it).
--   billing_customers        Culqi customer of an organization.
--   billing_subscriptions    one row per Culqi subscription (checkout
--                            attempt): PENDING -> ACTIVE / FAILED, then
--                            PAST_DUE / CANCELED / EXPIRED. Never grants
--                            access by itself.
--   billing_webhook_events   Culqi events received (idempotency: unique
--                            event id). No payload is stored: the worker
--                            re-reads the event from Culqi's API.
--   payment_events           + the provider charge id and the payment
--                            outcome (SUCCEEDED / FAILED).
--
-- Activation (public.billing_activate_culqi_subscription): idempotent per
-- (Culqi subscription, billing period); applied through
-- private.activate_subscription(origin CULQI). A stale event (older period,
-- superseded or canceled subscription) never lowers a plan or shortens a
-- period. An upgrade activates the new plan first, then marks the previous
-- Culqi subscription for cancellation (no proration).
--
-- A failed charge never changes public.subscriptions (no policy yet): the
-- billing row becomes FAILED (initial charge) or PAST_DUE (renewal), and
-- access ends at the paid period end unless a later charge succeeds.
--
-- RLS template:
--   billing_* tables  nobody through the Data API (anon / authenticated:
--                     no privilege, RLS on, no policy). service_role
--                     (API + worker): SELECT / INSERT / UPDATE, no DELETE.
--   Writes that touch subscriptions / payment_events / platform_audit_logs
--   go through the SECURITY DEFINER functions below (service_role only).
-- ============================================================


-- ============================================================
-- ENUMS
-- ============================================================

create type public.billing_environment as enum (
  'test',
  'live'
);

create type public.billing_subscription_status as enum (
  'PENDING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
  'FAILED'
);


-- ============================================================
-- PROVIDER PLANS (EmailBot price -> Culqi plan)
-- ============================================================

create table public.billing_provider_plans (
  id uuid primary key default gen_random_uuid(),

  plan_price_id uuid not null
    references public.plan_prices(id)
    on delete restrict,

  provider text not null default 'CULQI',

  environment public.billing_environment not null,

  external_plan_id text not null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint billing_provider_plans_provider
    check (provider = 'CULQI'),

  constraint billing_provider_plans_external_id
    check (external_plan_id ~ '^pln_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_provider_plans_environment_matches
    check (external_plan_id like 'pln_' || environment::text || '_%'),

  constraint billing_provider_plans_one_per_price
    unique (plan_price_id, provider, environment),

  constraint billing_provider_plans_external_unique
    unique (external_plan_id)
);

comment on table public.billing_provider_plans is
  'Culqi plan of each EmailBot plan price, per environment. Prices are EmailBot''s (plan_prices); the Culqi plan amount is verified against them at checkout.';

create trigger billing_provider_plans_set_updated_at
before update on public.billing_provider_plans
for each row
execute function public.set_updated_at();


-- ============================================================
-- CUSTOMERS
-- ============================================================

create table public.billing_customers (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  provider text not null default 'CULQI',

  environment public.billing_environment not null,

  external_customer_id text not null,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint billing_customers_provider
    check (provider = 'CULQI'),

  constraint billing_customers_external_id
    check (external_customer_id ~ '^cus_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_customers_environment_matches
    check (external_customer_id like 'cus_' || environment::text || '_%'),

  constraint billing_customers_one_per_organization
    unique (organization_id, provider, environment),

  constraint billing_customers_external_unique
    unique (external_customer_id)
);

comment on table public.billing_customers is
  'Culqi customer of an organization (per environment). No card data: Culqi stores it.';

create trigger billing_customers_set_updated_at
before update on public.billing_customers
for each row
execute function public.set_updated_at();


-- ============================================================
-- PROVIDER SUBSCRIPTIONS
-- ============================================================

create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  plan_price_id uuid not null
    references public.plan_prices(id)
    on delete restrict,

  provider text not null default 'CULQI',

  environment public.billing_environment not null,

  status public.billing_subscription_status not null default 'PENDING',

  -- Culqi's own status code: 1 created, 2 trial, 3 active, 4 canceled, 5 queued, 6 expired.
  provider_status smallint,

  external_customer_id text not null,

  external_card_id text,

  external_plan_id text not null,

  external_subscription_id text,

  -- The EmailBot subscription this one paid for (set on activation).
  subscription_id uuid
    references public.subscriptions(id)
    on delete set null,

  current_period integer,

  current_period_start timestamptz,

  current_period_end timestamptz,

  activated_at timestamptz,

  canceled_at timestamptz,

  -- USER (requested), PROVIDER (Culqi, e.g. after failed retries), UPGRADED (replaced by a higher plan).
  cancel_reason text,

  -- UPGRADED: when Culqi confirmed the cancellation of this (old) subscription.
  provider_canceled_at timestamptz,

  failure_code text,

  failure_message text,

  last_event_at timestamptz,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint billing_subscriptions_provider
    check (provider = 'CULQI'),

  constraint billing_subscriptions_provider_status
    check (provider_status is null or provider_status between 1 and 6),

  constraint billing_subscriptions_customer_id
    check (external_customer_id ~ '^cus_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_subscriptions_card_id
    check (external_card_id is null or external_card_id ~ '^crd_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_subscriptions_plan_id
    check (external_plan_id ~ '^pln_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_subscriptions_subscription_id
    check (external_subscription_id is null or external_subscription_id ~ '^sxn_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_subscriptions_environment_matches
    check (
      external_customer_id like 'cus_' || environment::text || '_%'
      and external_plan_id like 'pln_' || environment::text || '_%'
      and (external_subscription_id is null or external_subscription_id like 'sxn_' || environment::text || '_%')
    ),

  constraint billing_subscriptions_cancel_reason
    check (cancel_reason is null or cancel_reason in ('USER', 'PROVIDER', 'UPGRADED')),

  constraint billing_subscriptions_canceled
    check ((status = 'CANCELED') = (canceled_at is not null)),

  constraint billing_subscriptions_failure_length
    check (
      (failure_code is null or char_length(failure_code) <= 100)
      and (failure_message is null or char_length(failure_message) <= 500)
    ),

  constraint billing_subscriptions_period
    check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);

comment on table public.billing_subscriptions is
  'One Culqi subscription (checkout attempt) of an organization. Commercial access comes only from public.subscriptions, written on confirmed payment.';

create unique index billing_subscriptions_external_unique
  on public.billing_subscriptions(external_subscription_id)
  where external_subscription_id is not null;

-- One checkout in progress per organization (no double charge while waiting for Culqi).
create unique index billing_subscriptions_one_pending
  on public.billing_subscriptions(organization_id)
  where status = 'PENDING';

create index billing_subscriptions_organization_idx
  on public.billing_subscriptions(organization_id, created_at desc);

create index billing_subscriptions_cancel_pending_idx
  on public.billing_subscriptions(organization_id)
  where cancel_reason = 'UPGRADED' and provider_canceled_at is null;

create trigger billing_subscriptions_set_updated_at
before update on public.billing_subscriptions
for each row
execute function public.set_updated_at();


-- ============================================================
-- WEBHOOK EVENTS (idempotency)
-- ============================================================

create table public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),

  provider text not null default 'CULQI',

  environment public.billing_environment not null,

  external_event_id text not null,

  -- As read back from Culqi's API (the request body is never trusted).
  event_type text,

  status text not null default 'RECEIVED',

  attempts integer not null default 0,

  last_error text,

  external_subscription_id text,

  external_charge_id text,

  received_at timestamptz not null default now(),

  processed_at timestamptz,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint billing_webhook_events_provider
    check (provider = 'CULQI'),

  constraint billing_webhook_events_external_id
    check (external_event_id ~ '^evt_(test|live)_[A-Za-z0-9]{1,64}$'),

  constraint billing_webhook_events_environment_matches
    check (external_event_id like 'evt_' || environment::text || '_%'),

  constraint billing_webhook_events_type_format
    check (event_type is null or (char_length(event_type) <= 100 and event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')),

  constraint billing_webhook_events_status
    check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),

  constraint billing_webhook_events_processed_at
    check (status in ('RECEIVED', 'FAILED') or processed_at is not null),

  constraint billing_webhook_events_error_length
    check (last_error is null or char_length(last_error) <= 500),

  constraint billing_webhook_events_attempts
    check (attempts >= 0),

  constraint billing_webhook_events_unique
    unique (provider, external_event_id)
);

comment on table public.billing_webhook_events is
  'Culqi webhook events received (unique event id). No payload: the event is re-read from Culqi with the secret key.';

create index billing_webhook_events_subscription_idx
  on public.billing_webhook_events(external_subscription_id)
  where external_subscription_id is not null;

create trigger billing_webhook_events_set_updated_at
before update on public.billing_webhook_events
for each row
execute function public.set_updated_at();


-- ============================================================
-- PAYMENT EVENTS: provider charge id and outcome
-- ============================================================

alter table public.payment_events
  add column external_payment_id text,
  add column payment_status text not null default 'SUCCEEDED',
  add column failure_code text,
  add column failure_message text;

alter table public.payment_events
  add constraint payment_events_payment_status
    check (payment_status in ('SUCCEEDED', 'FAILED')),
  add constraint payment_events_external_payment_id_length
    check (external_payment_id is null or char_length(external_payment_id) between 1 and 200),
  add constraint payment_events_failure_length
    check (
      (failure_code is null or char_length(failure_code) <= 100)
      and (failure_message is null or char_length(failure_message) <= 500)
    );

comment on column public.payment_events.payment_status is
  'SUCCEEDED (manual payments, approved charges) or FAILED (declined provider charge). Independent of status (processing state).';


-- ============================================================
-- PRIVILEGES / RLS
-- ============================================================

alter table public.billing_provider_plans enable row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_webhook_events enable row level security;

revoke all on table
  public.billing_provider_plans,
  public.billing_customers,
  public.billing_subscriptions,
  public.billing_webhook_events
from public, anon, authenticated, service_role;

grant select, insert, update on table
  public.billing_provider_plans,
  public.billing_customers,
  public.billing_subscriptions,
  public.billing_webhook_events
to service_role;


-- ============================================================
-- STATUS TRANSITIONS (provider side)
--
--   PENDING  -> FAILED, CANCELED, EXPIRED      (ACTIVE only through activation)
--   FAILED   -> CANCELED, EXPIRED              (ACTIVE through activation: a retried charge)
--   ACTIVE   -> PAST_DUE, CANCELED, EXPIRED
--   PAST_DUE -> CANCELED, EXPIRED              (ACTIVE through activation)
--   CANCELED, EXPIRED: terminal (late events are ignored)
-- ============================================================

create or replace function private.billing_transition_allowed(
  p_from public.billing_subscription_status,
  p_to public.billing_subscription_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'PENDING' then p_to in ('FAILED', 'CANCELED', 'EXPIRED')
    when 'FAILED' then p_to in ('CANCELED', 'EXPIRED')
    when 'ACTIVE' then p_to in ('PAST_DUE', 'CANCELED', 'EXPIRED')
    when 'PAST_DUE' then p_to in ('CANCELED', 'EXPIRED')
    else false
  end;
$$;

revoke all on function private.billing_transition_allowed(public.billing_subscription_status, public.billing_subscription_status)
from public, anon, authenticated, service_role;


-- Changes the provider-side status (never public.subscriptions): failed
-- initial charge, failed renewal, cancellation, expiry. Returns CHANGED,
-- UNCHANGED (already there) or IGNORED (not allowed: e.g. a late event for a
-- terminal subscription). Audited when it changes.
create or replace function public.billing_set_culqi_status(
  p_billing_subscription_id uuid,
  p_status public.billing_subscription_status,
  p_provider_status smallint,
  p_cancel_reason text,
  p_failure_code text,
  p_failure_message text,
  p_request_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if p_status = 'ACTIVE' or p_status = 'PENDING' then
    raise exception 'ACTIVE is only reached through a confirmed payment';
  end if;

  select b.id, b.organization_id, b.status, b.external_subscription_id
  into v_row
  from public.billing_subscriptions b
  where b.id = p_billing_subscription_id
  for update;

  if v_row.id is null then
    raise exception 'Billing subscription not found';
  end if;

  if v_row.status = p_status then
    update public.billing_subscriptions b
    set provider_status = coalesce(p_provider_status, b.provider_status),
        last_event_at = now()
    where b.id = v_row.id;
    return 'UNCHANGED';
  end if;

  if not private.billing_transition_allowed(v_row.status, p_status) then
    return 'IGNORED';
  end if;

  update public.billing_subscriptions b
  set status = p_status,
      provider_status = coalesce(p_provider_status, b.provider_status),
      canceled_at = case when p_status = 'CANCELED' then now() else null end,
      cancel_reason = case when p_status = 'CANCELED' then coalesce(p_cancel_reason, 'PROVIDER') else null end,
      failure_code = case when p_status in ('FAILED', 'PAST_DUE') then left(p_failure_code, 100) else b.failure_code end,
      failure_message = case when p_status in ('FAILED', 'PAST_DUE') then left(p_failure_message, 500) else b.failure_message end,
      last_event_at = now()
  where b.id = v_row.id;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, organization_id, metadata, request_id)
  values (
    null,
    'billing.subscription.' || lower(p_status::text),
    'billing_subscription',
    v_row.id,
    v_row.organization_id,
    jsonb_strip_nulls(jsonb_build_object(
      'provider', 'CULQI',
      'previousStatus', v_row.status,
      'status', p_status,
      'providerStatus', p_provider_status,
      'cancelReason', case when p_status = 'CANCELED' then coalesce(p_cancel_reason, 'PROVIDER') end,
      'failureCode', left(p_failure_code, 100),
      'externalSubscriptionId', v_row.external_subscription_id
    )),
    left(p_request_id, 200)
  );

  return 'CHANGED';
end;
$$;

comment on function public.billing_set_culqi_status(uuid, public.billing_subscription_status, smallint, text, text, text, text) is
  'Provider-side status of a Culqi subscription (FAILED / PAST_DUE / CANCELED / EXPIRED). Never changes commercial access. service_role only.';

revoke all on function public.billing_set_culqi_status(uuid, public.billing_subscription_status, smallint, text, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_set_culqi_status(uuid, public.billing_subscription_status, smallint, text, text, text, text)
to service_role;


-- ============================================================
-- CONFIRMED PAYMENT -> ACTIVATION
--
-- p_activation_key identifies (Culqi subscription, billing period): the same
-- period confirmed by a webhook and by a reconciliation is applied once
-- (payment_events.external_event_id). Outcomes:
--   ACTIVATED / RENEWED / PLAN_CHANGED  applied (private.activate_subscription)
--   DUPLICATE        this period was already applied
--   ALREADY_COVERED  the EmailBot period already reaches this end (late /
--                    out-of-order confirmation): nothing shortened
--   IGNORED          the Culqi subscription is CANCELED / EXPIRED (stale)
-- On a plan change, the organization's other live Culqi subscriptions are
-- marked CANCELED (UPGRADED) and returned so the caller cancels them at Culqi.
-- ============================================================

create or replace function public.billing_activate_culqi_subscription(
  p_billing_subscription_id uuid,
  p_activation_key text,
  p_event_type text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_current_period integer,
  p_external_charge_id text,
  p_provider_status smallint,
  p_request_id text
)
returns table (
  outcome text,
  subscription_id uuid,
  superseded_external_ids text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_price record;
  v_open record;
  v_result record;
  v_superseded text[] := '{}';
begin
  if p_activation_key is null or char_length(p_activation_key) not between 1 and 200 then
    raise exception 'An activation key is required';
  end if;

  select b.*
  into v_row
  from public.billing_subscriptions b
  where b.id = p_billing_subscription_id
  for update;

  if v_row.id is null then
    raise exception 'Billing subscription not found';
  end if;

  if v_row.external_subscription_id is null then
    raise exception 'The Culqi subscription was not created';
  end if;

  if v_row.status in ('CANCELED', 'EXPIRED') then
    return query select 'IGNORED'::text, v_row.subscription_id, v_superseded;
    return;
  end if;

  select p.id, p.amount, p.currency into v_price
  from public.plan_prices p
  where p.id = v_row.plan_price_id;

  -- Late / out-of-order confirmation: never shorten the period nor lower the plan.
  select s.id, s.plan_price_id, s.current_period_end, s.external_subscription_id
  into v_open
  from public.subscriptions s
  where s.organization_id = v_row.organization_id
    and s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
  for update;

  if v_open.id is not null
     and v_open.external_subscription_id = v_row.external_subscription_id
     and v_open.current_period_end >= p_period_end then
    if not exists (select 1 from public.payment_events e where e.external_event_id = p_activation_key) then
      update public.billing_subscriptions b
      set status = 'ACTIVE',
          provider_status = coalesce(p_provider_status, b.provider_status),
          subscription_id = v_open.id,
          activated_at = coalesce(b.activated_at, now()),
          failure_code = null,
          failure_message = null,
          last_event_at = now()
      where b.id = v_row.id;
      return query select 'ALREADY_COVERED'::text, v_open.id, v_superseded;
      return;
    end if;
  end if;

  select a.subscription_id, a.outcome
  into v_result
  from private.activate_subscription(
    v_row.organization_id,
    v_row.plan_price_id,
    'CULQI',
    'CULQI',
    p_period_start,
    p_period_end,
    v_price.amount,
    v_price.currency,
    p_activation_key,
    coalesce(p_event_type, 'subscription.charge.succeeded'),
    null,
    p_request_id,
    jsonb_strip_nulls(jsonb_build_object(
      'billingSubscriptionId', v_row.id,
      'externalSubscriptionId', v_row.external_subscription_id,
      'externalChargeId', p_external_charge_id,
      'environment', v_row.environment,
      'period', p_current_period
    ))
  ) a;

  if v_result.outcome <> 'DUPLICATE' then
    update public.subscriptions s
    set external_subscription_id = v_row.external_subscription_id
    where s.id = v_result.subscription_id
      and s.external_subscription_id is distinct from v_row.external_subscription_id;

    update public.payment_events e
    set external_payment_id = left(p_external_charge_id, 200)
    where e.external_event_id = p_activation_key
      and p_external_charge_id is not null;
  end if;

  update public.billing_subscriptions b
  set status = 'ACTIVE',
      provider_status = coalesce(p_provider_status, b.provider_status),
      subscription_id = v_result.subscription_id,
      current_period = coalesce(p_current_period, b.current_period),
      current_period_start = p_period_start,
      current_period_end = p_period_end,
      activated_at = coalesce(b.activated_at, now()),
      failure_code = null,
      failure_message = null,
      last_event_at = now()
  where b.id = v_row.id;

  -- Upgrade: the organization's other live Culqi subscriptions stop being renewed.
  with superseded as (
    update public.billing_subscriptions b
    set status = 'CANCELED',
        canceled_at = now(),
        cancel_reason = 'UPGRADED',
        last_event_at = now()
    where b.organization_id = v_row.organization_id
      and b.id <> v_row.id
      and b.status in ('ACTIVE', 'PAST_DUE')
    returning b.id, b.external_subscription_id
  )
  select coalesce(array_agg(s.external_subscription_id) filter (where s.external_subscription_id is not null), '{}')
  into v_superseded
  from superseded s;

  if cardinality(v_superseded) > 0 then
    insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, organization_id, metadata, request_id)
    values (
      null,
      'billing.subscription.superseded',
      'billing_subscription',
      v_row.id,
      v_row.organization_id,
      jsonb_build_object('provider', 'CULQI', 'replacedExternalSubscriptionIds', to_jsonb(v_superseded)),
      left(p_request_id, 200)
    );
  end if;

  return query select v_result.outcome, v_result.subscription_id, v_superseded;
end;
$$;

comment on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text) is
  'Applies a confirmed Culqi payment through private.activate_subscription (origin CULQI). Idempotent per activation key. service_role only.';

revoke all on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text)
to service_role;


-- ============================================================
-- DECLINED CHARGE
--
-- Recorded once per Culqi event (payment_events, payment_status FAILED).
-- The billing row becomes FAILED (initial charge) or PAST_DUE (renewal);
-- public.subscriptions is not changed. Returns RECORDED or DUPLICATE.
-- ============================================================

create or replace function public.billing_record_culqi_charge_failure(
  p_billing_subscription_id uuid,
  p_external_event_id text,
  p_event_type text,
  p_external_charge_id text,
  p_failure_code text,
  p_failure_message text,
  p_provider_status smallint,
  p_request_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_price record;
  v_event_id uuid;
begin
  select b.id, b.organization_id, b.status, b.plan_price_id, b.subscription_id, b.external_subscription_id
  into v_row
  from public.billing_subscriptions b
  where b.id = p_billing_subscription_id
  for update;

  if v_row.id is null then
    raise exception 'Billing subscription not found';
  end if;

  select p.amount, p.currency into v_price from public.plan_prices p where p.id = v_row.plan_price_id;

  insert into public.payment_events (
    external_event_id, organization_id, subscription_id, event_type, payment_method, amount, currency,
    status, processed_at, payment_status, external_payment_id, failure_code, failure_message, metadata
  )
  values (
    p_external_event_id,
    v_row.organization_id,
    v_row.subscription_id,
    coalesce(p_event_type, 'subscription.charge.failed'),
    'CULQI',
    v_price.amount,
    v_price.currency,
    'PROCESSED',
    now(),
    'FAILED',
    left(p_external_charge_id, 200),
    left(p_failure_code, 100),
    left(p_failure_message, 500),
    jsonb_strip_nulls(jsonb_build_object('billingSubscriptionId', v_row.id, 'externalSubscriptionId', v_row.external_subscription_id))
  )
  on conflict (external_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return 'DUPLICATE';
  end if;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, organization_id, metadata, request_id)
  values (
    null,
    'payment.failed',
    'payment_event',
    v_event_id,
    v_row.organization_id,
    jsonb_strip_nulls(jsonb_build_object(
      'paymentMethod', 'CULQI',
      'amount', v_price.amount,
      'currency', v_price.currency,
      'failureCode', left(p_failure_code, 100),
      'externalSubscriptionId', v_row.external_subscription_id
    )),
    left(p_request_id, 200)
  );

  perform public.billing_set_culqi_status(
    v_row.id,
    case when v_row.status in ('ACTIVE', 'PAST_DUE') then 'PAST_DUE'::public.billing_subscription_status else 'FAILED'::public.billing_subscription_status end,
    p_provider_status,
    null,
    p_failure_code,
    p_failure_message,
    p_request_id
  );

  return 'RECORDED';
end;
$$;

comment on function public.billing_record_culqi_charge_failure(uuid, text, text, text, text, text, smallint, text) is
  'Records a declined Culqi charge once (payment_events FAILED); billing row FAILED / PAST_DUE; access unchanged. service_role only.';

revoke all on function public.billing_record_culqi_charge_failure(uuid, text, text, text, text, text, smallint, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_record_culqi_charge_failure(uuid, text, text, text, text, text, smallint, text)
to service_role;
