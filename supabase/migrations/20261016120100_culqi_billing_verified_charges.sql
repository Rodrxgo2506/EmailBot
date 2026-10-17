-- ============================================================
-- EmailBot - Commercial V1 phase 2 (Culqi SANDBOX): verified charges only
--
-- Hardening of 20261007130000_culqi_billing_sandbox after the technical
-- review (no live keys, nothing in production):
--
--   F1  An EmailBot subscription is activated ONLY for a Culqi CHARGE the
--       worker verified server-to-server (GET /v2/charges/{id}: paid,
--       outcome, amount, currency). The charge id IS the idempotency key:
--       public.billing_activate_culqi_subscription requires it (format and
--       environment checked) and payment_events.external_payment_id is
--       unique, so a webhook and a reconciliation of the same charge apply
--       it once. A subscription status or a "subscription created" event
--       can no longer activate anything.
--       A repeated (DUPLICATE) or late (ALREADY_COVERED) charge no longer
--       touches the provider-side status (a newer PAST_DUE is kept).
--   F4  An upgrade also supersedes FAILED Culqi subscriptions of the
--       organization (cancelled at Culqi by the worker), so no forgotten
--       Culqi subscription can charge later.
--   F5  The checkout reserves its PENDING row BEFORE creating anything at
--       Culqi: external_customer_id is filled in afterwards (required once
--       the Culqi subscription exists).
-- ============================================================


-- ============================================================
-- F5: reserve first, then create the Culqi customer
-- ============================================================

alter table public.billing_subscriptions
  alter column external_customer_id drop not null;

alter table public.billing_subscriptions
  add constraint billing_subscriptions_customer_before_subscription
    check (external_subscription_id is null or external_customer_id is not null);


-- ============================================================
-- F1: one payment per Culqi charge
-- ============================================================

create unique index payment_events_external_payment_unique
  on public.payment_events(external_payment_id)
  where external_payment_id is not null;


-- ============================================================
-- F1: activation requires a verified charge id
--
-- Same signature as before. p_activation_key must be the charge id (the
-- worker passes the charge it verified with GET /v2/charges/{id}).
-- Outcomes: ACTIVATED / RENEWED / PLAN_CHANGED (applied), DUPLICATE (this
-- charge was applied), ALREADY_COVERED (an older charge: nothing shortened,
-- nothing recorded), IGNORED (the Culqi subscription is CANCELED / EXPIRED).
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
  if p_external_charge_id is null or p_external_charge_id !~ '^chr_(test|live)_[A-Za-z0-9]{1,64}$' then
    raise exception 'A verified Culqi charge id is required to activate';
  end if;

  if p_activation_key is distinct from p_external_charge_id then
    raise exception 'The activation key must be the Culqi charge id';
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

  if p_external_charge_id not like 'chr_' || v_row.environment::text || '_%' then
    raise exception 'The charge belongs to another Culqi environment';
  end if;

  if v_row.status in ('CANCELED', 'EXPIRED') then
    return query select 'IGNORED'::text, v_row.subscription_id, v_superseded;
    return;
  end if;

  -- The same charge again (webhook + reconciliation, retries): nothing changes.
  if exists (
    select 1 from public.payment_events e
    where e.external_event_id = p_external_charge_id or e.external_payment_id = p_external_charge_id
  ) then
    return query
      select 'DUPLICATE'::text, coalesce(
        (select e.subscription_id from public.payment_events e where e.external_event_id = p_external_charge_id),
        v_row.subscription_id
      ), v_superseded;
    return;
  end if;

  select p.id, p.amount, p.currency into v_price
  from public.plan_prices p
  where p.id = v_row.plan_price_id;

  -- An older charge after a newer one: never shorten the period nor lower the plan.
  select s.id, s.current_period_end, s.external_subscription_id
  into v_open
  from public.subscriptions s
  where s.organization_id = v_row.organization_id
    and s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
  for update;

  if v_open.id is not null
     and v_open.external_subscription_id = v_row.external_subscription_id
     and v_open.current_period_end >= p_period_end then
    return query select 'ALREADY_COVERED'::text, v_open.id, v_superseded;
    return;
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
    p_external_charge_id,
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

  if v_result.outcome = 'DUPLICATE' then
    return query select 'DUPLICATE'::text, v_result.subscription_id, v_superseded;
    return;
  end if;

  update public.subscriptions s
  set external_subscription_id = v_row.external_subscription_id
  where s.id = v_result.subscription_id
    and s.external_subscription_id is distinct from v_row.external_subscription_id;

  update public.payment_events e
  set external_payment_id = p_external_charge_id
  where e.external_event_id = p_external_charge_id;

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

  -- Upgrade: every other live or failed Culqi subscription of the organization stops (cancelled at Culqi by the worker).
  with superseded as (
    update public.billing_subscriptions b
    set status = 'CANCELED',
        canceled_at = now(),
        cancel_reason = 'UPGRADED',
        last_event_at = now()
    where b.organization_id = v_row.organization_id
      and b.id <> v_row.id
      and b.status in ('ACTIVE', 'PAST_DUE', 'FAILED')
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
  'Applies ONE verified Culqi charge (charge id = idempotency key) through private.activate_subscription (origin CULQI). service_role only.';

revoke all on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text)
to service_role;


-- ============================================================
-- Declined charge: the charge id is also unique here (a charge already
-- recorded under another key is a DUPLICATE, never an error).
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

  if exists (
    select 1 from public.payment_events e
    where e.external_event_id = p_external_event_id
       or (p_external_charge_id is not null and e.external_payment_id = p_external_charge_id)
  ) then
    return 'DUPLICATE';
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

revoke all on function public.billing_record_culqi_charge_failure(uuid, text, text, text, text, text, smallint, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_record_culqi_charge_failure(uuid, text, text, text, text, text, smallint, text)
to service_role;
