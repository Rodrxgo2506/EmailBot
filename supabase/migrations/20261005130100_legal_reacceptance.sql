-- ============================================================
-- EmailBot V2 - Phase 7: acceptance of the current legal versions after login
--
-- Users without an acceptance of the CURRENT versions (existing users,
-- accounts created by an administrator or outside the web sign-up, or users
-- who accepted an older version) are asked to accept them before using the
-- panel. The API records that acceptance:
--   - for the user of the verified access token (never a user id from the
--     request body);
--   - with the versions configured on the server (@emailbot/types
--     CURRENT_LEGAL_VERSIONS), never versions chosen by the client;
--   - with the DATABASE time: service_role may only insert user_id, document,
--     version and source, so accepted_at (and id) always take their defaults.
--
-- Lifecycle (unchanged trigger): rows cannot be modified while the account
-- exists (UPDATE always refused, DELETE refused while the user exists) and are
-- deleted together with the user through ON DELETE CASCADE.
-- Additive: a new allowed `source` value and two minimal grants.
--
-- RLS template:
--   SELECT  service_role only (the API reads the caller's rows).
--   INSERT  service_role only, columns user_id, document, version, source.
--   UPDATE / DELETE  nobody (trigger; DELETE only by the user cascade).
--   anon / authenticated: nothing. Cross-organization: n/a (per user).
-- ============================================================

alter table public.legal_acceptances
  drop constraint legal_acceptances_source;

alter table public.legal_acceptances
  add constraint legal_acceptances_source
    check (source in ('signup', 'reacceptance'));

-- Precise description (replaces "Append-only"): rows are never modified, but
-- they are deleted together with the user.
comment on table public.legal_acceptances is
  'Versions of the Terms and Privacy Policy accepted by each user and when (database time). Rows cannot be modified while the account exists; they are deleted together with the user (ON DELETE CASCADE).';

comment on column public.legal_acceptances.source is
  'signup: recorded from the sign-up metadata; reacceptance: accepted after login through the API.';

grant select on table public.legal_acceptances to service_role;

grant insert (user_id, document, version, source)
on table public.legal_acceptances
to service_role;
