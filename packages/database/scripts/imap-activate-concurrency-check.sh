#!/usr/bin/env bash
# REAL concurrency check of public.activate_imap_email_account (IMAP M1) against reconnection and
# disconnection. Same method as imap-connect-concurrency-check.sh: PGlite has a single connection, so
# overlapping transactions are only possible against a real PostgreSQL.
#
# Safe by construction: it creates a THROWAWAY database ($DB) in a LOCAL PostgreSQL container ($C),
# applies the repo's migrations there and drops it at the end. Point $C at a throwaway container (e.g. one
# started from the local supabase/postgres image for this check); never at a remote project.
#
# Each "API request" is one service_role session whose transaction stays open (pg_sleep) after the call:
#   1. reconnect (connect_imap_email_account) holding its transaction, then activate: the activation waits
#      for the organization lock and activates the reconnected (PAUSED) mailbox;
#   2. activate holding its transaction, then reconnect: the reconnection waits; the mailbox ends PAUSED
#      with IMAP_ACTIVATION_PENDING (an explicit activation is needed again);
#   3. activate holding its transaction, then disconnect (the API's UPDATE): the disconnection waits for the
#      row lock and wins; DISCONNECTED, password and cursor cleared;
#   4. disconnect holding its transaction, then activate: the activation waits and answers DISCONNECTED;
#   5. two activations at once: exactly one ACTIVATED and one ALREADY_ACTIVE;
#   6. (M1.4, H1) the worker marks the mailbox ERROR (its markError UPDATE) holding its transaction, then
#      activate: the activation waits and answers RECONNECT_REQUIRED; the mailbox stays ERROR.
# Exit 0 only if every final state is the expected one AND every second session really waited.
#
# Usage: packages/database/scripts/imap-activate-concurrency-check.sh   (env: SUPABASE_DB_CONTAINER, default supabase_db_EmailBot)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
C="${SUPABASE_DB_CONTAINER:-supabase_db_EmailBot}"
DB=emailbot_imap_activate_concurrency
PASSWORD_V2="v2.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Q0lQSEVSVEVYVA"
HOLD=2
failures=0

psql_db() { docker exec -i "$C" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -At -q "$@"; }
cleanup() { docker exec -i "$C" psql -U postgres -d postgres -q -c "drop database if exists $DB with (force)" >/dev/null 2>&1; }

docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "container $C is not running"; exit 2; }
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

# A PRO organization with one connected (PAUSED) IMAP mailbox; prints "<org id> <mailbox id>".
new_mailbox() {
  psql_db <<SQL | tail -1
insert into auth.users (id, email) values (gen_random_uuid(), '$1@owner.test');
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = '$1@owner.test'), false);
set role authenticated;
select public.create_organization('Org $1', 'org-$1');
reset role;
select private.activate_subscription(
  (select id from public.organizations where slug = 'org-$1'),
  (select p.id from public.plan_prices p join public.plan_catalog c on c.id = p.plan_id where c.code = 'PRO' and p.billing_period = 'MONTHLY' and p.active),
  'MANUAL', 'ADMIN', now() - interval '1 day', now() + interval '1 month', null, 'PEN', null, null, null, 'concurrency-check') is not null;
select id as org from public.organizations where slug = 'org-$1' \gset
set role service_role;
select :'org' || ' ' || email_account_id
from public.connect_imap_email_account(:'org', '$1@example-mail.com', null, '$1@example-mail.com', 'imap.example-mail.com', 993, 'TLS', '$PASSWORD_V2', 'imap:v1:7:120');
SQL
}

# Each session prints "<epoch ms when the call returned> <label> <outcome>" and keeps its transaction open $3 s.
activate_session() {
  docker exec -i "$C" psql -U postgres -d "$DB" -At -q -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -v '^$'
set role service_role;
begin;
select floor(extract(epoch from clock_timestamp()) * 1000)::bigint || ' $4 ' || outcome from public.activate_imap_email_account('$1', '$2');
select pg_sleep($3);
commit;
SQL
}
reconnect_session() {
  docker exec -i "$C" psql -U postgres -d "$DB" -At -q -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -v '^$'
set role service_role;
begin;
select floor(extract(epoch from clock_timestamp()) * 1000)::bigint || ' $4 ' || outcome
from public.connect_imap_email_account('$1', '$2@example-mail.com', null, '$2@example-mail.com', 'imap.example-mail.com', 993, 'TLS', '$PASSWORD_V2', 'imap:v1:7:999');
select pg_sleep($3);
commit;
SQL
}
disconnect_session() {
  docker exec -i "$C" psql -U postgres -d "$DB" -At -q -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -v '^$'
set role service_role;
begin;
update public.email_accounts set status = 'DISCONNECTED', access_token_encrypted = null, refresh_token_encrypted = null,
  token_expires_at = null, sync_cursor = null, last_error_code = null, last_error_message = null where id = '$1';
select floor(extract(epoch from clock_timestamp()) * 1000)::bigint || ' $3 DISCONNECT';
select pg_sleep($2);
commit;
SQL
}

# The worker's markError (apps/worker/src/infrastructure/supabase-stores.ts): ERROR, never over a DISCONNECTED IMAP row.
error_session() {
  docker exec -i "$C" psql -U postgres -d "$DB" -At -q -v ON_ERROR_STOP=1 <<SQL 2>&1 | grep -v '^$'
set role service_role;
begin;
update public.email_accounts set status = 'ERROR', last_error_code = 'IMAP_AUTH_FAILED', last_error_message = 'refused'
where id = '$1' and (provider <> 'IMAP' or status <> 'DISCONNECTED');
select floor(extract(epoch from clock_timestamp()) * 1000)::bigint || ' $3 ERROR';
select pg_sleep($2);
commit;
SQL
}

state() { psql_db -c "select status || ' ' || coalesce(last_error_code, '-') || ' ' || (access_token_encrypted is not null) || ' ' || coalesce(sync_cursor, '-') from public.email_accounts where id = '$1'"; }

# check <label> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then echo "   $1: $2 OK"; else echo "   $1: '$2' (expected '$3') FAIL"; failures=$((failures + 1)); fi
}

# waited <first output> <second output>: the second call returned at least (HOLD - 0.6) s after the first.
waited() {
  local first second
  first=$(echo "$1" | awk '{print $1}' | head -1)
  second=$(echo "$2" | awk '{print $1}' | head -1)
  if [ -n "$first" ] && [ -n "$second" ] && [ $((second - first)) -ge $(((HOLD * 1000) - 600)) ]; then
    echo "   second session waited $((second - first)) ms OK"
  else
    echo "   second session did not wait (first=$first second=$second) FAIL"
    failures=$((failures + 1))
  fi
}

run_pair() { # run_pair <n> <cmd1 + its n-1 args> -- <cmd2...>: first in background (holds), second 0.3 s later
  local out1 out2
  out1=$(mktemp)
  out2=$(mktemp)
  "${@:2:$1}" >"$out1" &
  local p1=$!
  sleep 0.3
  "${@:$(($1 + 3))}" >"$out2"
  wait $p1
  FIRST=$(cat "$out1")
  SECOND=$(cat "$out2")
  rm -f "$out1" "$out2"
  echo "    [1] $FIRST"
  echo "    [2] $SECOND"
}

echo "== 1. reconnect (holding) then activate"
read -r org id <<<"$(new_mailbox race1)"
run_pair 5 reconnect_session "$org" race1 "$HOLD" reconnect -- activate_session "$org" "$id" 0 activate
waited "$FIRST" "$SECOND"
check "activation outcome" "$(echo "$SECOND" | awk '{print $3}')" "ACTIVATED"
check "final state" "$(state "$id")" "ACTIVE - true imap:v1:7:120"

echo "== 2. activate (holding) then reconnect"
read -r org id <<<"$(new_mailbox race2)"
run_pair 5 activate_session "$org" "$id" "$HOLD" activate -- reconnect_session "$org" race2 0 reconnect
waited "$FIRST" "$SECOND"
check "reconnect outcome" "$(echo "$SECOND" | awk '{print $3}')" "RECONNECTED"
check "final state" "$(state "$id")" "PAUSED IMAP_ACTIVATION_PENDING true imap:v1:7:120"

echo "== 3. activate (holding) then disconnect"
read -r org id <<<"$(new_mailbox race3)"
run_pair 5 activate_session "$org" "$id" "$HOLD" activate -- disconnect_session "$id" 0 disconnect
waited "$FIRST" "$SECOND"
check "final state" "$(state "$id")" "DISCONNECTED - false -"

echo "== 4. disconnect (holding) then activate"
read -r org id <<<"$(new_mailbox race4)"
run_pair 4 disconnect_session "$id" "$HOLD" disconnect -- activate_session "$org" "$id" 0 activate
waited "$FIRST" "$SECOND"
check "activation outcome" "$(echo "$SECOND" | awk '{print $3}')" "DISCONNECTED"
check "final state" "$(state "$id")" "DISCONNECTED - false -"

echo "== 5. two activations at once"
read -r org id <<<"$(new_mailbox race5)"
run_pair 5 activate_session "$org" "$id" "$HOLD" first -- activate_session "$org" "$id" 0 second
waited "$FIRST" "$SECOND"
check "outcomes" "$(echo "$FIRST" | awk '{print $3}') $(echo "$SECOND" | awk '{print $3}')" "ACTIVATED ALREADY_ACTIVE"
check "final state" "$(state "$id")" "ACTIVE - true imap:v1:7:120"

echo "== 6. worker marks ERROR (holding) then activate (M1.4, H1)"
read -r org id <<<"$(new_mailbox race6)"
run_pair 4 error_session "$id" "$HOLD" error -- activate_session "$org" "$id" 0 activate
waited "$FIRST" "$SECOND"
check "activation outcome" "$(echo "$SECOND" | awk '{print $3}')" "RECONNECT_REQUIRED"
check "final state" "$(state "$id")" "ERROR IMAP_AUTH_FAILED true imap:v1:7:120"

echo "dropping $DB"
if [ "$failures" -eq 0 ]; then echo "RESULT: OK"; else echo "RESULT: $failures FAILED"; exit 1; fi
