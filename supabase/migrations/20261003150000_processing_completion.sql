-- ============================================================
-- EmailBot - Migration 9
--
-- Resumable email processing: the database records whether the
-- worker finished processing an email, and attachment rows can be
-- written idempotently.
--
-- Why: the worker commits the email row first and then writes the
-- attachment rows, stores their contents (Supabase Storage, outside
-- any SQL transaction), publishes the realtime event and enqueues
-- notifications. Without a completion marker, an email left half
-- processed by a job that exhausted its retries could never be
-- resumed, and two concurrent resumes could duplicate attachment rows.
--
-- 1. service_role may UPDATE only the processing-state columns of
--    public.emails (RECEIVED -> PROCESSING -> PROCESSED / FAILED).
--    It still has no DELETE and cannot change any other column.
-- 2. Unique (email_id, provider_attachment_id) so the worker can use
--    INSERT ... ON CONFLICT DO NOTHING.
-- 3. Processing state is owned by the worker: authenticated users
--    (any role, OPERATOR included) can no longer write it. Every other
--    column privilege of authenticated is unchanged.
--
-- Production had no emails or attachments when this migration was
-- written; the index creation still checks for duplicates first.
-- ============================================================


-- ------------------------------------------------------------
-- 1. service_role: processing-state columns only.
-- ------------------------------------------------------------

grant update (
  processing_status,
  processed_at,
  processing_error_code,
  processing_error_message,
  processing_attempts
)
on table public.emails
to service_role;


-- ------------------------------------------------------------
-- 2. Idempotent attachment rows.
--
-- A plain (non-partial) unique index: NULLs are distinct by default,
-- so attachments without a provider id never conflict - the same
-- semantics as "UNIQUE ... WHERE provider_attachment_id IS NOT NULL" -
-- and, unlike a partial index, it can be the arbiter of
-- ON CONFLICT (email_id, provider_attachment_id) issued through
-- PostgREST (which cannot repeat a partial index predicate).
-- ------------------------------------------------------------

do $$
declare
  duplicates bigint;
begin
  select count(*) into duplicates
  from (
    select 1
    from public.email_attachments
    where provider_attachment_id is not null
    group by email_id, provider_attachment_id
    having count(*) > 1
  ) d;

  if duplicates > 0 then
    raise exception
      'Cannot create email_attachments_email_provider_attachment_unique_idx: % duplicated (email_id, provider_attachment_id) group(s) must be resolved first',
      duplicates;
  end if;
end;
$$;

create unique index email_attachments_email_provider_attachment_unique_idx
  on public.email_attachments(
    email_id,
    provider_attachment_id
  );


-- ------------------------------------------------------------
-- 3. Processing state is server-owned.
--
-- Migration 3 let authenticated (OPERATOR and above through RLS)
-- insert/update these columns. A user could mark an email PROCESSED
-- (the worker would then never complete it) or PROCESSING (forcing
-- resumes). The web/API never write them.
-- ------------------------------------------------------------

revoke insert (
  processing_status,
  processing_error_code,
  processing_error_message,
  processing_attempts,
  processing_started_at,
  processed_at
)
on table public.emails
from authenticated;

revoke update (
  processing_status,
  processing_error_code,
  processing_error_message,
  processing_attempts,
  processing_started_at,
  processed_at
)
on table public.emails
from authenticated;


comment on index public.email_attachments_email_provider_attachment_unique_idx is
  'One attachment row per provider attachment of an email (NULL provider ids never conflict). Arbiter of the worker''s idempotent inserts.';
