-- ============================================================
-- EmailBot - Migration 3
--
-- Emails, attachments and processing state
--
-- This migration also hardens access to OAuth credentials
-- created in Migration 2.
-- ============================================================


-- ============================================================
-- ENUMS
-- ============================================================

create type public.email_processing_status as enum (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED'
);

create type public.email_direction as enum (
  'INBOUND',
  'OUTBOUND'
);


-- ============================================================
-- EMAILS
-- ============================================================

create table public.emails (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  email_account_id uuid not null
    references public.email_accounts(id)
    on delete cascade,

  category_id uuid
    references public.categories(id)
    on delete set null,

  matched_rule_id uuid
    references public.email_rules(id)
    on delete set null,

  direction public.email_direction not null default 'INBOUND',

  processing_status public.email_processing_status
    not null default 'RECEIVED',

  -- ----------------------------------------------------------
  -- Provider identifiers
  -- ----------------------------------------------------------

  provider_message_id text,

  provider_thread_id text,

  internet_message_id text,

  -- ----------------------------------------------------------
  -- Sender
  -- ----------------------------------------------------------

  sender_email text not null,

  sender_name text,

  -- ----------------------------------------------------------
  -- Recipients
  -- ----------------------------------------------------------

  to_emails text[] not null default '{}',

  cc_emails text[] not null default '{}',

  bcc_emails text[] not null default '{}',

  -- ----------------------------------------------------------
  -- Message content
  -- ----------------------------------------------------------

  subject text,

  snippet text,

  text_body text,

  html_body text,

  -- ----------------------------------------------------------
  -- Message metadata
  -- ----------------------------------------------------------

  received_at timestamptz not null,

  sent_at timestamptz,

  headers jsonb not null default '{}'::jsonb,

  provider_metadata jsonb not null default '{}'::jsonb,

  -- ----------------------------------------------------------
  -- Processing results
  -- ----------------------------------------------------------

  extracted_data jsonb not null default '{}'::jsonb,

  processing_error_code text,

  processing_error_message text,

  processing_attempts integer not null default 0,

  processing_started_at timestamptz,

  processed_at timestamptz,

  -- ----------------------------------------------------------
  -- User state
  -- ----------------------------------------------------------

  is_read boolean not null default false,

  is_important boolean not null default false,

  is_archived boolean not null default false,

  -- ----------------------------------------------------------
  -- Deduplication
  -- ----------------------------------------------------------

  content_hash text,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),


  -- ==========================================================
  -- CONSTRAINTS
  -- ==========================================================

  constraint emails_sender_email_length
    check (
      char_length(trim(sender_email)) between 3 and 320
    ),

  constraint emails_sender_email_format
    check (
      sender_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),

  constraint emails_sender_name_length
    check (
      sender_name is null
      or char_length(sender_name) <= 200
    ),

  constraint emails_subject_length
    check (
      subject is null
      or char_length(subject) <= 1000
    ),

  constraint emails_snippet_length
    check (
      snippet is null
      or char_length(snippet) <= 2000
    ),

  constraint emails_provider_message_id_length
    check (
      provider_message_id is null
      or char_length(provider_message_id) <= 1000
    ),

  constraint emails_provider_thread_id_length
    check (
      provider_thread_id is null
      or char_length(provider_thread_id) <= 1000
    ),

  constraint emails_internet_message_id_length
    check (
      internet_message_id is null
      or char_length(internet_message_id) <= 1000
    ),

  constraint emails_headers_object
    check (
      jsonb_typeof(headers) = 'object'
    ),

  constraint emails_provider_metadata_object
    check (
      jsonb_typeof(provider_metadata) = 'object'
    ),

  constraint emails_extracted_data_object
    check (
      jsonb_typeof(extracted_data) = 'object'
    ),

  constraint emails_processing_attempts_nonnegative
    check (
      processing_attempts >= 0
    ),

  constraint emails_processing_error_code_length
    check (
      processing_error_code is null
      or char_length(processing_error_code) <= 150
    ),

  constraint emails_processing_error_message_length
    check (
      processing_error_message is null
      or char_length(processing_error_message) <= 4000
    ),

  constraint emails_content_hash_length
    check (
      content_hash is null
      or char_length(content_hash) <= 128
    )
);


comment on table public.emails is
  'Normalized emails received or sent through connected EmailBot accounts.';

comment on column public.emails.provider_message_id is
  'Native message identifier supplied by Gmail, Microsoft Graph or IMAP provider.';

comment on column public.emails.provider_thread_id is
  'Native conversation/thread identifier supplied by the provider.';

comment on column public.emails.internet_message_id is
  'RFC Message-ID header used for cross-provider email identification.';

comment on column public.emails.headers is
  'Normalized email headers represented as JSON.';

comment on column public.emails.provider_metadata is
  'Provider-specific metadata that does not belong in the normalized model.';

comment on column public.emails.extracted_data is
  'Structured values extracted from the email by EmailBot rules.';

comment on column public.emails.content_hash is
  'Optional deterministic hash used as an additional deduplication mechanism.';


-- ============================================================
-- EMAIL INDEXES
-- ============================================================

create index emails_organization_received_idx
  on public.emails(
    organization_id,
    received_at desc
  );

create index emails_account_received_idx
  on public.emails(
    email_account_id,
    received_at desc
  );

create index emails_organization_unread_idx
  on public.emails(
    organization_id,
    is_read,
    received_at desc
  );

create index emails_organization_important_idx
  on public.emails(
    organization_id,
    is_important,
    received_at desc
  );

create index emails_organization_archived_idx
  on public.emails(
    organization_id,
    is_archived,
    received_at desc
  );

create index emails_category_idx
  on public.emails(
    organization_id,
    category_id,
    received_at desc
  );

create index emails_processing_status_idx
  on public.emails(
    organization_id,
    processing_status,
    received_at
  );

create index emails_matched_rule_idx
  on public.emails(
    organization_id,
    matched_rule_id
  );

create index emails_provider_message_id_idx
  on public.emails(
    email_account_id,
    provider_message_id
  );

create index emails_provider_thread_id_idx
  on public.emails(
    email_account_id,
    provider_thread_id
  );

create index emails_internet_message_id_idx
  on public.emails(
    internet_message_id
  );

create index emails_sender_email_idx
  on public.emails(
    organization_id,
    lower(sender_email)
  );

create index emails_content_hash_idx
  on public.emails(
    email_account_id,
    content_hash
  );


-- ============================================================
-- FULL TEXT SEARCH
--
-- PostgreSQL does not allow the complete expression used here
-- as an immutable GENERATED column.
--
-- We therefore maintain search_vector through a trigger.
-- ============================================================

alter table public.emails
add column search_vector tsvector;


create or replace function private.update_email_search_vector()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.search_vector :=
    to_tsvector(
      'simple'::regconfig,
      concat_ws(
        ' ',
        coalesce(new.subject, ''),
        coalesce(new.sender_email, ''),
        coalesce(new.sender_name, ''),
        coalesce(new.snippet, ''),
        coalesce(new.text_body, '')
      )
    );

  return new;
end;
$$;


create trigger emails_update_search_vector
before insert or update of
  subject,
  sender_email,
  sender_name,
  snippet,
  text_body
on public.emails
for each row
execute function private.update_email_search_vector();


create index emails_search_vector_idx
  on public.emails
  using gin(search_vector);


-- ============================================================
-- EMAIL ATTACHMENTS
-- ============================================================

create table public.email_attachments (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  email_id uuid not null
    references public.emails(id)
    on delete cascade,

  -- ----------------------------------------------------------
  -- Original provider information
  -- ----------------------------------------------------------

  provider_attachment_id text,

  filename text not null,

  content_type text,

  file_size bigint,

  content_id text,

  is_inline boolean not null default false,

  -- ----------------------------------------------------------
  -- Supabase Storage
  -- ----------------------------------------------------------

  storage_bucket text,

  storage_path text,

  storage_uploaded boolean not null default false,

  -- ----------------------------------------------------------
  -- Processing
  -- ----------------------------------------------------------

  extracted_text text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),


  -- ==========================================================
  -- CONSTRAINTS
  -- ==========================================================

  constraint email_attachments_filename_length
    check (
      char_length(trim(filename)) between 1 and 500
    ),

  constraint email_attachments_content_type_length
    check (
      content_type is null
      or char_length(content_type) <= 255
    ),

  constraint email_attachments_file_size_nonnegative
    check (
      file_size is null
      or file_size >= 0
    ),

  constraint email_attachments_content_id_length
    check (
      content_id is null
      or char_length(content_id) <= 1000
    ),

  constraint email_attachments_storage_bucket_length
    check (
      storage_bucket is null
      or char_length(storage_bucket) <= 255
    ),

  constraint email_attachments_storage_path_length
    check (
      storage_path is null
      or char_length(storage_path) <= 2000
    ),

  constraint email_attachments_metadata_object
    check (
      jsonb_typeof(metadata) = 'object'
    )
);


comment on table public.email_attachments is
  'Attachments associated with normalized EmailBot emails.';

comment on column public.email_attachments.storage_path is
  'Path of the attachment inside Supabase Storage.';

comment on column public.email_attachments.extracted_text is
  'Optional text extracted from supported attachment formats.';


-- ============================================================
-- ATTACHMENT INDEXES
-- ============================================================

create index email_attachments_organization_idx
  on public.email_attachments(
    organization_id
  );

create index email_attachments_email_idx
  on public.email_attachments(
    email_id
  );

create index email_attachments_provider_id_idx
  on public.email_attachments(
    email_id,
    provider_attachment_id
  );

create index email_attachments_storage_idx
  on public.email_attachments(
    organization_id,
    storage_bucket,
    storage_path
  );


-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

create trigger emails_set_updated_at
before update on public.emails
for each row
execute function public.set_updated_at();


create trigger email_attachments_set_updated_at
before update on public.email_attachments
for each row
execute function public.set_updated_at();


-- ============================================================
-- RLS
-- ============================================================

alter table public.emails
enable row level security;

alter table public.email_attachments
enable row level security;


-- ============================================================
-- EMAIL POLICIES
-- ============================================================

create policy "Members can view emails"
on public.emails
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


create policy "Operators and above can create emails"
on public.emails
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


create policy "Operators and above can update emails"
on public.emails
for update
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
)
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


create policy "Owners and admins can delete emails"
on public.emails
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- ATTACHMENT POLICIES
-- ============================================================

create policy "Members can view attachments"
on public.email_attachments
for select
to authenticated
using (
  (select private.is_organization_member(organization_id))
);


create policy "Operators and above can create attachments"
on public.email_attachments
for insert
to authenticated
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


create policy "Operators and above can update attachments"
on public.email_attachments
for update
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
)
with check (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


create policy "Owners and admins can delete attachments"
on public.email_attachments
for delete
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS - EMAILS
-- ============================================================

revoke all on table public.emails
from anon, authenticated;


grant select
on table public.emails
to authenticated;


grant insert (
  organization_id,
  email_account_id,
  category_id,
  matched_rule_id,
  direction,
  processing_status,
  provider_message_id,
  provider_thread_id,
  internet_message_id,
  sender_email,
  sender_name,
  to_emails,
  cc_emails,
  bcc_emails,
  subject,
  snippet,
  text_body,
  html_body,
  received_at,
  sent_at,
  headers,
  provider_metadata,
  extracted_data,
  processing_error_code,
  processing_error_message,
  processing_attempts,
  processing_started_at,
  processed_at,
  is_read,
  is_important,
  is_archived,
  content_hash
)
on table public.emails
to authenticated;


grant update (
  category_id,
  matched_rule_id,
  processing_status,
  extracted_data,
  processing_error_code,
  processing_error_message,
  processing_attempts,
  processing_started_at,
  processed_at,
  is_read,
  is_important,
  is_archived
)
on table public.emails
to authenticated;


grant delete
on table public.emails
to authenticated;


-- ============================================================
-- GRANTS - ATTACHMENTS
-- ============================================================

revoke all on table public.email_attachments
from anon, authenticated;


grant select
on table public.email_attachments
to authenticated;


grant insert (
  organization_id,
  email_id,
  provider_attachment_id,
  filename,
  content_type,
  file_size,
  content_id,
  is_inline,
  storage_bucket,
  storage_path,
  storage_uploaded,
  extracted_text,
  metadata
)
on table public.email_attachments
to authenticated;


grant update (
  storage_bucket,
  storage_path,
  storage_uploaded,
  extracted_text,
  metadata
)
on table public.email_attachments
to authenticated;


grant delete
on table public.email_attachments
to authenticated;


-- ============================================================
-- SECURITY HARDENING FROM MIGRATION 2
--
-- OAuth tokens must never be readable or writable by the
-- authenticated frontend role.
--
-- The backend/worker will use a privileged server-side
-- connection to manage these fields.
-- ============================================================

revoke select
on table public.email_accounts
from authenticated;


grant select (
  id,
  organization_id,
  provider,
  status,
  email_address,
  display_name,
  provider_account_id,
  token_expires_at,
  provider_metadata,
  sync_cursor,
  last_synced_at,
  last_error_code,
  last_error_message,
  created_at,
  updated_at
)
on table public.email_accounts
to authenticated;


revoke insert (
  access_token_encrypted,
  refresh_token_encrypted
)
on table public.email_accounts
from authenticated;


revoke update (
  access_token_encrypted,
  refresh_token_encrypted
)
on table public.email_accounts
from authenticated;


-- ============================================================
-- PREVENT CROSS-TENANT FOREIGN KEY REFERENCES
--
-- Ensures that related resources always belong to the same
-- organization.
-- ============================================================

create or replace function private.validate_email_tenant_relationships()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_organization_id uuid;
  category_organization_id uuid;
  rule_organization_id uuid;
begin

  select ea.organization_id
  into account_organization_id
  from public.email_accounts ea
  where ea.id = new.email_account_id;

  if account_organization_id is null then
    raise exception 'Email account not found';
  end if;

  if account_organization_id <> new.organization_id then
    raise exception
      'Email account does not belong to the email organization';
  end if;


  if new.category_id is not null then

    select c.organization_id
    into category_organization_id
    from public.categories c
    where c.id = new.category_id;

    if category_organization_id is null then
      raise exception 'Category not found';
    end if;

    if category_organization_id <> new.organization_id then
      raise exception
        'Category does not belong to the email organization';
    end if;

  end if;


  if new.matched_rule_id is not null then

    select er.organization_id
    into rule_organization_id
    from public.email_rules er
    where er.id = new.matched_rule_id;

    if rule_organization_id is null then
      raise exception 'Matched rule not found';
    end if;

    if rule_organization_id <> new.organization_id then
      raise exception
        'Matched rule does not belong to the email organization';
    end if;

  end if;


  return new;
end;
$$;


create trigger emails_validate_tenant_relationships
before insert or update
on public.emails
for each row
execute function private.validate_email_tenant_relationships();


create or replace function private.validate_attachment_tenant_relationship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  email_organization_id uuid;
begin

  select e.organization_id
  into email_organization_id
  from public.emails e
  where e.id = new.email_id;

  if email_organization_id is null then
    raise exception 'Email not found';
  end if;

  if email_organization_id <> new.organization_id then
    raise exception
      'Attachment does not belong to the email organization';
  end if;

  return new;
end;
$$;


create trigger email_attachments_validate_tenant_relationship
before insert or update
on public.email_attachments
for each row
execute function private.validate_attachment_tenant_relationship();


-- ============================================================
-- FUNCTION PERMISSIONS
-- ============================================================

revoke all on function private.update_email_search_vector()
from public, anon, authenticated;


revoke all on function private.validate_email_tenant_relationships()
from public, anon, authenticated;


revoke all on function private.validate_attachment_tenant_relationship()
from public, anon, authenticated;


-- ============================================================
-- COMMENTS
-- ============================================================

comment on table public.emails is
  'Normalized EmailBot messages with provider IDs, content, processing state and extracted data.';


comment on table public.email_attachments is
  'Email attachments whose binary content may be stored in Supabase Storage.';


comment on function private.update_email_search_vector() is
  'Maintains the full-text search vector for email content.';


comment on function private.validate_email_tenant_relationships() is
  'Ensures email, account, category and matched rule belong to the same organization.';


comment on function private.validate_attachment_tenant_relationship() is
  'Ensures an attachment and its email belong to the same organization.';