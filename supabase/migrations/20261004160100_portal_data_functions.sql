-- ============================================================
-- EmailBot V2 - Phase 5: portal data access
--
-- The customer portal reads ONLY through these portal.* SECURITY DEFINER
-- functions, executable by the service role (the API) and nobody else. The
-- only authority is the session token hash:
--
--   session -> customer -> delivery -> email -> bot -> organization
--
-- No function accepts customer_id, organization_id or bot_id as authority;
-- bot / category filters are slugs applied AFTER the customer scope. A
-- delivery, email or attachment that is not the current customer's is
-- indistinguishable from a missing one (no row / null).
--
-- What a customer may see of an email is decided here, server side, by the
-- bot's portal_settings: only the configured extracted fields, the body only
-- if showBody, attachments only if showAttachments. Never rules, matched
-- rule, audit, settings, tokens or other customers.
--
-- Visibility of history: a delivery stays visible while it exists and is not
-- removed (pausing a bot or deactivating an assignment stops NEW deliveries
-- only). Customer and organization must be ACTIVE (session scope).
-- ============================================================


-- ============================================================
-- SESSION SCOPE (internal; single definition of a valid session)
-- ============================================================

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
    and o.status = 'ACTIVE';
$$;

revoke all on function private.portal_session_scope(text)
from public, anon, authenticated, service_role;


-- ============================================================
-- PORTAL FIELDS: only the keys configured in portal_settings.fields, in
-- that order; a missing value is null. Nothing else of extracted_data.
-- ============================================================

create or replace function private.portal_fields(
  p_portal_settings jsonb,
  p_extracted_data jsonb
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', f.value->>'key',
        'label', f.value->>'label',
        'value', p_extracted_data->>(f.value->>'key')
      )
      order by f.ordinality
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(
    case
      when jsonb_typeof(p_portal_settings->'fields') = 'array' then p_portal_settings->'fields'
      else '[]'::jsonb
    end
  ) with ordinality as f(value, ordinality)
  where jsonb_typeof(f.value) = 'object'
    and f.value->>'key' is not null;
$$;

revoke all on function private.portal_fields(jsonb, jsonb)
from public, anon, authenticated, service_role;


-- ============================================================
-- portal.validate_session: same contract as phase 4, now built on the
-- shared scope; bots also carry their slug (inbox filter handle).
-- ============================================================

create or replace function portal.validate_session(
  p_token_hash text
)
returns table (
  session_id uuid,
  organization_id uuid,
  customer_id uuid,
  display_name text,
  customer_status public.customer_status,
  organization_name text,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz,
  bots jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope record;
  v_session public.customer_sessions%rowtype;
  v_idle timestamptz;
begin

  select sc.session_id, sc.organization_id, sc.customer_id
  into v_scope
  from private.portal_session_scope(p_token_hash) sc;

  if v_scope.session_id is null then
    return;
  end if;

  select s.* into v_session from public.customer_sessions s where s.id = v_scope.session_id;

  v_idle := v_session.idle_expires_at;
  if v_session.last_seen_at < now() - interval '5 minutes' then
    v_idle := least(now() + interval '7 days', v_session.absolute_expires_at);
    update public.customer_sessions s
    set last_seen_at = now(),
        idle_expires_at = v_idle
    where s.id = v_session.id
      and s.revoked_at is null;
  end if;

  return query
  select
    v_session.id,
    v_session.organization_id,
    v_session.customer_id,
    c.display_name,
    c.status,
    o.name,
    v_idle,
    v_session.absolute_expires_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('name', b.name, 'slug', b.slug, 'portalSettings', b.portal_settings)
          order by b.name
        )
        from public.bot_customer_assignments a
        join public.bots b
          on b.organization_id = a.organization_id
         and b.id = a.bot_id
        where a.organization_id = v_session.organization_id
          and a.customer_id = v_session.customer_id
          and a.active
          and b.status = 'ACTIVE'
      ),
      '[]'::jsonb
    )
  from public.customers c
  join public.organizations o on o.id = c.organization_id
  where c.organization_id = v_session.organization_id
    and c.id = v_session.customer_id;

end;
$$;


-- ============================================================
-- INBOX: the customer's visible deliveries, newest delivery first, keyset
-- pagination on (delivered_at, delivery_id). At most 51 rows per call (the
-- API asks for limit + 1 to know whether there is a next page).
-- ============================================================

create or replace function portal.list_inbox(
  p_token_hash text,
  p_limit integer default 25,
  p_before_delivered_at timestamptz default null,
  p_before_id uuid default null,
  p_bot_slug text default null,
  p_category_slug text default null,
  p_unread boolean default null,
  p_important boolean default null,
  p_received_from timestamptz default null,
  p_received_to timestamptz default null,
  p_search text default null
)
returns table (
  delivery_id uuid,
  delivered_at timestamptz,
  received_at timestamptz,
  subject text,
  sender_email text,
  sender_name text,
  bot_name text,
  bot_slug text,
  category_name text,
  category_slug text,
  is_important boolean,
  is_read boolean,
  has_attachments boolean,
  fields jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope record;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 51);
  v_pattern text;
begin

  select sc.organization_id, sc.customer_id
  into v_scope
  from private.portal_session_scope(p_token_hash) sc;

  if v_scope.customer_id is null then
    return;
  end if;

  if (p_before_delivered_at is null) <> (p_before_id is null) then
    raise exception 'Invalid cursor';
  end if;

  if p_search is not null and char_length(trim(p_search)) > 0 then
    v_pattern := '%' || replace(replace(replace(left(trim(p_search), 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select
    d.id,
    d.created_at,
    e.received_at,
    e.subject,
    e.sender_email,
    e.sender_name,
    b.name,
    b.slug,
    c.name,
    c.slug,
    e.is_important,
    d.customer_read_at is not null,
    (b.portal_settings->'showAttachments') = 'true'::jsonb
      and exists (
        select 1 from public.email_attachments a
        where a.organization_id = e.organization_id
          and a.email_id = e.id
          and not a.is_inline
      ),
    private.portal_fields(b.portal_settings, e.extracted_data)
  from public.email_deliveries d
  join public.emails e
    on e.organization_id = d.organization_id
   and e.id = d.email_id
   and e.bot_id = d.bot_id
  join public.bots b
    on b.organization_id = d.organization_id
   and b.id = d.bot_id
  left join public.categories c
    on c.organization_id = e.organization_id
   and c.id = e.category_id
  where d.customer_id = v_scope.customer_id
    and d.organization_id = v_scope.organization_id
    and d.removed_at is null
    and (p_before_delivered_at is null or (d.created_at, d.id) < (p_before_delivered_at, p_before_id))
    and (p_bot_slug is null or b.slug = p_bot_slug)
    and (p_category_slug is null or c.slug = p_category_slug)
    and (p_unread is null or (d.customer_read_at is null) = p_unread)
    and (p_important is null or e.is_important = p_important)
    and (p_received_from is null or e.received_at >= p_received_from)
    and (p_received_to is null or e.received_at < p_received_to)
    and (
      v_pattern is null
      or e.subject ilike v_pattern
      or e.sender_email ilike v_pattern
      or e.sender_name ilike v_pattern
    )
  order by d.created_at desc, d.id desc
  limit v_limit;

end;
$$;


-- ============================================================
-- EMAIL DETAIL by delivery id. Marks the delivery as read by the customer.
-- Returns null when the delivery is not the current customer's (or the
-- session is not valid).
-- ============================================================

create or replace function portal.get_email(
  p_token_hash text,
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope record;
  v_row record;
  v_show_body boolean;
  v_show_attachments boolean;
begin

  select sc.organization_id, sc.customer_id
  into v_scope
  from private.portal_session_scope(p_token_hash) sc;

  if v_scope.customer_id is null or p_delivery_id is null then
    return null;
  end if;

  select
    d.id as delivery_id,
    d.created_at as delivered_at,
    e.id as email_id,
    e.organization_id,
    e.received_at,
    e.subject,
    e.sender_email,
    e.sender_name,
    e.text_body,
    e.html_body,
    e.is_important,
    e.extracted_data,
    b.name as bot_name,
    b.slug as bot_slug,
    b.portal_settings,
    c.name as category_name,
    c.slug as category_slug
  into v_row
  from public.email_deliveries d
  join public.emails e
    on e.organization_id = d.organization_id
   and e.id = d.email_id
   and e.bot_id = d.bot_id
  join public.bots b
    on b.organization_id = d.organization_id
   and b.id = d.bot_id
  left join public.categories c
    on c.organization_id = e.organization_id
   and c.id = e.category_id
  where d.id = p_delivery_id
    and d.customer_id = v_scope.customer_id
    and d.organization_id = v_scope.organization_id
    and d.removed_at is null;

  if v_row.delivery_id is null then
    return null;
  end if;

  update public.email_deliveries d
  set customer_read_at = now()
  where d.id = v_row.delivery_id
    and d.customer_read_at is null;

  v_show_body := (v_row.portal_settings->'showBody') = 'true'::jsonb;
  v_show_attachments := (v_row.portal_settings->'showAttachments') = 'true'::jsonb;

  return jsonb_build_object(
    'deliveryId', v_row.delivery_id,
    'deliveredAt', v_row.delivered_at,
    'receivedAt', v_row.received_at,
    'subject', v_row.subject,
    'sender', jsonb_build_object('email', v_row.sender_email, 'name', v_row.sender_name),
    'bot', jsonb_build_object('name', v_row.bot_name, 'slug', v_row.bot_slug),
    'category',
      case when v_row.category_name is null then null
           else jsonb_build_object('name', v_row.category_name, 'slug', v_row.category_slug) end,
    'important', v_row.is_important,
    'read', true,
    'fields', private.portal_fields(v_row.portal_settings, v_row.extracted_data),
    'body',
      case when v_show_body then jsonb_build_object('text', v_row.text_body, 'html', v_row.html_body)
           else null end,
    'attachments',
      case when v_show_attachments then (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', a.id,
              'filename', a.filename,
              'contentType', a.content_type,
              'size', a.file_size,
              'available', a.storage_uploaded
            )
            order by a.created_at, a.id
          ),
          '[]'::jsonb
        )
        from public.email_attachments a
        where a.organization_id = v_row.organization_id
          and a.email_id = v_row.email_id
          and not a.is_inline
      ) else null end
  );

end;
$$;


-- ============================================================
-- ATTACHMENT for download: session -> customer -> delivery -> email ->
-- attachment, only if the bot shows attachments and the content is stored.
-- The API signs a short-lived URL for exactly this object.
-- ============================================================

create or replace function portal.get_attachment(
  p_token_hash text,
  p_delivery_id uuid,
  p_attachment_id uuid
)
returns table (
  attachment_id uuid,
  email_id uuid,
  organization_id uuid,
  filename text,
  content_type text,
  storage_bucket text,
  storage_path text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope record;
begin

  select sc.organization_id, sc.customer_id
  into v_scope
  from private.portal_session_scope(p_token_hash) sc;

  if v_scope.customer_id is null then
    return;
  end if;

  return query
  select a.id, a.email_id, a.organization_id, a.filename, a.content_type, a.storage_bucket, a.storage_path
  from public.email_deliveries d
  join public.emails e
    on e.organization_id = d.organization_id
   and e.id = d.email_id
   and e.bot_id = d.bot_id
  join public.bots b
    on b.organization_id = d.organization_id
   and b.id = d.bot_id
  join public.email_attachments a
    on a.organization_id = e.organization_id
   and a.email_id = e.id
  where d.id = p_delivery_id
    and d.customer_id = v_scope.customer_id
    and d.organization_id = v_scope.organization_id
    and d.removed_at is null
    and a.id = p_attachment_id
    and not a.is_inline
    and a.storage_uploaded
    and (b.portal_settings->'showAttachments') = 'true'::jsonb;

end;
$$;


-- ============================================================
-- EXECUTE: service role only
-- ============================================================

revoke all on function portal.list_inbox(text, integer, timestamptz, uuid, text, text, boolean, boolean, timestamptz, timestamptz, text)
from public, anon, authenticated, service_role;
revoke all on function portal.get_email(text, uuid)
from public, anon, authenticated, service_role;
revoke all on function portal.get_attachment(text, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function portal.list_inbox(text, integer, timestamptz, uuid, text, text, boolean, boolean, timestamptz, timestamptz, text) to service_role;
grant execute on function portal.get_email(text, uuid) to service_role;
grant execute on function portal.get_attachment(text, uuid, uuid) to service_role;
