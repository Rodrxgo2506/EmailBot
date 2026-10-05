-- ============================================================
-- EmailBot V2 - Phase 5.5: portal visibility and inbox order
--
-- 1. Visibility follows the CURRENT bot <-> customer assignment. A delivery
--    is visible in the portal only while its assignment is active:
--      customer ACTIVE + assignment ACTIVE   -> visible (bot ACTIVE or PAUSED)
--      customer ACTIVE + assignment INACTIVE -> hidden (stored, not deleted)
--      customer / organization SUSPENDED     -> no session at all
--      MANUAL delivery removed               -> hidden
--    Nothing is deleted: deliveries, emails, attachments and audit stay for
--    administration, audit, statistics and debugging.
-- 2. The inbox lists EMAILS: newest received first (received_at DESC, then
--    delivery id DESC); the keyset cursor uses the same columns. A manual
--    delivery of an old email keeps the email's original position.
-- 3. portal.list_filters: the bots and categories the customer can filter by.
--
-- Same contract as phase 5: SECURITY DEFINER, search_path = '', only the
-- service role executes, the session token hash is the only authority.
-- ============================================================


-- ============================================================
-- portal.validate_session: bots of the customer's ACTIVE assignments,
-- whatever the bot status (a paused bot's history stays visible).
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
-- portal.list_inbox: new cursor columns (received_at, delivery id), so the
-- signature changes: dropped and created again (a function, no data).
-- ============================================================

drop function portal.list_inbox(text, integer, timestamptz, uuid, text, text, boolean, boolean, timestamptz, timestamptz, text);

create function portal.list_inbox(
  p_token_hash text,
  p_limit integer default 25,
  p_before_received_at timestamptz default null,
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

  if (p_before_received_at is null) <> (p_before_id is null) then
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
        select 1 from public.email_attachments att
        where att.organization_id = e.organization_id
          and att.email_id = e.id
          and not att.is_inline
      ),
    private.portal_fields(b.portal_settings, e.extracted_data)
  from public.email_deliveries d
  join public.bot_customer_assignments a
    on a.organization_id = d.organization_id
   and a.bot_id = d.bot_id
   and a.customer_id = d.customer_id
   and a.active
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
    and (p_before_received_at is null or (e.received_at, d.id) < (p_before_received_at, p_before_id))
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
  order by e.received_at desc, d.id desc
  limit v_limit;

end;
$$;


-- ============================================================
-- portal.get_email: also requires the active assignment.
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
  join public.bot_customer_assignments a
    on a.organization_id = d.organization_id
   and a.bot_id = d.bot_id
   and a.customer_id = d.customer_id
   and a.active
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
              'id', att.id,
              'filename', att.filename,
              'contentType', att.content_type,
              'size', att.file_size,
              'available', att.storage_uploaded
            )
            order by att.created_at, att.id
          ),
          '[]'::jsonb
        )
        from public.email_attachments att
        where att.organization_id = v_row.organization_id
          and att.email_id = v_row.email_id
          and not att.is_inline
      ) else null end
  );

end;
$$;


-- ============================================================
-- portal.get_attachment: also requires the active assignment.
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
  select att.id, att.email_id, att.organization_id, att.filename, att.content_type, att.storage_bucket, att.storage_path
  from public.email_deliveries d
  join public.bot_customer_assignments a
    on a.organization_id = d.organization_id
   and a.bot_id = d.bot_id
   and a.customer_id = d.customer_id
   and a.active
  join public.emails e
    on e.organization_id = d.organization_id
   and e.id = d.email_id
   and e.bot_id = d.bot_id
  join public.bots b
    on b.organization_id = d.organization_id
   and b.id = d.bot_id
  join public.email_attachments att
    on att.organization_id = e.organization_id
   and att.email_id = e.id
  where d.id = p_delivery_id
    and d.customer_id = v_scope.customer_id
    and d.organization_id = v_scope.organization_id
    and d.removed_at is null
    and att.id = p_attachment_id
    and not att.is_inline
    and att.storage_uploaded
    and (b.portal_settings->'showAttachments') = 'true'::jsonb;

end;
$$;


-- ============================================================
-- portal.list_filters: bots of the active assignments and the categories
-- present in the customer's VISIBLE deliveries (names and slugs only).
-- ============================================================

create or replace function portal.list_filters(
  p_token_hash text
)
returns jsonb
language plpgsql
stable
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
    return null;
  end if;

  return jsonb_build_object(
    'bots', coalesce((
      select jsonb_agg(jsonb_build_object('name', b.name, 'slug', b.slug) order by b.name, b.slug)
      from public.bot_customer_assignments a
      join public.bots b
        on b.organization_id = a.organization_id
       and b.id = a.bot_id
      where a.organization_id = v_scope.organization_id
        and a.customer_id = v_scope.customer_id
        and a.active
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'slug', x.slug) order by x.name, x.slug)
      from (
        select distinct c.name, c.slug
        from public.email_deliveries d
        join public.bot_customer_assignments a
          on a.organization_id = d.organization_id
         and a.bot_id = d.bot_id
         and a.customer_id = d.customer_id
         and a.active
        join public.emails e
          on e.organization_id = d.organization_id
         and e.id = d.email_id
        join public.categories c
          on c.organization_id = e.organization_id
         and c.id = e.category_id
        where d.customer_id = v_scope.customer_id
          and d.organization_id = v_scope.organization_id
          and d.removed_at is null
      ) x
    ), '[]'::jsonb)
  );

end;
$$;


-- ============================================================
-- EXECUTE: service role only
-- ============================================================

revoke all on function portal.list_inbox(text, integer, timestamptz, uuid, text, text, boolean, boolean, timestamptz, timestamptz, text)
from public, anon, authenticated, service_role;
revoke all on function portal.list_filters(text)
from public, anon, authenticated, service_role;

grant execute on function portal.list_inbox(text, integer, timestamptz, uuid, text, text, boolean, boolean, timestamptz, timestamptz, text) to service_role;
grant execute on function portal.list_filters(text) to service_role;
