-- ============================================================
-- EmailBot V2 - Phase 4: customer access credentials (Access ID)
--
-- An Access ID ("SP-7KQ9X82MP4L7") is 60 random bits in Crockford base32.
-- It is NEVER stored, neither in plaintext nor encrypted: only
-- HMAC-SHA256(key, normalized secret), the key being derived with HKDF from
-- TOKEN_ENCRYPTION_KEY inside the API. The display prefix is cosmetic and
-- is not part of the secret. last4 allows showing "SP-••••••••P4L7".
--
-- At most ONE ACTIVE credential per customer (partial unique index).
-- Revoked credentials are kept (history), never deleted.
--
-- RLS (who can do what):
--   SELECT  OWNER/ADMIN/OPERATOR of the organization, every column EXCEPT
--           secret_hash (column grants)
--   INSERT / UPDATE / DELETE  nobody directly: generation, regeneration and
--           revocation go through SECURITY DEFINER functions (migration
--           customer_access_functions) that are atomic and check the role.
--   cross-organization: impossible (RLS + composite FK to customers)
--   customers (portal): never read this table; the login function does
--   platform admins: no RLS exception
--   service_role: no privilege (the API uses portal.* functions)
-- ============================================================

create type public.customer_access_status as enum ('ACTIVE', 'REVOKED');

create table public.customer_access_credentials (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  customer_id uuid not null,

  -- Cosmetic prefix shown with the Access ID (not part of the secret).
  display_prefix text not null default 'SP',

  -- hex(HMAC-SHA256(key, normalized secret)); unique across the platform.
  secret_hash text not null,

  -- Last 4 characters of the secret, for the masked display.
  last4 text not null,

  status public.customer_access_status not null default 'ACTIVE',

  -- Optional expiration (NULL = does not expire).
  expires_at timestamptz,

  created_by uuid
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  revoked_at timestamptz,

  revoked_by uuid
    references public.profiles(id)
    on delete set null,

  revoked_reason text,

  constraint customer_access_credentials_organization_id_id_key
    unique (organization_id, id),

  constraint customer_access_credentials_organization_customer_id_key
    unique (organization_id, customer_id, id),

  constraint customer_access_credentials_secret_hash_key
    unique (secret_hash),

  constraint customer_access_credentials_customer_fkey
    foreign key (organization_id, customer_id)
    references public.customers(organization_id, id)
    on delete cascade,

  constraint customer_access_credentials_secret_hash_format
    check (secret_hash ~ '^[0-9a-f]{64}$'),

  constraint customer_access_credentials_last4_format
    check (last4 ~ '^[0-9A-HJKMNP-TV-Z]{4}$'),

  constraint customer_access_credentials_prefix_format
    check (display_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),

  constraint customer_access_credentials_revocation
    check (
      (status = 'ACTIVE' and revoked_at is null and revoked_reason is null)
      or (status = 'REVOKED' and revoked_at is not null and revoked_reason is not null)
    ),

  constraint customer_access_credentials_revoked_reason
    check (revoked_reason is null or revoked_reason in ('REGENERATED', 'REVOKED')),

  constraint customer_access_credentials_expiration
    check (expires_at is null or expires_at > created_at)
);

comment on table public.customer_access_credentials is
  'Customer Access IDs (EmailBot V2). Only an HMAC of the secret is stored; the Access ID is shown once.';

comment on column public.customer_access_credentials.secret_hash is
  'hex HMAC-SHA256 of the normalized secret (key derived with HKDF from TOKEN_ENCRYPTION_KEY). Never readable by API roles.';

-- One ACTIVE credential per customer.
create unique index customer_access_credentials_one_active_idx
  on public.customer_access_credentials(customer_id)
  where status = 'ACTIVE';

create index customer_access_credentials_customer_idx
  on public.customer_access_credentials(organization_id, customer_id, created_at desc);


-- ============================================================
-- RLS
-- ============================================================

alter table public.customer_access_credentials enable row level security;

create policy "Operators and above can view customer access credentials"
on public.customer_access_credentials
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

revoke all on table public.customer_access_credentials
from anon, authenticated, service_role;

-- Everything except secret_hash.
grant select (
  id,
  organization_id,
  customer_id,
  display_prefix,
  last4,
  status,
  expires_at,
  created_by,
  created_at,
  revoked_at,
  revoked_by,
  revoked_reason
)
on table public.customer_access_credentials
to authenticated;
