-- ============================================================
-- EmailBot - Commercial V1, phase 1.2: subscription enforcement
--
-- Closes the two risks left by phase 1.1 before Culqi:
--   1. the worker and the customer portal looked only at
--      organizations.status: now they also require commercial access;
--   2. private.expire_due_subscriptions() was not scheduled: the worker
--      calls public.expire_due_subscriptions() every 5 minutes.
--
-- Commercial access (ONE definition, public.organization_access):
--   SUBSCRIPTION  status ACTIVE and current_period_start <= now() < current_period_end
--   LEGACY        never had a subscription and has a pre-subscription plan
--                 (unchanged from phase 1.1; FREE is entitled as BASIC)
--   NONE          anything else (PAST_DUE, SUSPENDED, CANCELED, EXPIRED, a
--                 period that has not started or has ended, no subscription)
-- organization_entitlements (API), the worker (service role) and the portal
-- (private.portal_session_scope, portal.create_session) all use it.
--
-- Also:
--   - an early renewal of a subscription that has access now keeps the
--     access without a gap (its period continues from the renewal moment);
--   - private.expire_due_subscriptions() is safe to run concurrently
--     (FOR UPDATE SKIP LOCKED) and idempotent.
-- Nothing is deleted: mailboxes, emails, rules, bots, customers, Access IDs
-- and portal sessions are kept; only processing and portal use stop.
-- ============================================================


-- ============================================================
-- COMMERCIAL ACCESS (single definition)
-- ============================================================

create or replace function public.organization_access(
  p_organization_ids uuid[]
)
returns table (
  organization_id uuid,
  plan public.organization_plan,
  effective_plan public.organization_plan,
  access text,
  subscription_status public.subscription_status
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    o.id,
    o.plan,
    case
      when l.status = 'ACTIVE' and l.current_period_start <= now() and l.current_period_end > now() then l.code
      when l.status is null and o.plan is not null
        then (case when o.plan = 'FREE' then 'BASIC' else o.plan end)::public.organization_plan
    end,
    case
      when l.status = 'ACTIVE' and l.current_period_start <= now() and l.current_period_end > now() then 'SUBSCRIPTION'
      when l.status is null and o.plan is not null then 'LEGACY'
      else 'NONE'
    end,
    l.status
  from public.organizations o
  left join lateral (
    -- The open subscription, or else the most recent one (history).
    select s.status, s.current_period_start, s.current_period_end, c.code
    from public.subscriptions s
    join public.plan_prices p on p.id = s.plan_price_id
    join public.plan_catalog c on c.id = p.plan_id
    where s.organization_id = o.id
    order by (s.status in ('ACTIVE', 'PAST_DUE', 'SUSPENDED')) desc, s.created_at desc
    limit 1
  ) l on true
  where o.id = any(p_organization_ids);
$$;

comment on function public.organization_access(uuid[]) is
  'Commercial access of organizations: SUBSCRIPTION (ACTIVE, period started and not ended), LEGACY (never subscribed, pre-subscription plan) or NONE. SECURITY INVOKER (RLS applies).';

revoke all on function public.organization_access(uuid[])
from public, anon, authenticated, service_role;

-- authenticated: called by organization_entitlements (invoker); service_role: the worker.
grant execute on function public.organization_access(uuid[])
to authenticated, service_role;


-- Same signature and columns as phase 1.1; the decision now comes from organization_access.
create or replace function public.organization_entitlements(
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
  select a.plan, a.effective_plan, a.access, a.subscription_status, e.key, e.kind, e.limit_value, e.enabled
  from public.organization_access(array[p_organization_id]) a
  left join public.plan_catalog c on c.code = a.effective_plan
  left join public.plan_entitlements e on e.plan_id = c.id
  order by e.key;
$$;


-- ============================================================
-- CUSTOMER PORTAL
--
-- The portal is usable when the organization has commercial access AND
-- (LEGACY, unchanged) or (an ACTIVE subscription whose plan includes PORTAL).
-- Checked by private.portal_session_scope (every portal data function, the
-- session validation and the portal sync scope) and by portal.create_session
-- (login). Access IDs and sessions are kept: they work again as soon as the
-- organization has access.
-- ============================================================

create or replace function private.portal_access_allowed(
  p_organization_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_entitlements(p_organization_id) e
    where e.access = 'LEGACY'
       or (e.access = 'SUBSCRIPTION' and e.key = 'PORTAL' and e.enabled)
  );
$$;

revoke all on function private.portal_access_allowed(uuid)
from public, anon, authenticated, service_role;


create or replace function private.portal_session_scope(
  p_token_hash text
)
returns table (
  session_id uuid,
  organization_id uuid,
  customer_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.organization_id, s.customer_id
  from public.customer_sessions s
  join public.customer_access_credentials cr
    on cr.organization_id = s.organization_id
   and cr.customer_id = s.customer_id
   and cr.id = s.credential_id
  join public.customers c
    on c.organization_id = s.organization_id
   and c.id = s.customer_id
  join public.organizations o
    on o.id = s.organization_id
  where p_token_hash ~ '^[0-9a-f]{64}$'
    and s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.idle_expires_at > now()
    and s.absolute_expires_at > now()
    and cr.status = 'ACTIVE'
    and (cr.expires_at is null or cr.expires_at > now())
    and c.status = 'ACTIVE'
    and o.status = 'ACTIVE'
    and private.portal_access_allowed(o.id);
$$;

revoke all on function private.portal_session_scope(text)
from public, anon, authenticated, service_role;


-- Login: same as 20261004150200_customer_access_functions.sql plus the
-- outcome SUBSCRIPTION_INACTIVE (generic failure for the browser, like the others).
create or replace function portal.create_session(
  p_secret_hash text,
  p_token_hash text,
  p_ip inet,
  p_user_agent text
)
returns table (
  outcome text,
  organization_id uuid,
  customer_id uuid,
  session_id uuid,
  display_name text,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.customer_access_credentials%rowtype;
  v_customer_status public.customer_status;
  v_display_name text;
  v_organization_status public.organization_status;
  v_absolute timestamptz;
  v_idle timestamptz;
  v_session_id uuid;
begin

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid session token hash';
  end if;

  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return query select 'INVALID'::text, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select cr.*
  into v_credential
  from public.customer_access_credentials cr
  where cr.secret_hash = p_secret_hash
  for share;

  if v_credential.id is null then
    return query select 'INVALID'::text, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select c.status, c.display_name
  into v_customer_status, v_display_name
  from public.customers c
  where c.organization_id = v_credential.organization_id
    and c.id = v_credential.customer_id;

  select o.status
  into v_organization_status
  from public.organizations o
  where o.id = v_credential.organization_id;

  if v_credential.status <> 'ACTIVE' then
    return query select 'REVOKED'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_credential.expires_at is not null and v_credential.expires_at <= now() then
    return query select 'EXPIRED'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_organization_status is distinct from 'ACTIVE' then
    return query select 'ORGANIZATION_INACTIVE'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not private.portal_access_allowed(v_credential.organization_id) then
    return query select 'SUBSCRIPTION_INACTIVE'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_customer_status is distinct from 'ACTIVE' then
    return query select 'CUSTOMER_INACTIVE'::text, v_credential.organization_id, v_credential.customer_id, null::uuid, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_absolute := now() + interval '30 days';
  if v_credential.expires_at is not null and v_credential.expires_at < v_absolute then
    v_absolute := v_credential.expires_at;
  end if;
  v_idle := least(now() + interval '7 days', v_absolute);

  insert into public.customer_sessions (
    organization_id,
    customer_id,
    credential_id,
    token_hash,
    idle_expires_at,
    absolute_expires_at,
    ip,
    user_agent
  )
  values (
    v_credential.organization_id,
    v_credential.customer_id,
    v_credential.id,
    p_token_hash,
    v_idle,
    v_absolute,
    p_ip,
    left(p_user_agent, 512)
  )
  returning id into v_session_id;

  return query select 'OK'::text, v_credential.organization_id, v_credential.customer_id, v_session_id, v_display_name, v_idle, v_absolute;

end;
$$;


-- ============================================================
-- CORE: activate / renew / change plan
--
-- Same as 20261006130000_subscriptions.sql, plus: an EARLY renewal of a
-- subscription that has access right now (ACTIVE, period started and not
-- ended) with a period starting in the future keeps the access without a
-- gap: the period continues from now until the new end (the requested
-- start stays in the audit record). Otherwise the period is the requested one.
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
  v_period_start timestamptz;
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

  select s.id, s.status, s.plan_price_id, s.current_period_start, s.current_period_end
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
    -- Early renewal of a subscription with access now: no gap (the period continues from now).
    v_period_start := case
      when v_open.status = 'ACTIVE' and v_open.current_period_start <= now() and v_open.current_period_end > now() and p_period_start > now()
        then now()
      else p_period_start
    end;

    select c.code, p.billing_period into v_from_plan, v_from_period
    from public.plan_prices p
    join public.plan_catalog c on c.id = p.plan_id
    where p.id = v_open.plan_price_id;

    update public.subscriptions s
    set plan_price_id = p_plan_price_id,
        status = 'ACTIVE',
        payment_method = p_payment_method,
        origin = p_origin,
        started_at = least(s.started_at, v_period_start),
        current_period_start = v_period_start,
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
-- EXPIRATION
--
-- Idempotent and safe to run concurrently: each due subscription is locked
-- (FOR UPDATE SKIP LOCKED: a concurrent run skips it) and expired once; an
-- already EXPIRED one is not selected again (no change, no audit record).
-- The period end is exclusive: at exactly current_period_end there is no
-- access any more (organization_access) and the subscription is due.
-- ============================================================

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
    for update skip locked
  loop
    perform private.change_subscription_status(v_id, 'EXPIRED', null, 'period_ended', null, p_now);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.expire_due_subscriptions(timestamptz)
from public, anon, authenticated, service_role;


-- Entry point of the worker's job scheduler (EXPIRE_SUBSCRIPTIONS, every 5
-- minutes). No parameters: it can only expire subscriptions whose period
-- has already ended, at the database's now(). Returns how many expired.
create or replace function public.expire_due_subscriptions()
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.expire_due_subscriptions(now());
$$;

comment on function public.expire_due_subscriptions() is
  'Expires subscriptions whose period ended (scheduled by the worker every 5 minutes). Idempotent. service_role only.';

revoke all on function public.expire_due_subscriptions()
from public, anon, authenticated, service_role;

grant execute on function public.expire_due_subscriptions()
to service_role;
