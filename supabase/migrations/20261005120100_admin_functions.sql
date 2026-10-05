-- ============================================================
-- EmailBot V2 - Phase 6: admin.* functions (platform administration plane)
--
-- Why functions and not column grants for the service role: the service
-- role is shared with the worker and keeps minimal privileges
-- (service-role-privileges.test.ts forbids it to read organization names,
-- bot names, customers or audit_logs). These functions return ONLY the
-- metadata the admin console shows, through explicit column lists.
--
-- Every function:
--   - SECURITY DEFINER (reads across tenants without touching any RLS
--     policy), search_path = '', fully qualified names, no dynamic SQL;
--   - EXECUTE for service_role only (the API, after requirePlatformAdmin);
--     never anon / authenticated, so the browser cannot call them;
--   - receives the acting user (p_actor_id, from the verified JWT in the
--     API) and re-checks it against platform_admins (42501 otherwise);
--   - never returns e-mail bodies, HTML, extracted data, attachments,
--     storage paths, tokens, credentials, Access IDs or session data.
-- Writes (create, update) are atomic with their platform audit record.
--
-- The schema must be exposed to PostgREST (supabase/config.toml locally;
-- production: Dashboard > Data API > Exposed schemas, like portal).
-- ============================================================

create schema if not exists admin;

revoke all on schema admin from public, anon, authenticated;

grant usage on schema admin to service_role;


-- ============================================================
-- IDENTITY
-- ============================================================

create or replace function admin.is_platform_admin(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin(p_user_id);
$$;


-- ============================================================
-- STATS
-- ============================================================

create or replace function admin.platform_stats(
  p_actor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_organizations record;
  v_emails record;
  v_accounts record;
begin
  perform private.assert_platform_admin(p_actor_id);

  select
    count(*) as total,
    count(*) filter (where o.status = 'ACTIVE') as active,
    count(*) filter (where o.status = 'SUSPENDED') as suspended,
    count(*) filter (where o.status = 'CANCELLED') as cancelled
  into v_organizations
  from public.organizations o;

  select
    count(*) as total,
    count(*) filter (where e.processing_status = 'PROCESSED') as processed
  into v_emails
  from public.emails e;

  select
    count(*) as total,
    count(*) filter (where a.status = 'ACTIVE') as active
  into v_accounts
  from public.email_accounts a;

  return jsonb_build_object(
    'totalOrganizations', v_organizations.total,
    'activeOrganizations', v_organizations.active,
    'suspendedOrganizations', v_organizations.suspended,
    'cancelledOrganizations', v_organizations.cancelled,
    'totalMembers', (select count(*) from public.organization_members),
    'totalBots', (select count(*) from public.bots),
    'totalCustomers', (select count(*) from public.customers),
    'totalEmailAccounts', v_accounts.total,
    'activeEmailAccounts', v_accounts.active,
    'totalEmails', v_emails.total,
    'totalProcessedEmails', v_emails.processed,
    'totalDeliveries', (select count(*) from public.email_deliveries d where d.removed_at is null)
  );
end;
$$;


-- ============================================================
-- ORGANIZATIONS
-- ============================================================

-- Page of organizations with their owner and counts. Search: name, slug or
-- owner e-mail (LIKE wildcards escaped). Sort: fixed whitelist, never a
-- column name from the client. Counts are per-row subqueries on indexed
-- organization_id, computed only for the returned page.
create or replace function admin.list_organizations(
  p_actor_id uuid,
  p_search text,
  p_status public.organization_status,
  p_plan public.organization_plan,
  p_sort text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  name text,
  slug text,
  plan public.organization_plan,
  status public.organization_status,
  created_at timestamptz,
  updated_at timestamptz,
  owner_user_id uuid,
  owner_email text,
  owner_name text,
  members_count bigint,
  bots_count bigint,
  customers_count bigint,
  email_accounts_count bigint,
  processed_emails_count bigint,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sort text := coalesce(p_sort, 'created_desc');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_pattern text;
begin
  perform private.assert_platform_admin(p_actor_id);

  if v_sort not in ('created_desc', 'created_asc', 'name_asc', 'name_desc') then
    raise exception 'Invalid sort' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_pattern := '%'
      || replace(replace(replace(lower(trim(p_search)), '\', '\\'), '%', '\%'), '_', '\_')
      || '%';
  end if;

  return query
  with filtered as (
    select
      o.id,
      o.name,
      o.slug,
      o.plan,
      o.status,
      o.created_at,
      o.updated_at,
      ow.user_id as owner_user_id,
      p.email as owner_email,
      p.full_name as owner_name
    from public.organizations o
    left join public.organization_members ow
      on ow.organization_id = o.id
     and ow.role = 'OWNER'
    left join public.profiles p
      on p.id = ow.user_id
    where (p_status is null or o.status = p_status)
      and (p_plan is null or o.plan = p_plan)
      and (
        v_pattern is null
        or lower(o.name) like v_pattern
        or o.slug like v_pattern
        or lower(coalesce(p.email, '')) like v_pattern
      )
  ),
  ranked as (
    select
      f.*,
      row_number() over (
        order by
          case when v_sort = 'created_desc' then f.created_at end desc,
          case when v_sort = 'created_asc' then f.created_at end asc,
          case when v_sort = 'name_asc' then lower(f.name) end asc,
          case when v_sort = 'name_desc' then lower(f.name) end desc,
          f.id
      ) as rn,
      count(*) over () as total
    from filtered f
  )
  select
    r.id,
    r.name,
    r.slug,
    r.plan,
    r.status,
    r.created_at,
    r.updated_at,
    r.owner_user_id,
    r.owner_email,
    r.owner_name,
    (select count(*) from public.organization_members m where m.organization_id = r.id),
    (select count(*) from public.bots b where b.organization_id = r.id),
    (select count(*) from public.customers c where c.organization_id = r.id),
    (select count(*) from public.email_accounts a where a.organization_id = r.id),
    (select count(*) from public.emails e where e.organization_id = r.id and e.processing_status = 'PROCESSED'),
    r.total
  from ranked r
  where r.rn > v_offset
    and r.rn <= v_offset + v_limit
  order by r.rn;
end;
$$;


create or replace function admin.get_organization(
  p_actor_id uuid,
  p_organization_id uuid
)
returns table (
  id uuid,
  name text,
  slug text,
  plan public.organization_plan,
  status public.organization_status,
  created_at timestamptz,
  updated_at timestamptz,
  owner_user_id uuid,
  owner_email text,
  owner_name text,
  members_count bigint,
  bots_count bigint,
  customers_count bigint,
  email_accounts_count bigint,
  rules_count bigint,
  emails_count bigint,
  processed_emails_count bigint,
  deliveries_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  select
    o.id,
    o.name,
    o.slug,
    o.plan,
    o.status,
    o.created_at,
    o.updated_at,
    ow.user_id,
    p.email,
    p.full_name,
    (select count(*) from public.organization_members m where m.organization_id = o.id),
    (select count(*) from public.bots b where b.organization_id = o.id),
    (select count(*) from public.customers c where c.organization_id = o.id),
    (select count(*) from public.email_accounts a where a.organization_id = o.id),
    (select count(*) from public.email_rules r where r.organization_id = o.id),
    (select count(*) from public.emails e where e.organization_id = o.id),
    (select count(*) from public.emails e where e.organization_id = o.id and e.processing_status = 'PROCESSED'),
    (select count(*) from public.email_deliveries d where d.organization_id = o.id and d.removed_at is null)
  from public.organizations o
  left join public.organization_members ow
    on ow.organization_id = o.id
   and ow.role = 'OWNER'
  left join public.profiles p
    on p.id = ow.user_id
  where o.id = p_organization_id;
end;
$$;


-- Creates an organization with its OWNER in one transaction (settings are
-- created by the existing organizations trigger) and audits it. The owner
-- must be an existing user; the API resolves it from a confirmed e-mail.
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
  values (v_name, v_slug, coalesce(p_plan, 'FREE'))
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
    jsonb_build_object('plan', coalesce(p_plan, 'FREE'), 'ownerUserId', p_owner_user_id),
    left(p_request_id, 200)
  );

  return v_organization_id;
end;
$$;


-- Plan and/or status (NULL = unchanged). Nothing is deleted: SUSPENDED and
-- CANCELLED stop the API, worker and portal of the organization through the
-- existing organizations.status checks; ACTIVE restores them. One audit
-- record per changed field; no record when nothing changes.
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
-- ORGANIZATION METADATA (read only)
-- ============================================================

create or replace function admin.list_members(
  p_actor_id uuid,
  p_organization_id uuid
)
returns table (
  user_id uuid,
  email text,
  full_name text,
  role public.organization_role,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  select m.user_id, p.email, p.full_name, m.role, m.created_at
  from public.organization_members m
  join public.profiles p on p.id = m.user_id
  where m.organization_id = p_organization_id
  order by
    case m.role when 'OWNER' then 0 when 'ADMIN' then 1 when 'OPERATOR' then 2 else 3 end,
    m.created_at,
    m.user_id;
end;
$$;


create or replace function admin.list_bots(
  p_actor_id uuid,
  p_organization_id uuid
)
returns table (
  id uuid,
  name text,
  slug text,
  status public.bot_status,
  rules_count bigint,
  active_customers_count bigint,
  deliveries_count bigint,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  select
    b.id,
    b.name,
    b.slug,
    b.status,
    (select count(*) from public.email_rules r where r.organization_id = b.organization_id and r.bot_id = b.id),
    (select count(*) from public.bot_customer_assignments a
      where a.organization_id = b.organization_id and a.bot_id = b.id and a.active),
    (select count(*) from public.email_deliveries d
      where d.organization_id = b.organization_id and d.bot_id = b.id and d.removed_at is null),
    b.created_at
  from public.bots b
  where b.organization_id = p_organization_id
  order by lower(b.name), b.id;
end;
$$;


-- Name, status, assigned bots and delivery count only: no identifiers,
-- external references, notes, Access IDs or sessions.
create or replace function admin.list_customers(
  p_actor_id uuid,
  p_organization_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  display_name text,
  status public.customer_status,
  bot_names text[],
  deliveries_count bigint,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  with ranked as (
    select
      c.id,
      c.organization_id,
      c.display_name,
      c.status,
      c.created_at,
      row_number() over (order by c.created_at desc, c.id) as rn,
      count(*) over () as total
    from public.customers c
    where c.organization_id = p_organization_id
  )
  select
    r.id,
    r.display_name,
    r.status,
    coalesce(
      (select array_agg(b.name order by lower(b.name))
       from public.bot_customer_assignments a
       join public.bots b on b.organization_id = a.organization_id and b.id = a.bot_id
       where a.organization_id = r.organization_id and a.customer_id = r.id and a.active),
      '{}'::text[]
    ),
    (select count(*) from public.email_deliveries d
      where d.organization_id = r.organization_id and d.customer_id = r.id and d.removed_at is null),
    r.created_at,
    r.total
  from ranked r
  where r.rn > v_offset
    and r.rn <= v_offset + v_limit
  order by r.rn;
end;
$$;


-- Connection state only: never tokens, credentials or provider metadata.
create or replace function admin.list_email_accounts(
  p_actor_id uuid,
  p_organization_id uuid
)
returns table (
  id uuid,
  provider public.email_provider,
  email_address text,
  status public.email_account_status,
  last_synced_at timestamptz,
  last_error_code text,
  watch_expires_at timestamptz,
  watch_error_code text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  select
    a.id,
    a.provider,
    a.email_address,
    a.status,
    a.last_synced_at,
    a.last_error_code,
    a.watch_expires_at,
    a.watch_error_code,
    a.created_at
  from public.email_accounts a
  where a.organization_id = p_organization_id
  order by a.created_at, a.id;
end;
$$;


-- ============================================================
-- ACTIVITY (organization audit_logs, aggregated) and PLATFORM AUDIT
--
-- Offset pages of p_limit rows; one extra row tells whether more exist
-- (no total count over the whole log). Activity exposes the action, entity
-- type and metadata.event only: never descriptions, metadata values,
-- entity ids or the acting member.
-- ============================================================

create or replace function admin.list_activity(
  p_actor_id uuid,
  p_organization_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  actor_type public.audit_actor_type,
  action public.audit_action,
  entity_type text,
  event text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 101);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  select
    l.id,
    l.organization_id,
    o.name,
    l.actor_type,
    l.action,
    l.entity_type,
    l.metadata ->> 'event',
    l.created_at
  from public.audit_logs l
  join public.organizations o on o.id = l.organization_id
  where p_organization_id is null or l.organization_id = p_organization_id
  order by l.created_at desc, l.id desc
  limit v_limit
  offset v_offset;
end;
$$;


create or replace function admin.list_audit(
  p_actor_id uuid,
  p_organization_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  actor_user_id uuid,
  actor_email text,
  action text,
  target_type text,
  target_id uuid,
  organization_id uuid,
  organization_name text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 101);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform private.assert_platform_admin(p_actor_id);

  return query
  select
    l.id,
    l.actor_user_id,
    p.email,
    l.action,
    l.target_type,
    l.target_id,
    l.organization_id,
    o.name,
    l.metadata,
    l.created_at
  from public.platform_audit_logs l
  left join public.profiles p on p.id = l.actor_user_id
  left join public.organizations o on o.id = l.organization_id
  where p_organization_id is null or l.organization_id = p_organization_id
  order by l.created_at desc, l.id desc
  limit v_limit
  offset v_offset;
end;
$$;


-- Global activity is ordered by time across organizations.
create index audit_logs_created_idx
  on public.audit_logs(created_at desc, id desc);


-- ============================================================
-- GRANTS: service_role only (the browser never reaches these functions)
-- ============================================================

revoke all on function admin.is_platform_admin(uuid) from public, anon, authenticated, service_role;
revoke all on function admin.platform_stats(uuid) from public, anon, authenticated, service_role;
revoke all on function admin.list_organizations(uuid, text, public.organization_status, public.organization_plan, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function admin.get_organization(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function admin.create_organization(uuid, text, text, public.organization_plan, uuid, text) from public, anon, authenticated, service_role;
revoke all on function admin.update_organization(uuid, uuid, public.organization_plan, public.organization_status, text) from public, anon, authenticated, service_role;
revoke all on function admin.list_members(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function admin.list_bots(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function admin.list_customers(uuid, uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function admin.list_email_accounts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function admin.list_activity(uuid, uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function admin.list_audit(uuid, uuid, integer, integer) from public, anon, authenticated, service_role;

grant execute on function admin.is_platform_admin(uuid) to service_role;
grant execute on function admin.platform_stats(uuid) to service_role;
grant execute on function admin.list_organizations(uuid, text, public.organization_status, public.organization_plan, text, integer, integer) to service_role;
grant execute on function admin.get_organization(uuid, uuid) to service_role;
grant execute on function admin.create_organization(uuid, text, text, public.organization_plan, uuid, text) to service_role;
grant execute on function admin.update_organization(uuid, uuid, public.organization_plan, public.organization_status, text) to service_role;
grant execute on function admin.list_members(uuid, uuid) to service_role;
grant execute on function admin.list_bots(uuid, uuid) to service_role;
grant execute on function admin.list_customers(uuid, uuid, integer, integer) to service_role;
grant execute on function admin.list_email_accounts(uuid, uuid) to service_role;
grant execute on function admin.list_activity(uuid, uuid, integer, integer) to service_role;
grant execute on function admin.list_audit(uuid, uuid, integer, integer) to service_role;
