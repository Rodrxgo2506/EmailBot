-- ============================================================
-- EmailBot V2 - Phase 4: customer portal sessions
--
-- Opaque server-side sessions created by exchanging an Access ID. The
-- session token (256 random bits) lives only in an httpOnly cookie; the
-- database stores hex(SHA-256(token)). Lifetime: 7 days idle, 30 days
-- absolute (enforced by the portal functions and by the checks below).
--
-- Integrity: (organization_id, customer_id, credential_id) references the
-- credential of THAT customer in THAT organization (composite FK), for every
-- role.
--
-- Revoked / expired sessions are kept (history), never deleted.
--
-- RLS (who can do what):
--   SELECT  OWNER/ADMIN/OPERATOR of the organization, every column EXCEPT
--           token_hash (column grants)
--   INSERT / UPDATE / DELETE  nobody directly: login, validation, logout and
--           revocation go through SECURITY DEFINER functions
--   cross-organization: impossible (RLS + composite FK)
--   customers (portal): only through portal.* functions with their token hash
--   platform admins: no RLS exception
--   service_role: no table privilege (EXECUTE on portal.* functions only)
-- ============================================================

create table public.customer_sessions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  customer_id uuid not null,

  credential_id uuid not null,

  -- hex(SHA-256(session token)).
  token_hash text not null,

  created_at timestamptz not null default now(),

  last_seen_at timestamptz not null default now(),

  idle_expires_at timestamptz not null,

  absolute_expires_at timestamptz not null,

  revoked_at timestamptz,

  revoked_reason text,

  ip inet,

  user_agent text,

  constraint customer_sessions_token_hash_key
    unique (token_hash),

  constraint customer_sessions_credential_fkey
    foreign key (organization_id, customer_id, credential_id)
    references public.customer_access_credentials(organization_id, customer_id, id)
    on delete cascade,

  constraint customer_sessions_customer_fkey
    foreign key (organization_id, customer_id)
    references public.customers(organization_id, id)
    on delete cascade,

  constraint customer_sessions_token_hash_format
    check (token_hash ~ '^[0-9a-f]{64}$'),

  constraint customer_sessions_lifetime
    check (
      idle_expires_at <= absolute_expires_at
      and absolute_expires_at <= created_at + interval '30 days'
    ),

  constraint customer_sessions_revocation
    check ((revoked_at is null) = (revoked_reason is null)),

  constraint customer_sessions_revoked_reason
    check (
      revoked_reason is null
      or revoked_reason in (
        'LOGOUT',
        'REVOKED',
        'REVOKED_ALL',
        'CREDENTIAL_REGENERATED',
        'CREDENTIAL_REVOKED',
        'CUSTOMER_SUSPENDED'
      )
    ),

  constraint customer_sessions_user_agent_length
    check (user_agent is null or char_length(user_agent) <= 512)
);

comment on table public.customer_sessions is
  'Customer portal sessions (EmailBot V2). Only SHA-256 of the session token is stored.';

create index customer_sessions_customer_active_idx
  on public.customer_sessions(customer_id)
  where revoked_at is null;

create index customer_sessions_credential_active_idx
  on public.customer_sessions(credential_id)
  where revoked_at is null;

create index customer_sessions_customer_idx
  on public.customer_sessions(organization_id, customer_id, created_at desc);


-- ============================================================
-- SUSPENDED CUSTOMERS LOSE THEIR SESSIONS
--
-- Whatever path suspends a customer, its open sessions are revoked in the
-- same transaction (validation also rejects non-ACTIVE customers). A later
-- reactivation does not revive them: the customer logs in again.
-- ============================================================

create or replace function private.revoke_sessions_of_suspended_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  if new.status is distinct from old.status and new.status <> 'ACTIVE' then
    update public.customer_sessions s
    set revoked_at = now(),
        revoked_reason = 'CUSTOMER_SUSPENDED'
    where s.organization_id = new.organization_id
      and s.customer_id = new.id
      and s.revoked_at is null;
  end if;

  return new;

end;
$$;

revoke all on function private.revoke_sessions_of_suspended_customer()
from public, anon, authenticated, service_role;

create trigger customers_revoke_sessions_on_suspension
after update of status on public.customers
for each row
execute function private.revoke_sessions_of_suspended_customer();


-- ============================================================
-- RLS
-- ============================================================

alter table public.customer_sessions enable row level security;

create policy "Operators and above can view customer sessions"
on public.customer_sessions
for select
to authenticated
using (
  (select private.has_organization_role(
    organization_id,
    array['OWNER', 'ADMIN', 'OPERATOR']::public.organization_role[]
  ))
);


-- ============================================================
-- GRANTS
-- ============================================================

revoke all on table public.customer_sessions
from anon, authenticated, service_role;

-- Everything except token_hash.
grant select (
  id,
  organization_id,
  customer_id,
  credential_id,
  created_at,
  last_seen_at,
  idle_expires_at,
  absolute_expires_at,
  revoked_at,
  revoked_reason,
  ip,
  user_agent
)
on table public.customer_sessions
to authenticated;
