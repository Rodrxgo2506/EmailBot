-- ============================================================
-- EmailBot V2 - Phase 3: worker access for customer resolution
--
-- Column grants only (no table-wide privilege, nothing writable): exactly
-- the columns the CustomerResolver reads. Display names, notes, external
-- references and the raw identifier values stay unreadable for the worker.
-- ============================================================

-- How the bot resolves customers.
grant select (customer_resolution)
on table public.bots
to service_role;

-- Only ACTIVE customers are eligible.
grant select (id, organization_id, status)
on table public.customers
to service_role;

-- Lookup by (organization_id, type, normalized_value) where active, with the bot scope.
grant select (id, organization_id, customer_id, type, normalized_value, bot_id, active)
on table public.customer_identifiers
to service_role;

-- The customer must have an active assignment to the email's bot.
grant select (organization_id, bot_id, customer_id, active)
on table public.bot_customer_assignments
to service_role;
