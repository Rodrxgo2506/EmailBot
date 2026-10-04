-- ============================================================
-- EmailBot - Migration 5
--
-- 1. Idempotent email ingestion (provider message deduplication)
-- 2. Private Supabase Storage bucket for attachments
-- 3. Audit log integrity fixes for legitimate cascades
--
-- This migration only ADDS objects or replaces function bodies.
-- No table or column is dropped and no data is modified.
-- ============================================================


-- ============================================================
-- 1. EMAIL DEDUPLICATION
--
-- Migration 3 created a NON-unique index on
-- (email_account_id, provider_message_id). The worker needs a real
-- uniqueness guarantee so that the same provider message delivered
-- twice (webhook retries, overlapping syncs, concurrent jobs) can never
-- produce two rows:
--
--   insert ... on conflict (email_account_id, provider_message_id)
--   do nothing
--
-- NULL provider_message_id values remain allowed (NULLs are distinct),
-- which keeps manually created/outbound rows possible.
--
-- NOTE: creating this index fails if duplicates already exist. The
-- tables are new and no ingestion existed before this migration.
-- ============================================================

create unique index emails_account_provider_message_unique_idx
  on public.emails(
    email_account_id,
    provider_message_id
  );

comment on index public.emails_account_provider_message_unique_idx is
  'Guarantees idempotent ingestion: one row per provider message per email account.';


-- ============================================================
-- 2. ATTACHMENTS STORAGE BUCKET
--
-- Private bucket. No storage.objects policies are created for the
-- authenticated role on purpose: browsers never access objects
-- directly. The API verifies access to the attachment row through RLS
-- (public.email_attachments) and then issues a short-lived signed URL.
--
-- Object paths are "<organization_id>/<email_id>/<attachment_id>/<file>".
-- ============================================================

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit
)
values (
  'email-attachments',
  'email-attachments',
  false,
  26214400 -- 25 MiB
)
on conflict (id) do nothing;


-- ============================================================
-- 3. AUDIT LOG INTEGRITY
--
-- Problem found in Migration 4:
--
--   a) audit_logs.organization_id is ON DELETE CASCADE, but the
--      immutability trigger rejects every DELETE, so deleting an
--      organization always failed.
--
--   b) audit_logs.actor_user_id is ON DELETE SET NULL, but the
--      immutability trigger rejects every UPDATE and the
--      audit_logs_system_actor_consistency check requires USER events
--      to keep an actor, so deleting a user that had any audit history
--      always failed.
--
-- Fix (audit records stay immutable for every other operation):
--
--   - DELETE is accepted only when the parent organization no longer
--     exists (same technique used by private.enforce_organization_owner).
--
--   - UPDATE is accepted only when it is exactly the ON DELETE SET NULL
--     of actor_user_id after the profile was deleted (anonymization).
--     Every other column must be unchanged.
--
--   - The check constraint is relaxed so a USER event may keep a NULL
--     actor after anonymization. New USER events still REQUIRE an actor
--     that belongs to the organization: that is enforced on INSERT by
--     private.validate_audit_log_actor() (unchanged).
-- ============================================================

alter table public.audit_logs
  drop constraint audit_logs_system_actor_consistency;

alter table public.audit_logs
  add constraint audit_logs_actor_consistency
  check (
    actor_type = 'USER'
    or actor_user_id is null
  );

comment on constraint audit_logs_actor_consistency on public.audit_logs is
  'SYSTEM events never have an actor. USER events require an actor on insert (trigger) and may only lose it when the user is deleted.';


create or replace function private.prevent_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  if tg_op = 'DELETE' then

    -- Organization deletion cascading to its audit trail.
    if not exists (
      select 1
      from public.organizations o
      where o.id = old.organization_id
    ) then
      return old;
    end if;

  elsif tg_op = 'UPDATE' then

    -- ON DELETE SET NULL of actor_user_id after the profile was deleted.
    if old.actor_user_id is not null
      and new.actor_user_id is null
      and not exists (
        select 1
        from public.profiles p
        where p.id = old.actor_user_id
      )
      and (
        new.id,
        new.organization_id,
        new.actor_type,
        new.action,
        new.entity_type,
        new.entity_id,
        new.description,
        new.metadata,
        new.request_id,
        new.created_at
      ) is not distinct from (
        old.id,
        old.organization_id,
        old.actor_type,
        old.action,
        old.entity_type,
        old.entity_id,
        old.description,
        old.metadata,
        old.request_id,
        old.created_at
      )
    then
      return new;
    end if;

  end if;

  raise exception
    'Audit logs are immutable and cannot be modified or deleted';

end;
$$;

revoke all on function private.prevent_audit_log_mutation()
from public, anon, authenticated;

comment on function private.prevent_audit_log_mutation() is
  'Keeps audit records immutable; only allows organization-deletion cascades and actor anonymization on user deletion.';
