-- ============================================================
-- EmailBot V2 - Phase 7: recorded acceptance of the legal documents
--
-- Signing up requires accepting the Terms and the Privacy Policy (checkbox
-- in the web app). The versions accepted travel in the sign-up metadata
-- (raw_user_meta_data.legal_terms_version / legal_privacy_version) and this
-- trigger records them when Supabase Auth creates the user, with the
-- DATABASE time (the client never sets the date).
--
-- public.legal_acceptances is append-only:
--   - no grant for anon, authenticated or service_role (evidence is read by
--     the database owner); rows are only written by the trigger below;
--   - UPDATE is always refused and DELETE only happens through the cascade
--     when the user itself is deleted (same technique as audit_logs).
-- Additive: no existing table, policy or function changes. Users created
-- before this migration (or without the metadata, e.g. by an administrator)
-- simply have no row; nothing about them breaks.
--
-- RLS template:
--   SELECT / INSERT / UPDATE / DELETE  nobody through the Data API.
--   Cross-organization: n/a (per user). Customer (portal): no.
--   Super Admin: no API access. service_role: none.
-- ============================================================

create table public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users(id)
    on delete cascade,

  document text not null,

  version text not null,

  accepted_at timestamptz not null default now(),

  -- How it was accepted. Only "signup" today (a future re-acceptance screen would add its own value).
  source text not null,

  constraint legal_acceptances_document
    check (document in ('terms', 'privacy')),

  constraint legal_acceptances_version_format
    check (version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),

  constraint legal_acceptances_source
    check (source in ('signup')),

  constraint legal_acceptances_unique
    unique (user_id, document, version)
);

comment on table public.legal_acceptances is
  'Versions of the Terms and Privacy Policy accepted by each user and when (database time). Append-only.';

alter table public.legal_acceptances enable row level security;

revoke all on table public.legal_acceptances
from public, anon, authenticated, service_role;


-- Append-only: UPDATE never; DELETE only once the user is gone (ON DELETE CASCADE).
create or replace function private.prevent_legal_acceptance_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and not exists (select 1 from auth.users u where u.id = old.user_id)
  then
    return old;
  end if;

  raise exception
    'Legal acceptances are append-only and cannot be modified or deleted';
end;
$$;

revoke all on function private.prevent_legal_acceptance_mutation()
from public, anon, authenticated, service_role;

create trigger legal_acceptances_prevent_update
before update on public.legal_acceptances
for each row
execute function private.prevent_legal_acceptance_mutation();

create trigger legal_acceptances_prevent_delete
before delete on public.legal_acceptances
for each row
execute function private.prevent_legal_acceptance_mutation();


-- Records the sign-up acceptance. Never blocks the creation of the user:
-- missing or malformed versions are simply not recorded.
create or replace function private.record_signup_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms text := new.raw_user_meta_data ->> 'legal_terms_version';
  v_privacy text := new.raw_user_meta_data ->> 'legal_privacy_version';
begin
  if v_terms ~ '^[0-9]{1,3}\.[0-9]{1,3}$' then
    insert into public.legal_acceptances (user_id, document, version, source)
    values (new.id, 'terms', v_terms, 'signup')
    on conflict (user_id, document, version) do nothing;
  end if;

  if v_privacy ~ '^[0-9]{1,3}\.[0-9]{1,3}$' then
    insert into public.legal_acceptances (user_id, document, version, source)
    values (new.id, 'privacy', v_privacy, 'signup')
    on conflict (user_id, document, version) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function private.record_signup_legal_acceptance()
from public, anon, authenticated, service_role;

create trigger on_auth_user_legal_acceptance
after insert on auth.users
for each row
execute function private.record_signup_legal_acceptance();
