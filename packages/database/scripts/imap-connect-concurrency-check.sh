#!/usr/bin/env bash
# REAL concurrency check of public.connect_imap_email_account (IMAP E1: plan feature + EMAIL_ACCOUNTS
# limit under a per-organization lock). Same method as connect-concurrency-check.sh (OAuth): PGlite
# has a single connection, so overlapping transactions are only possible against a real PostgreSQL.
#
# Safe by construction: it creates a THROWAWAY database ($DB) in the LOCAL Supabase container, applies
# the repo's migrations there and drops it at the end. The stack's own "postgres" database is never
# touched. Never point it at a remote project.
#
#   1. platform shim + every migration of supabase/migrations;
#   2. control function connect_imap_nolock = the same function WITHOUT the organization lock;
#   3. overlapping service_role sessions (each keeps its transaction open with pg_sleep after the call):
#        limit 1 / 2 sessions and limit 2 / 3 sessions with the real function and with the control;
#        a Gmail mailbox + an IMAP mailbox racing for the last slot (shared EMAIL_ACCOUNTS);
#        the same address twice (one row);
#   4. exit 0 only if the real function respects every limit AND the control exceeds them (the race is real).
#
# Usage: packages/database/scripts/imap-connect-concurrency-check.sh   (env: SUPABASE_DB_CONTAINER, default supabase_db_EmailBot)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$REPO/supabase/migrations/20261014120000_imap_e1_security.sql"
C="${SUPABASE_DB_CONTAINER:-supabase_db_EmailBot}"
DB=emailbot_imap_connect_concurrency
PASSWORD_V2="v2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Q0lQSEVSVEVYVA"
failures=0

psql_db() { docker exec -i "$C" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -At -q "$@"; }
cleanup() { docker exec -i "$C" psql -U postgres -d postgres -q -c "drop database if exists $DB with (force)" >/dev/null 2>&1; }

docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "container $C is not running (supabase start)"; exit 2; }
trap cleanup EXIT
cleanup
docker exec -i "$C" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c "create database $DB" || exit 2

# Platform shim (anon / authenticated / service_role already exist in the cluster), like packages/database/src/harness.ts.
psql_db <<'SQL' || exit 2
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create table storage.buckets (id text primary key, name text not null unique, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant all on all tables in schema storage to service_role;
alter default privileges in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public;
SQL

for file in "$REPO"/supabase/migrations/*.sql; do
  psql_db < "$file" >/dev/null || { echo "migration failed: $(basename "$file")"; exit 2; }
done
echo "PostgreSQL $(psql_db -c 'show server_version'): migrations applied to $DB"

# Control: only the function body, renamed and without the organization lock (only in this throwaway database).
# tr: a Windows checkout may hold the migration with CRLF; the anchored patterns need LF (the file is only read).
tr -d '\r' < "$MIGRATION" \
  | awk '/^create or replace function public\.connect_imap_email_account\(/,/^\$\$;$/' \
  | sed -e 's/public\.connect_imap_email_account/public.connect_imap_nolock/g' -e 's/^  for no key update;$/  ;/' | psql_db >/dev/null || exit 2
psql_db -c "grant execute on function public.connect_imap_nolock(uuid, text, text, text, text, integer, text, text, text) to service_role" >/dev/null || exit 2
[ "$(psql_db -c "select position('for no key update' in prosrc) > 0 from pg_proc where proname = 'connect_imap_nolock'")" = "f" ] || { echo "control still locks"; exit 2; }

new_org() {
  psql_db <<SQL | tail -1
insert into auth.users (id, email) values (gen_random_uuid(), '$1@owner.test');
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = '$1@owner.test'), false);
set role authenticated;
select public.create_organization('Org $1', 'org-$1');
reset role;
select private.activate_subscription(
  (select id from public.organizations where slug = 'org-$1'),
  (select p.id from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id where c.code = 'BUSINESS' and p.billing_period = 'MONTHLY' and p.active),
  'MANUAL', 'ADMIN', now() - interval '1 day', now() + interval '1 month', null, 'PEN', null, null, null, 'concurrency-check') is not null;
select id from public.organizations where slug = 'org-$1';
SQL
}

set_limit() {
  psql_db -c "update public.plan_entitlements e set limit_value = $1 from public.plan_catalog c where c.id = e.plan_id and c.code = 'BUSINESS' and e.key = 'EMAIL_ACCOUNTS'" >/dev/null
}

# One API request = one service_role session; the transaction stays open $4 s after the call.
session() {
  docker exec -i "$C" psql -U postgres -d "$DB" -At -q -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -v '^$' | sed "s/^/    [$5] /"
set role service_role;
begin;
select to_char(clock_timestamp(), 'HH24:MI:SS.MS') || ' ' || outcome
from public.$1('$2', '$3', null, '$3', 'imap.example-mail.com', 993, 'TLS', '$PASSWORD_V2', null);
select pg_sleep($4);
commit;
SQL
}

gmail_session() {
  docker exec -i "$C" psql -U postgres -d "$DB" -At -q -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -v '^$' | sed "s/^/    [$4] /"
set role service_role;
begin;
select to_char(clock_timestamp(), 'HH24:MI:SS.MS') || ' gmail ' || outcome from public.connect_oauth_email_account('$1', 'GMAIL', '$2', null, null, 'v1.a', 'v1.r', null, '1');
select pg_sleep($3);
commit;
SQL
}

counted() { psql_db -c "select count(*) from public.email_accounts where organization_id = '$1' and status <> 'DISCONNECTED'"; }

# race <function> <limit> <sessions> <label> <expected rows>
race() {
  set_limit "$2"
  local org pids=() rows
  org=$(new_org "$4")
  echo "== $4: $1, limit $2, $3 overlapping sessions"
  for index in $(seq 1 "$3"); do
    session "$1" "$org" "box$index@example-mail.com" 2 "s$index" &
    pids+=($!)
    sleep 0.3
  done
  wait "${pids[@]}"
  rows=$(counted "$org")
  if [ "$rows" = "$5" ]; then echo "   mailboxes: $rows (expected $5) OK"; else echo "   mailboxes: $rows (expected $5) FAIL"; failures=$((failures + 1)); fi
}

race connect_imap_email_account 1 2 imap-lock-limit-1 1
race connect_imap_email_account 2 3 imap-lock-limit-2 2
race connect_imap_nolock 1 2 imap-control-limit-1 2
race connect_imap_nolock 2 3 imap-control-limit-2 3

set_limit 1
org=$(new_org mixed)
echo "== mixed: a Gmail and an IMAP mailbox race for the last slot (limit 1)"
session connect_imap_email_account "$org" "imap@example-mail.com" 2 imap & p1=$!
sleep 0.3
gmail_session "$org" "gmail@example.com" 0 gmail & p2=$!
wait $p1 $p2
rows=$(counted "$org")
if [ "$rows" = "1" ]; then echo "   mailboxes: $rows (expected 1) OK"; else echo "   mailboxes: $rows (expected 1) FAIL"; failures=$((failures + 1)); fi

set_limit 5
org=$(new_org same-address)
echo "== same-address: Same@Example-Mail.com and same@example-mail.com at the same time"
session connect_imap_email_account "$org" "Same@Example-Mail.com" 2 s1 & p1=$!
sleep 0.3
session connect_imap_email_account "$org" "same@example-mail.com" 0 s2 & p2=$!
wait $p1 $p2
rows=$(psql_db -c "select count(*) || ' ' || string_agg(email_address || ':' || status, ',') from public.email_accounts where organization_id = '$org'")
if [ "$rows" = "1 same@example-mail.com:PAUSED" ]; then echo "   rows: $rows OK"; else echo "   rows: $rows FAIL"; failures=$((failures + 1)); fi

echo "dropping $DB"
if [ "$failures" -eq 0 ]; then echo "RESULT: OK"; else echo "RESULT: $failures FAILED"; exit 1; fi
