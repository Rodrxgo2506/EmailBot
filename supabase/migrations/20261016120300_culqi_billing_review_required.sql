-- ============================================================
-- EmailBot - Commercial V1 phase 2 (Culqi SANDBOX): checkouts that need review
--
-- The worker classifies every Culqi charge: PAID (confirmed sale, activates),
-- DECLINED (confirmed decline: FAILED + Culqi cancellation), REJECTED (not
-- this checkout's charge / price) or UNCONFIRMED (neither). An UNCONFIRMED
-- checkout is reconciled periodically; after CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS
-- it becomes REVIEW_REQUIRED:
--   * it no longer blocks a new checkout (billing_subscriptions_one_pending
--     only covers PENDING);
--   * nothing is cancelled at Culqi and nothing is activated automatically
--     by this status; the checkout keeps its traceability (last charge,
--     outcome, decline code, last reconciliation);
--   * a later verified charge can still resolve it: a confirmed decline ends
--     FAILED (REVIEW_REQUIRED -> FAILED), a confirmed sale is activated ONLY
--     when nothing changed since that checkout began (no later live checkout,
--     the organization's subscription untouched since then). Otherwise the
--     activation returns CONFLICT and nothing changes: a person decides.
--   * a new checkout's activation does not supersede (cancel) a
--     REVIEW_REQUIRED checkout.
-- ============================================================


-- ============================================================
-- Traceability of the reconciliation
-- ============================================================

alter table public.billing_subscriptions
  add column review_required_at timestamptz,
  add column last_reconciled_at timestamptz,
  add column last_charge_id text,
  add column last_outcome_type text,
  add column last_outcome_code text,
  add column last_decline_code text;

comment on column public.billing_subscriptions.review_required_at is
  'When the checkout became REVIEW_REQUIRED (kept afterwards for audit).';
comment on column public.billing_subscriptions.last_reconciled_at is
  'Last time the worker re-read this Culqi subscription for a charge that was neither confirmed nor declined.';
comment on column public.billing_subscriptions.last_charge_id is
  'Last Culqi charge of this checkout that could not be confirmed nor declined (with its outcome below).';

alter table public.billing_subscriptions
  add constraint billing_subscriptions_last_charge_id
    check (last_charge_id is null or last_charge_id like 'chr_' || environment::text || '_%'),
  add constraint billing_subscriptions_last_outcome_length
    check (
      (last_outcome_type is null or char_length(last_outcome_type) <= 100)
      and (last_outcome_code is null or char_length(last_outcome_code) <= 100)
      and (last_decline_code is null or char_length(last_decline_code) <= 100)
    ),
  add constraint billing_subscriptions_review_required_at
    check (status <> 'REVIEW_REQUIRED' or review_required_at is not null);

-- The periodic job reads the REVIEW_REQUIRED checkouts that are still within their review window.
create index billing_subscriptions_review_idx
  on public.billing_subscriptions(created_at)
  where status = 'REVIEW_REQUIRED';


-- ============================================================
-- Transitions (ACTIVE only through a verified charge, as before)
--   PENDING         -> FAILED, CANCELED, EXPIRED, REVIEW_REQUIRED
--   REVIEW_REQUIRED -> FAILED, CANCELED, EXPIRED   (ACTIVE through activation)
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
    when 'PENDING' then p_to in ('FAILED', 'CANCELED', 'EXPIRED', 'REVIEW_REQUIRED')
    when 'REVIEW_REQUIRED' then p_to in ('FAILED', 'CANCELED', 'EXPIRED')
    when 'FAILED' then p_to in ('CANCELED', 'EXPIRED')
    when 'ACTIVE' then p_to in ('PAST_DUE', 'CANCELED', 'EXPIRED')
    when 'PAST_DUE' then p_to in ('CANCELED', 'EXPIRED')
    else false
  end;
$$;

revoke all on function private.billing_transition_allowed(public.billing_subscription_status, public.billing_subscription_status)
from public, anon, authenticated, service_role;


-- Same as 20261007130000, but REVIEW_REQUIRED is only reached through
-- public.billing_mark_culqi_review_required (it records why).
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

  if p_status = 'REVIEW_REQUIRED' then
    raise exception 'REVIEW_REQUIRED is only set through billing_mark_culqi_review_required';
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

revoke all on function public.billing_set_culqi_status(uuid, public.billing_subscription_status, smallint, text, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_set_culqi_status(uuid, public.billing_subscription_status, smallint, text, text, text, text)
to service_role;


-- ============================================================
-- PENDING -> REVIEW_REQUIRED (the worker, after the review delay).
-- Returns CHANGED, UNCHANGED (already in review) or IGNORED (not PENDING:
-- resolved meanwhile). Never cancels anything, never touches access.
-- ============================================================

create or replace function public.billing_mark_culqi_review_required(
  p_billing_subscription_id uuid,
  p_review_code text,
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
  if p_review_code is null or p_review_code !~ '^[A-Z0-9_]{1,100}$' then
    raise exception 'A review code is required';
  end if;

  select b.id, b.organization_id, b.status, b.external_subscription_id, b.last_charge_id, b.last_outcome_type, b.last_outcome_code, b.last_decline_code
  into v_row
  from public.billing_subscriptions b
  where b.id = p_billing_subscription_id
  for update;

  if v_row.id is null then
    raise exception 'Billing subscription not found';
  end if;

  if v_row.status = 'REVIEW_REQUIRED' then
    return 'UNCHANGED';
  end if;

  if v_row.status <> 'PENDING' then
    return 'IGNORED';
  end if;

  update public.billing_subscriptions b
  set status = 'REVIEW_REQUIRED',
      review_required_at = now(),
      failure_code = p_review_code,
      failure_message = null,
      last_event_at = now()
  where b.id = v_row.id;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, organization_id, metadata, request_id)
  values (
    null,
    'billing.subscription.review_required',
    'billing_subscription',
    v_row.id,
    v_row.organization_id,
    jsonb_strip_nulls(jsonb_build_object(
      'provider', 'CULQI',
      'previousStatus', v_row.status,
      'reviewCode', p_review_code,
      'externalSubscriptionId', v_row.external_subscription_id,
      'lastChargeId', v_row.last_charge_id,
      'lastOutcomeType', v_row.last_outcome_type,
      'lastOutcomeCode', v_row.last_outcome_code,
      'lastDeclineCode', v_row.last_decline_code
    )),
    left(p_request_id, 200)
  );

  return 'CHANGED';
end;
$$;

comment on function public.billing_mark_culqi_review_required(uuid, text, text) is
  'PENDING checkout whose charge could not be confirmed nor declined in time -> REVIEW_REQUIRED (stops blocking new checkouts; nothing cancelled). service_role only.';

revoke all on function public.billing_mark_culqi_review_required(uuid, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_mark_culqi_review_required(uuid, text, text)
to service_role;


-- ============================================================
-- Activation (same as 20261007140000) + REVIEW_REQUIRED guard:
--   CONFLICT  the checkout is REVIEW_REQUIRED and the organization moved on
--             since it began (a later live checkout, or its subscription
--             changed): nothing is applied, a person decides.
-- REVIEW_REQUIRED checkouts are not superseded by another activation.
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

  -- A checkout under review is activated only if nothing changed since it began.
  if v_row.status = 'REVIEW_REQUIRED' and (
    exists (
      select 1 from public.billing_subscriptions b
      where b.organization_id = v_row.organization_id
        and b.id <> v_row.id
        and b.created_at > v_row.created_at
        and b.status in ('PENDING', 'ACTIVE', 'PAST_DUE', 'REVIEW_REQUIRED')
    )
    or exists (
      select 1 from public.subscriptions s
      where s.organization_id = v_row.organization_id
        and s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')
        and s.updated_at > v_row.created_at
    )
  ) then
    return query select 'CONFLICT'::text, v_row.subscription_id, v_superseded;
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
      'period', p_current_period,
      'fromReview', case when v_row.status = 'REVIEW_REQUIRED' then true end
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

  -- Upgrade: every other live or failed Culqi subscription of the organization stops (cancelled at Culqi by the
  -- worker). A REVIEW_REQUIRED checkout is not touched: it is never cancelled automatically.
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
  'Applies ONE verified Culqi charge (charge id = idempotency key) through private.activate_subscription (origin CULQI); CONFLICT for a REVIEW_REQUIRED checkout the organization moved on from. service_role only.';

revoke all on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text)
from public, anon, authenticated, service_role;

grant execute on function public.billing_activate_culqi_subscription(uuid, text, text, timestamptz, timestamptz, integer, text, smallint, text)
to service_role;
