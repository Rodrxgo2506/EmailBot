-- ============================================================
-- EmailBot - Commercial V1, phase 1 (1/2): BASIC plan value
--
-- Commercial V1 sells BASIC / PRO / BUSINESS; there is no free plan.
-- This migration only adds the BASIC value to the existing enum, in its
-- own file: PostgreSQL does not allow a new enum value to be used in the
-- transaction that adds it, and the next migration (catalog, default,
-- foreign key) uses it.
--
-- FREE stays in the enum (an enum value cannot be dropped) as a LEGACY
-- value: organizations created before Commercial V1 keep it untouched
-- (see 20261006120100_plan_catalog.sql and docs/commercial-plans.md).
-- Additive: no row changes.
-- ============================================================

alter type public.organization_plan add value if not exists 'BASIC' before 'PRO';
