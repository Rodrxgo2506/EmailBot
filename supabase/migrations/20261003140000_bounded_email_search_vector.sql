-- ============================================================
-- EmailBot - Migration 8
--
-- Bounded full-text search document for public.emails.
--
-- Why: private.update_email_search_vector() (migration 3) indexed the
-- WHOLE text_body. PostgreSQL rejects a tsvector whose lexeme data
-- exceeds 1 MB:
--
--   ERROR: string is too long for tsvector (6397504 bytes, max 1048575 bytes)
--
-- The BEFORE INSERT trigger failed, so the worker could never store an
-- email with a large text body: the job failed on every retry and the
-- message was lost.
--
-- Fix: only the first 50,000 characters of the search document are
-- indexed. The document keeps its order of relevance:
--
--   subject, sender email, sender name, snippet, text body
--
-- so the metadata (<= ~3,500 characters by the check constraints of
-- migration 3) is always indexed and the body fills the rest.
-- text_body itself is NOT modified: the full body is still stored.
--
-- Why 50,000 characters is safe: the limit applies to the lexeme bytes
-- plus their positions (about lexeme length + 5 bytes per distinct
-- lexeme). A character is at most 4 bytes in UTF-8 and the default
-- parser can emit a compound word and its parts (e.g. "x-y" -> "x-y",
-- "x", "y"), so the measured worst case is about 7.5 bytes per input
-- character (hyphenated 4-byte CJK words; ~4.5 for plain distinct
-- words, ~0.1 for real prose). 50,000 characters therefore stay below
-- ~375 KB, about 36% of the 1,048,575-byte limit.
--
-- Search is unchanged for anything inside the indexed window. Rows
-- already stored keep their vector until one of the trigger columns is
-- updated (production has no emails yet).
--
-- Same signature, owner, SECURITY DEFINER and search_path as migration
-- 3. CREATE OR REPLACE keeps the existing privileges; the REVOKE below
-- restates them.
-- ============================================================

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
      left(
        concat_ws(
          ' ',
          coalesce(new.subject, ''),
          coalesce(new.sender_email, ''),
          coalesce(new.sender_name, ''),
          coalesce(new.snippet, ''),
          coalesce(new.text_body, '')
        ),
        50000
      )
    );

  return new;
end;
$$;


revoke all on function private.update_email_search_vector()
from public, anon, authenticated;


comment on function private.update_email_search_vector() is
  'Maintains the full-text search vector for email content. Indexes the first 50,000 characters of subject, sender, snippet and text body (tsvector 1 MB limit); text_body is stored in full.';
