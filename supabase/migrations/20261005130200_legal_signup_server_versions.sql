-- ============================================================
-- EmailBot V2 - Phase 7: sign-up acceptance with the SERVER's versions
--
-- Sign-up goes straight to Supabase Auth (not through the API), so this
-- trigger is the server side of the sign-up acceptance. The browser only
-- states that the user accepted (raw_user_meta_data.legal_accepted = true,
-- a JSON boolean); the versions recorded are the current ones defined here.
-- Any version sent by the client (legal_terms_version, legal_privacy_version
-- or anything else) is ignored: it can neither record an older version nor a
-- future one.
--
-- private.current_legal_versions() mirrors @emailbot/types
-- CURRENT_LEGAL_VERSIONS, the single source used by the web app and the API.
-- Publishing a new version = change that constant AND add a migration that
-- replaces this function. packages/database/test/legal-acceptances.test.ts
-- fails if both differ; if they ever did in production, new users would
-- simply be asked to accept again after login (the API checks the constant).
--
-- Additive: one new function and the replacement of the trigger function
-- (same name, owner and grants; the trigger itself is unchanged).
-- ============================================================

create or replace function private.current_legal_versions(out terms text, out privacy text)
language sql
immutable
set search_path = ''
as $$
  select '2.0'::text, '2.0'::text
$$;

comment on function private.current_legal_versions() is
  'Current legal versions for the sign-up trigger. Mirror of @emailbot/types CURRENT_LEGAL_VERSIONS (tested).';

revoke all on function private.current_legal_versions()
from public, anon, authenticated, service_role;


create or replace function private.record_signup_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current record;
begin
  -- Only an explicit JSON `true` counts ("true", 1, objects... do not).
  if (new.raw_user_meta_data -> 'legal_accepted') is distinct from 'true'::jsonb then
    return new;
  end if;

  select * into v_current from private.current_legal_versions();

  insert into public.legal_acceptances (user_id, document, version, source)
  values
    (new.id, 'terms', v_current.terms, 'signup'),
    (new.id, 'privacy', v_current.privacy, 'signup')
  on conflict (user_id, document, version) do nothing;

  return new;
end;
$$;

revoke all on function private.record_signup_legal_acceptance()
from public, anon, authenticated, service_role;
