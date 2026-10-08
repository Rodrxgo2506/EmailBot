-- ============================================================
-- EmailBot - Libro de Reclamaciones virtual (Culqi phase 1)
--
-- Peruvian consumer complaints book integrated in emailbot.app
-- (Reglamento del Libro de Reclamaciones, D.S. 011-2011-PCM and its
-- amendments; Anexo I "Hoja de Reclamación"): consumer, contracted good
-- (product / service, amount), RECLAMO or QUEJA, detail and request.
--
--   * public.complaint_book_entries: one row per sheet. RLS on and no
--     table privilege for anon / authenticated / service_role: written
--     and read only through the functions below.
--   * Correlative number: public.complaint_book_number_seq. nextval() is
--     atomic, so concurrent submissions never get the same number (no
--     MAX()+1). Validation runs before nextval(); a gap only appears if an
--     insert fails afterwards (a sequence never gives a number back).
--     Code shown to the consumer: LR-<year in Lima>-<number, 6 digits>.
--   * submission_id: generated once per form by the browser (or by the
--     API). Retrying the same submission returns the sheet already
--     recorded (no second number, no second e-mail).
--   * public.submit_complaint_book_entry: the API's public form
--     (service_role only; validated again here).
--
-- E-mails (sent by the API through the transactional e-mail provider;
-- the database only records their state, never their content):
--
--   * Every e-mail outcome is one of: SENT (the provider accepted it),
--     REJECTED (the provider confirmed it did NOT accept it) or UNKNOWN
--     (timeout, network error, provider 5xx or 409: it may have been
--     accepted). UNKNOWN is conservative: the e-mail stays SENDING with the
--     error code, its claim expires as usual (2 minutes after it was taken)
--     and the next attempt reuses the SAME idempotency key and the SAME
--     content, so the provider never sends it twice.
--   * The provider keeps idempotency keys 24 hours (what happens after that
--     is not documented). EmailBot only repeats an attempt with an unknown
--     outcome while its key is less than 23 hours old (1 hour of margin).
--     Past that, nothing is resent automatically: an administrator either
--     records it as sent with the provider's message id (found in the
--     provider's dashboard or in the API logs) or forces a new attempt
--     knowing it may duplicate the e-mail. Both decisions are audited.
--     Exactly-once delivery cannot be guaranteed past the provider's window;
--     a silent duplicate can.
--   * Copy of the sheet to the consumer (confirmation). The sheet is
--     recorded first and never depends on the e-mail. State:
--     PENDING -> SENDING (claimed by one sender) -> SENT | FAILED.
--     A claim is a single UPDATE (one winner); a SENDING claim older than
--     2 minutes (crashed sender or unknown outcome) can be taken again
--     inside the window. Its content only depends on the stored sheet, and
--     its idempotency key only changes with a new attempt (first send, after
--     a confirmed rejection, or forced).
--   * Provider answer (platform administrators): admin.begin_complaint_response
--     claims the sheet and starts an answer OPERATION: the text, the date of
--     the answer and the idempotency key are stored once and reused by every
--     retry of that operation (the e-mail is byte-identical). While the
--     outcome of an operation is unknown, only the same text can be sent
--     (inside the window). A new operation (new key, new date) starts only
--     after a confirmed rejection, or when an administrator forces it past
--     the window.
--     admin.record_complaint_response records the provider's outcome. The
--     case becomes RESPONDED only when the provider accepted the e-mail; its
--     responded_at is the date printed on it. Every outcome is written to
--     platform_audit_logs (actor, action, result, provider message id or
--     error code; never the text or the consumer's data).
--
-- Also: Terms and Privacy 3.0 (commercial conditions, refunds, complaints
-- book). private.current_legal_versions() mirrors @emailbot/types
-- CURRENT_LEGAL_VERSIONS; members are asked to accept again on next login.
-- ============================================================


-- ============================================================
-- Legal documents 3.0
-- ============================================================

create or replace function private.current_legal_versions(out terms text, out privacy text)
language sql
immutable
set search_path = ''
as $$
  select '3.0'::text, '3.0'::text
$$;


-- ============================================================
-- Complaints book
-- ============================================================

create sequence public.complaint_book_number_seq as bigint start with 1 increment by 1 no cycle;

revoke all on sequence public.complaint_book_number_seq from public, anon, authenticated, service_role;

create table public.complaint_book_entries (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique,
  code text not null unique,
  -- One per form submission: retries return this sheet instead of a new one.
  submission_id uuid not null unique,

  kind text not null,

  -- Consumer (reclamante).
  consumer_first_names text not null,
  consumer_last_names text not null,
  document_type text not null,
  document_number text not null,
  email text not null,
  phone text not null,
  address text not null,
  is_minor boolean not null default false,
  guardian_name text,

  -- Contracted good.
  good_type text not null,
  good_description text not null,
  claimed_amount_cents bigint,

  -- Claim.
  detail text not null,
  consumer_request text not null,

  -- Copy of the sheet e-mailed to the consumer.
  confirmation_email_status text not null default 'PENDING',
  confirmation_email_claimed_at timestamptz,
  confirmation_email_failures integer not null default 0,
  -- Current attempt (its idempotency key) and when that key was first used: unknown outcomes are retried with the
  -- same key only while it is less than 23 hours old (the provider keeps keys 24 hours).
  confirmation_email_attempt integer not null default 0,
  confirmation_email_key_used_at timestamptz,
  confirmation_email_sent_at timestamptz,
  confirmation_email_provider_id text,
  confirmation_email_error text,

  -- Provider side (EmailBot): the case is PENDING until an answer is e-mailed.
  status text not null default 'PENDING',
  -- Last answer written by an administrator (delivered only when response_email_status = SENT).
  provider_response text,
  responded_at timestamptz,
  responded_by uuid references public.profiles(id) on delete set null,
  response_email_status text,
  response_email_claimed_at timestamptz,
  response_email_failures integer not null default 0,
  -- Current answer operation: every retry reuses its key, its text and its date (same e-mail, byte for byte).
  response_operations integer not null default 0,
  response_idempotency_key text,
  response_prepared_at timestamptz,
  response_email_provider_id text,
  response_email_error text,

  request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint complaint_book_entries_kind check (kind in ('RECLAMO', 'QUEJA')),
  constraint complaint_book_entries_document_type check (document_type in ('DNI', 'CE', 'PASAPORTE', 'RUC')),
  constraint complaint_book_entries_good_type check (good_type in ('PRODUCTO', 'SERVICIO')),
  constraint complaint_book_entries_status check (status in ('PENDING', 'RESPONDED')),
  constraint complaint_book_entries_responded check (
    status <> 'RESPONDED' or (provider_response is not null and responded_at is not null and response_email_status = 'SENT')
  ),
  constraint complaint_book_entries_confirmation_attempt check (
    confirmation_email_status not in ('SENDING', 'SENT') or confirmation_email_key_used_at is not null
  ),
  constraint complaint_book_entries_response_operation check (
    response_email_status is null or (response_idempotency_key is not null and response_prepared_at is not null)
  ),
  constraint complaint_book_entries_confirmation_status check (confirmation_email_status in ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  constraint complaint_book_entries_response_status check (response_email_status is null or response_email_status in ('SENDING', 'SENT', 'FAILED')),
  constraint complaint_book_entries_email_errors check (
    (confirmation_email_error is null or confirmation_email_error ~ '^[A-Z][A-Z0-9_]{0,59}$')
    and (response_email_error is null or response_email_error ~ '^[A-Z][A-Z0-9_]{0,59}$')
  ),
  constraint complaint_book_entries_guardian check (not is_minor or guardian_name is not null),
  constraint complaint_book_entries_amount check (claimed_amount_cents is null or claimed_amount_cents between 0 and 100000000000),
  constraint complaint_book_entries_lengths check (
    char_length(consumer_first_names) between 1 and 120
    and char_length(consumer_last_names) between 1 and 120
    and char_length(document_number) between 4 and 20
    and char_length(email) between 3 and 254
    and char_length(phone) between 6 and 20
    and char_length(address) between 5 and 300
    and (guardian_name is null or char_length(guardian_name) between 3 and 200)
    and char_length(good_description) between 3 and 300
    and char_length(detail) between 10 and 5000
    and char_length(consumer_request) between 5 and 3000
    and (provider_response is null or char_length(provider_response) between 10 and 5000)
    and (confirmation_email_provider_id is null or char_length(confirmation_email_provider_id) <= 200)
    and (response_email_provider_id is null or char_length(response_email_provider_id) <= 200)
    and (response_idempotency_key is null or char_length(response_idempotency_key) <= 200)
    and (request_id is null or char_length(request_id) <= 200)
  )
);

comment on table public.complaint_book_entries is
  'Libro de Reclamaciones (virtual): one row per sheet, with the state of its e-mails (never their content). No direct access: only the complaint functions (service_role) and admin.* (platform admins).';

create index complaint_book_entries_created_idx on public.complaint_book_entries (created_at desc, number desc);

create trigger complaint_book_entries_set_updated_at
before update on public.complaint_book_entries
for each row
execute function public.set_updated_at();

alter table public.complaint_book_entries enable row level security;

revoke all on table public.complaint_book_entries from public, anon, authenticated, service_role;


-- ============================================================
-- Submission (public form through the API)
-- ============================================================

create or replace function public.submit_complaint_book_entry(
  p_submission_id uuid,
  p_kind text,
  p_first_names text,
  p_last_names text,
  p_document_type text,
  p_document_number text,
  p_email text,
  p_phone text,
  p_address text,
  p_is_minor boolean,
  p_guardian_name text,
  p_good_type text,
  p_good_description text,
  p_claimed_amount_cents bigint,
  p_detail text,
  p_consumer_request text,
  p_request_id text
)
returns table (
  id uuid,
  number bigint,
  code text,
  kind text,
  created_at timestamptz,
  confirmation_email_status text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint;
  v_created timestamptz := now();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_guardian text := nullif(trim(coalesce(p_guardian_name, '')), '');
  v_existing public.complaint_book_entries%rowtype;
begin
  if p_submission_id is null then
    raise exception 'A submission id is required';
  end if;
  if p_kind is null or p_kind not in ('RECLAMO', 'QUEJA') then
    raise exception 'Invalid complaint kind';
  end if;
  if p_document_type is null or p_document_type not in ('DNI', 'CE', 'PASAPORTE', 'RUC') then
    raise exception 'Invalid document type';
  end if;
  if p_good_type is null or p_good_type not in ('PRODUCTO', 'SERVICIO') then
    raise exception 'Invalid good type';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Invalid email';
  end if;
  if coalesce(p_is_minor, false) and v_guardian is null then
    raise exception 'A parent or guardian is required for a minor';
  end if;

  -- Retry of a submission already recorded: same sheet, no new number.
  select e.* into v_existing from public.complaint_book_entries e where e.submission_id = p_submission_id;
  if not found then
    -- Atomic correlative: concurrent submissions never share a number.
    v_number := nextval('public.complaint_book_number_seq');

    insert into public.complaint_book_entries (
      number, code, submission_id, kind,
      consumer_first_names, consumer_last_names, document_type, document_number, email, phone, address,
      is_minor, guardian_name,
      good_type, good_description, claimed_amount_cents,
      detail, consumer_request, request_id, created_at, updated_at
    )
    values (
      v_number,
      'LR-' || to_char(v_created at time zone 'America/Lima', 'YYYY') || '-' || lpad(v_number::text, 6, '0'),
      p_submission_id,
      p_kind,
      trim(p_first_names), trim(p_last_names), p_document_type, upper(trim(p_document_number)), v_email, trim(p_phone), trim(p_address),
      coalesce(p_is_minor, false), case when coalesce(p_is_minor, false) then v_guardian end,
      p_good_type, trim(p_good_description), p_claimed_amount_cents,
      trim(p_detail), trim(p_consumer_request), left(p_request_id, 200), v_created, v_created
    )
    on conflict (submission_id) do nothing;

    if found then
      return query
      select e.id, e.number, e.code, e.kind, e.created_at, e.confirmation_email_status, false
      from public.complaint_book_entries e
      where e.submission_id = p_submission_id;
      return;
    end if;

    -- Lost a race with the same submission (the number taken above stays unused).
    select e.* into v_existing from public.complaint_book_entries e where e.submission_id = p_submission_id;
  end if;

  -- The id is random; requiring the same consumer e-mail is defense in depth.
  if v_existing.email <> v_email then
    raise exception 'This submission was already registered';
  end if;

  return query
  select v_existing.id, v_existing.number, v_existing.code, v_existing.kind, v_existing.created_at, v_existing.confirmation_email_status, true;
end;
$$;

comment on function public.submit_complaint_book_entry(uuid, text, text, text, text, text, text, text, text, boolean, text, text, text, bigint, text, text, text) is
  'Registers a complaints book sheet (public form, through the API) with an atomic correlative number; a retried submission id returns the recorded sheet. service_role only.';

revoke all on function public.submit_complaint_book_entry(uuid, text, text, text, text, text, text, text, text, boolean, text, text, text, bigint, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.submit_complaint_book_entry(uuid, text, text, text, text, text, text, text, text, boolean, text, text, text, bigint, text, text, text)
to service_role;


-- ============================================================
-- Copy of the sheet e-mailed to the consumer
-- ============================================================

-- Claims the confirmation e-mail of a sheet for one sender and returns the
-- whole sheet (the e-mail is the consumer's copy). No row = nothing to send:
-- already sent, another sender is on it, or its outcome is unknown and the
-- provider's idempotency window is over (an administrator decides: confirm it
-- or force a resend, p_force).
--
-- Every new attempt (first send, after a confirmed rejection, or forced) gets
-- a new key and records when the key was first used; a crash or an unknown
-- outcome is retried with the SAME key while the key is less than 23 hours old
-- (the provider keeps keys 24 hours; 1 hour of margin for clock differences).
create or replace function private.claim_complaint_confirmation_email(p_entry_id uuid, p_force boolean default false)
returns table (
  id uuid,
  number bigint,
  code text,
  kind text,
  consumer_first_names text,
  consumer_last_names text,
  document_type text,
  document_number text,
  email text,
  phone text,
  address text,
  is_minor boolean,
  guardian_name text,
  good_type text,
  good_description text,
  claimed_amount_cents bigint,
  detail text,
  consumer_request text,
  created_at timestamptz,
  idempotency_key text
)
language sql
security invoker
set search_path = ''
as $$
  update public.complaint_book_entries e
  set confirmation_email_status = 'SENDING',
      confirmation_email_claimed_at = now(),
      confirmation_email_error = null,
      -- New attempt (new key) unless this repeats an unknown one inside the window.
      confirmation_email_attempt = case when e.confirmation_email_status = 'SENDING' and e.confirmation_email_key_used_at > now() - interval '23 hours'
                                        then e.confirmation_email_attempt else e.confirmation_email_attempt + 1 end,
      confirmation_email_key_used_at = case when e.confirmation_email_status = 'SENDING' and e.confirmation_email_key_used_at > now() - interval '23 hours'
                                            then e.confirmation_email_key_used_at else now() end
  where e.id = p_entry_id
    and (
      e.confirmation_email_status in ('PENDING', 'FAILED')
      or (
        e.confirmation_email_status = 'SENDING'
        and e.confirmation_email_claimed_at < now() - interval '2 minutes'
        and (e.confirmation_email_key_used_at > now() - interval '23 hours' or coalesce(p_force, false))
      )
    )
  returning
    e.id, e.number, e.code, e.kind,
    e.consumer_first_names, e.consumer_last_names, e.document_type, e.document_number, e.email, e.phone, e.address,
    e.is_minor, e.guardian_name,
    e.good_type, e.good_description, e.claimed_amount_cents,
    e.detail, e.consumer_request, e.created_at,
    'complaint-confirmation/' || e.id::text || '/' || e.confirmation_email_attempt::text
$$;

-- Records the outcome (SENT / REJECTED / UNKNOWN) of a claimed confirmation
-- e-mail. Returns SENT, FAILED or UNKNOWN, or null when the e-mail was not
-- being sent (nothing changes). UNKNOWN keeps the claim (it expires 2 minutes
-- after it was taken) and the idempotency key.
create or replace function private.record_complaint_confirmation_email(
  p_entry_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_code text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_error text := case when coalesce(p_error_code, '') ~ '^[A-Z][A-Z0-9_]{0,59}$' then p_error_code else 'UNKNOWN' end;
begin
  if p_outcome is null or p_outcome not in ('SENT', 'REJECTED', 'UNKNOWN') then
    raise exception 'Invalid e-mail outcome';
  end if;

  update public.complaint_book_entries e
  set confirmation_email_status = case p_outcome when 'SENT' then 'SENT' when 'REJECTED' then 'FAILED' else 'SENDING' end,
      confirmation_email_sent_at = case when p_outcome = 'SENT' then now() else e.confirmation_email_sent_at end,
      confirmation_email_provider_id = case when p_outcome = 'SENT' then left(p_provider_message_id, 200) else e.confirmation_email_provider_id end,
      confirmation_email_error = case when p_outcome = 'SENT' then null else v_error end,
      confirmation_email_failures = e.confirmation_email_failures + case when p_outcome = 'REJECTED' then 1 else 0 end,
      confirmation_email_claimed_at = case when p_outcome = 'UNKNOWN' then e.confirmation_email_claimed_at end
  where e.id = p_entry_id
    and e.confirmation_email_status = 'SENDING'
  returning case when p_outcome = 'UNKNOWN' then 'UNKNOWN' else e.confirmation_email_status end into v_status;

  return v_status;
end;
$$;

revoke all on function private.claim_complaint_confirmation_email(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.record_complaint_confirmation_email(uuid, text, text, text) from public, anon, authenticated, service_role;

-- Public path (right after the consumer submits the form): service_role only. Never forces.
create or replace function public.claim_complaint_confirmation_email(p_entry_id uuid)
returns table (
  id uuid,
  number bigint,
  code text,
  kind text,
  consumer_first_names text,
  consumer_last_names text,
  document_type text,
  document_number text,
  email text,
  phone text,
  address text,
  is_minor boolean,
  guardian_name text,
  good_type text,
  good_description text,
  claimed_amount_cents bigint,
  detail text,
  consumer_request text,
  created_at timestamptz,
  idempotency_key text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.claim_complaint_confirmation_email(p_entry_id, false)
$$;

create or replace function public.record_complaint_confirmation_email(
  p_entry_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_code text
)
returns text
language sql
security definer
set search_path = ''
as $$
  select private.record_complaint_confirmation_email(p_entry_id, p_outcome, p_provider_message_id, p_error_code)
$$;

comment on function public.claim_complaint_confirmation_email(uuid) is
  'Claims the copy e-mail of a complaints book sheet for one sender and returns the sheet (never past the idempotency window of an unknown attempt). service_role only.';
comment on function public.record_complaint_confirmation_email(uuid, text, text, text) is
  'Records the provider outcome of a claimed complaints book copy e-mail (SENT / REJECTED / UNKNOWN). service_role only.';

revoke all on function public.claim_complaint_confirmation_email(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_complaint_confirmation_email(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_complaint_confirmation_email(uuid) to service_role;
grant execute on function public.record_complaint_confirmation_email(uuid, text, text, text) to service_role;


-- ============================================================
-- Platform administration
-- ============================================================

create or replace function admin.list_complaint_book_entries(
  p_actor_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  number bigint,
  code text,
  kind text,
  status text,
  consumer_first_names text,
  consumer_last_names text,
  document_type text,
  document_number text,
  email text,
  phone text,
  address text,
  is_minor boolean,
  guardian_name text,
  good_type text,
  good_description text,
  claimed_amount_cents bigint,
  detail text,
  consumer_request text,
  confirmation_email_status text,
  confirmation_email_sent_at timestamptz,
  confirmation_email_error text,
  confirmation_decision_required boolean,
  provider_response text,
  response_email_status text,
  response_email_error text,
  response_decision_required boolean,
  responded_at timestamptz,
  responded_by_email text,
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
    e.id, e.number, e.code, e.kind, e.status,
    e.consumer_first_names, e.consumer_last_names, e.document_type, e.document_number, e.email, e.phone, e.address,
    e.is_minor, e.guardian_name,
    e.good_type, e.good_description, e.claimed_amount_cents,
    e.detail, e.consumer_request,
    e.confirmation_email_status, e.confirmation_email_sent_at, e.confirmation_email_error,
    -- Unknown outcome past the provider's idempotency window: no automatic resend, an administrator decides.
    (e.confirmation_email_status = 'SENDING'
      and e.confirmation_email_claimed_at < now() - interval '2 minutes'
      and e.confirmation_email_key_used_at <= now() - interval '23 hours'),
    e.provider_response, e.response_email_status, e.response_email_error,
    (e.response_email_status = 'SENDING'
      and e.response_email_claimed_at < now() - interval '2 minutes'
      and e.response_prepared_at <= now() - interval '23 hours'),
    e.responded_at, p.email,
    e.created_at
  from public.complaint_book_entries e
  left join public.profiles p on p.id = e.responded_by
  order by e.number desc
  limit v_limit
  offset v_offset;
end;
$$;

comment on function admin.list_complaint_book_entries(uuid, integer, integer) is
  'Complaints book sheets, newest first, with the state of their e-mails. Platform administrators only (checked here). service_role only.';

revoke all on function admin.list_complaint_book_entries(uuid, integer, integer) from public, anon, authenticated, service_role;
grant execute on function admin.list_complaint_book_entries(uuid, integer, integer) to service_role;


-- Sending the consumer's copy again (the first attempt failed, never ran, or
-- its outcome is unknown). p_force: after the provider's idempotency window an
-- unknown attempt is only sent again on purpose (it may duplicate the copy);
-- that decision is audited.
create or replace function admin.claim_complaint_confirmation_email(p_actor_id uuid, p_entry_id uuid, p_force boolean default false)
returns table (
  id uuid,
  number bigint,
  code text,
  kind text,
  consumer_first_names text,
  consumer_last_names text,
  document_type text,
  document_number text,
  email text,
  phone text,
  address text,
  is_minor boolean,
  guardian_name text,
  good_type text,
  good_description text,
  claimed_amount_cents bigint,
  detail text,
  consumer_request text,
  created_at timestamptz,
  idempotency_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.complaint_book_entries%rowtype;
  v_forced boolean;
begin
  perform private.assert_platform_admin(p_actor_id);

  select e.* into v_entry from public.complaint_book_entries e where e.id = p_entry_id for update;
  if not found then
    return;
  end if;
  v_forced := coalesce(p_force, false)
    and v_entry.confirmation_email_status = 'SENDING'
    and v_entry.confirmation_email_claimed_at < now() - interval '2 minutes'
    and v_entry.confirmation_email_key_used_at <= now() - interval '23 hours';

  return query select * from private.claim_complaint_confirmation_email(p_entry_id, p_force);

  if found and v_forced then
    insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, metadata)
    values (
      p_actor_id,
      'complaint_book.confirmation_resend_forced',
      'complaint_book_entry',
      p_entry_id,
      jsonb_build_object('code', v_entry.code, 'previousAttempt', v_entry.confirmation_email_attempt)
    );
  end if;
end;
$$;

create or replace function admin.record_complaint_confirmation_email(
  p_actor_id uuid,
  p_entry_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_code text,
  p_request_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_entry public.complaint_book_entries%rowtype;
begin
  perform private.assert_platform_admin(p_actor_id);

  v_status := private.record_complaint_confirmation_email(p_entry_id, p_outcome, p_provider_message_id, p_error_code);
  if v_status is null then
    return null;
  end if;

  select e.* into v_entry from public.complaint_book_entries e where e.id = p_entry_id;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, metadata, request_id)
  values (
    p_actor_id,
    case v_status
      when 'SENT' then 'complaint_book.confirmation_resent'
      when 'UNKNOWN' then 'complaint_book.confirmation_uncertain'
      else 'complaint_book.confirmation_failed'
    end,
    'complaint_book_entry',
    p_entry_id,
    jsonb_strip_nulls(jsonb_build_object(
      'code', v_entry.code,
      'result', v_status,
      'providerMessageId', case when v_status = 'SENT' then v_entry.confirmation_email_provider_id end,
      'errorCode', v_entry.confirmation_email_error
    )),
    left(p_request_id, 200)
  );

  return v_status;
end;
$$;

-- An administrator found the e-mail of an attempt with an unknown outcome in
-- the provider (dashboard, or the id logged when it was accepted): records it
-- as sent with that provider id. Only for an attempt whose claim expired (no
-- sender is on it). Audited as a manual confirmation.
create or replace function admin.confirm_complaint_confirmation_email(
  p_actor_id uuid,
  p_entry_id uuid,
  p_provider_message_id text,
  p_request_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := trim(coalesce(p_provider_message_id, ''));
  v_code text;
begin
  perform private.assert_platform_admin(p_actor_id);

  if v_id !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'Invalid provider message id';
  end if;

  update public.complaint_book_entries e
  set confirmation_email_status = 'SENT',
      confirmation_email_sent_at = e.confirmation_email_key_used_at,
      confirmation_email_provider_id = v_id,
      confirmation_email_error = null,
      confirmation_email_claimed_at = null
  where e.id = p_entry_id
    and e.confirmation_email_status = 'SENDING'
    and e.confirmation_email_claimed_at < now() - interval '2 minutes'
  returning e.code into v_code;

  if not found then
    return 'NOT_UNCERTAIN';
  end if;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, metadata, request_id)
  values (
    p_actor_id,
    'complaint_book.confirmation_confirmed_manually',
    'complaint_book_entry',
    p_entry_id,
    jsonb_build_object('code', v_code, 'result', 'SENT', 'providerMessageId', v_id),
    left(p_request_id, 200)
  );
  return 'CONFIRMED';
end;
$$;


-- Answering a sheet: claim + store the text, then record the provider outcome.
--
-- Outcomes: NOT_FOUND, ALREADY_RESPONDED, IN_PROGRESS (a sender is on it),
-- TEXT_LOCKED (the previous answer may have been delivered: only the same text
-- can be retried, inside the provider's idempotency window), NEEDS_DECISION
-- (unknown outcome past that window: no automatic resend; an administrator
-- confirms it was sent or forces a new operation with p_force, audited) and
-- READY (with the operation to send).
create or replace function admin.begin_complaint_response(
  p_actor_id uuid,
  p_entry_id uuid,
  p_response text,
  p_force boolean default false
)
returns table (
  outcome text,
  id uuid,
  code text,
  kind text,
  consumer_first_names text,
  consumer_last_names text,
  email text,
  created_at timestamptz,
  response text,
  prepared_at timestamptz,
  idempotency_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text text := trim(coalesce(p_response, ''));
  v_entry public.complaint_book_entries%rowtype;
begin
  perform private.assert_platform_admin(p_actor_id);

  if char_length(v_text) < 10 or char_length(v_text) > 5000 then
    raise exception 'The answer must have between 10 and 5000 characters';
  end if;

  select e.* into v_entry from public.complaint_book_entries e where e.id = p_entry_id for update;

  if not found then
    outcome := 'NOT_FOUND';
    return next;
    return;
  end if;
  if v_entry.status = 'RESPONDED' then
    outcome := 'ALREADY_RESPONDED';
    return next;
    return;
  end if;
  if v_entry.response_email_status = 'SENDING' and v_entry.response_email_claimed_at >= now() - interval '2 minutes' then
    outcome := 'IN_PROGRESS';
    return next;
    return;
  end if;

  if v_entry.response_email_status = 'SENDING' and v_entry.response_prepared_at > now() - interval '23 hours' then
    -- The previous attempt crashed or its outcome is unknown, inside the provider's idempotency window.
    if v_entry.provider_response is distinct from v_text then
      -- Another text could reach the consumer as a second answer.
      outcome := 'TEXT_LOCKED';
      return next;
      return;
    end if;
    -- Same operation (same key, same date, same text: the same e-mail); the provider does not send it twice.
    update public.complaint_book_entries e
    set response_email_claimed_at = now(),
        response_email_error = null
    where e.id = p_entry_id;
  elsif v_entry.response_email_status = 'SENDING' and not coalesce(p_force, false) then
    -- Unknown outcome past the window: the provider may no longer deduplicate. Never resend automatically.
    outcome := 'NEEDS_DECISION';
    return next;
    return;
  else
    if v_entry.response_email_status = 'SENDING' then
      -- Forced by an administrator past the window (may duplicate the answer): audited.
      insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, metadata)
      values (
        p_actor_id,
        'complaint_book.response_resend_forced',
        'complaint_book_entry',
        p_entry_id,
        jsonb_build_object('code', v_entry.code, 'previousOperation', v_entry.response_operations)
      );
    end if;
    -- New operation: first answer, after a confirmed rejection, or forced.
    update public.complaint_book_entries e
    set provider_response = v_text,
        response_operations = e.response_operations + 1,
        response_idempotency_key = 'complaint-response/' || e.id::text || '/' || (e.response_operations + 1)::text,
        response_prepared_at = now(),
        response_email_status = 'SENDING',
        response_email_claimed_at = now(),
        response_email_error = null
    where e.id = p_entry_id;
  end if;

  select e.* into v_entry from public.complaint_book_entries e where e.id = p_entry_id;

  outcome := 'READY';
  id := v_entry.id;
  code := v_entry.code;
  kind := v_entry.kind;
  consumer_first_names := v_entry.consumer_first_names;
  consumer_last_names := v_entry.consumer_last_names;
  email := v_entry.email;
  created_at := v_entry.created_at;
  response := v_entry.provider_response;
  prepared_at := v_entry.response_prepared_at;
  idempotency_key := v_entry.response_idempotency_key;
  return next;
end;
$$;

create or replace function admin.record_complaint_response(
  p_actor_id uuid,
  p_entry_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_code text,
  p_request_id text
)
returns table (
  status text,
  response_email_status text,
  responded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_error text := case when coalesce(p_error_code, '') ~ '^[A-Z][A-Z0-9_]{0,59}$' then p_error_code else 'UNKNOWN' end;
  v_code text;
  v_status text;
  v_email_status text;
  v_responded_at timestamptz;
begin
  perform private.assert_platform_admin(p_actor_id);

  if p_outcome is null or p_outcome not in ('SENT', 'REJECTED', 'UNKNOWN') then
    raise exception 'Invalid e-mail outcome';
  end if;

  -- SENT: RESPONDED, dated as printed on the e-mail. REJECTED: retryable with a new operation. UNKNOWN: stays
  -- SENDING (claim kept until it expires) so the next attempt repeats the same operation.
  update public.complaint_book_entries e
  set status = case when p_outcome = 'SENT' then 'RESPONDED' else e.status end,
      responded_at = case when p_outcome = 'SENT' then e.response_prepared_at else e.responded_at end,
      responded_by = case when p_outcome = 'SENT' then p_actor_id else e.responded_by end,
      response_email_status = case p_outcome when 'SENT' then 'SENT' when 'REJECTED' then 'FAILED' else 'SENDING' end,
      response_email_provider_id = case when p_outcome = 'SENT' then left(p_provider_message_id, 200) else e.response_email_provider_id end,
      response_email_error = case when p_outcome = 'SENT' then null else v_error end,
      response_email_failures = e.response_email_failures + case when p_outcome = 'REJECTED' then 1 else 0 end,
      response_email_claimed_at = case when p_outcome = 'UNKNOWN' then e.response_email_claimed_at end
  where e.id = p_entry_id
    and e.response_email_status = 'SENDING'
  returning e.code, e.status, e.response_email_status, e.responded_at
  into v_code, v_status, v_email_status, v_responded_at;

  if not found then
    return;
  end if;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, metadata, request_id)
  values (
    p_actor_id,
    case p_outcome
      when 'SENT' then 'complaint_book.response_sent'
      when 'UNKNOWN' then 'complaint_book.response_uncertain'
      else 'complaint_book.response_failed'
    end,
    'complaint_book_entry',
    p_entry_id,
    jsonb_strip_nulls(jsonb_build_object(
      'code', v_code,
      'result', p_outcome,
      'providerMessageId', case when p_outcome = 'SENT' then left(p_provider_message_id, 200) end,
      'errorCode', case when p_outcome = 'SENT' then null else v_error end
    )),
    left(p_request_id, 200)
  );

  status := v_status;
  response_email_status := v_email_status;
  responded_at := v_responded_at;
  return next;
end;
$$;

-- An administrator found the answer e-mail of an operation with an unknown
-- outcome in the provider (dashboard, or the id logged when it was accepted):
-- RESPONDED with that provider id, dated as printed on the e-mail. Only for an
-- operation whose claim expired. Audited as a manual confirmation.
create or replace function admin.confirm_complaint_response(
  p_actor_id uuid,
  p_entry_id uuid,
  p_provider_message_id text,
  p_request_id text
)
returns table (
  outcome text,
  status text,
  responded_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := trim(coalesce(p_provider_message_id, ''));
  v_code text;
  v_status text;
  v_responded_at timestamptz;
begin
  perform private.assert_platform_admin(p_actor_id);

  if v_id !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'Invalid provider message id';
  end if;

  update public.complaint_book_entries e
  set status = 'RESPONDED',
      responded_at = e.response_prepared_at,
      responded_by = p_actor_id,
      response_email_status = 'SENT',
      response_email_provider_id = v_id,
      response_email_error = null,
      response_email_claimed_at = null
  where e.id = p_entry_id
    and e.response_email_status = 'SENDING'
    and e.response_email_claimed_at < now() - interval '2 minutes'
  returning e.code, e.status, e.responded_at into v_code, v_status, v_responded_at;

  if not found then
    outcome := 'NOT_UNCERTAIN';
    return next;
    return;
  end if;

  insert into public.platform_audit_logs (actor_user_id, action, target_type, target_id, metadata, request_id)
  values (
    p_actor_id,
    'complaint_book.response_confirmed_manually',
    'complaint_book_entry',
    p_entry_id,
    jsonb_build_object('code', v_code, 'result', 'SENT', 'providerMessageId', v_id),
    left(p_request_id, 200)
  );

  outcome := 'CONFIRMED';
  status := v_status;
  responded_at := v_responded_at;
  return next;
end;
$$;

comment on function admin.claim_complaint_confirmation_email(uuid, uuid, boolean) is
  'Platform administrators: claims a complaints book copy e-mail to send it again (p_force: past the idempotency window of an unknown attempt; audited). service_role only.';
comment on function admin.record_complaint_confirmation_email(uuid, uuid, text, text, text, text) is
  'Platform administrators: records the outcome of a resent copy e-mail and audits it. service_role only.';
comment on function admin.confirm_complaint_confirmation_email(uuid, uuid, text, text) is
  'Platform administrators: records a copy e-mail with an unknown outcome as sent, with the provider id found by the administrator (audited). service_role only.';
comment on function admin.begin_complaint_response(uuid, uuid, text, boolean) is
  'Platform administrators: starts or repeats an answer operation (text, date and idempotency key fixed per operation); no automatic resend past the idempotency window (p_force, audited). service_role only.';
comment on function admin.record_complaint_response(uuid, uuid, text, text, text, text) is
  'Platform administrators: records the provider outcome of an answer e-mail (SENT / REJECTED / UNKNOWN; RESPONDED only when SENT) and audits it. service_role only.';
comment on function admin.confirm_complaint_response(uuid, uuid, text, text) is
  'Platform administrators: records an answer with an unknown outcome as sent, with the provider id found by the administrator (audited). service_role only.';

revoke all on function admin.claim_complaint_confirmation_email(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function admin.record_complaint_confirmation_email(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function admin.confirm_complaint_confirmation_email(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function admin.begin_complaint_response(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function admin.record_complaint_response(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function admin.confirm_complaint_response(uuid, uuid, text, text) from public, anon, authenticated, service_role;

grant execute on function admin.claim_complaint_confirmation_email(uuid, uuid, boolean) to service_role;
grant execute on function admin.record_complaint_confirmation_email(uuid, uuid, text, text, text, text) to service_role;
grant execute on function admin.confirm_complaint_confirmation_email(uuid, uuid, text, text) to service_role;
grant execute on function admin.begin_complaint_response(uuid, uuid, text, boolean) to service_role;
grant execute on function admin.record_complaint_response(uuid, uuid, text, text, text, text) to service_role;
grant execute on function admin.confirm_complaint_response(uuid, uuid, text, text) to service_role;
