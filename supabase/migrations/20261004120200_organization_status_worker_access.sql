-- ============================================================
-- EmailBot V2 - Phase 1: organization status for the worker
--
-- organizations.status (ACTIVE / SUSPENDED / CANCELLED) now takes effect:
-- the worker must not process mail nor create deliveries for an inactive
-- organization. Migration 7 left the service role without any privilege on
-- organizations; this grants back ONLY the two columns the worker needs to
-- check the status (id to join from email_accounts/emails, status).
-- No table-wide SELECT; names, slugs, plans stay unreadable.
-- ============================================================

grant select (id, status)
on table public.organizations
to service_role;
