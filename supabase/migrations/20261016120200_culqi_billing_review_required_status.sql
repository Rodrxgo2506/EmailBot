-- ============================================================
-- EmailBot - Commercial V1 phase 2 (Culqi SANDBOX): REVIEW_REQUIRED status
--
-- A checkout whose Culqi charge stayed neither confirmed nor declined for too
-- long (the worker's CULQI_UNCONFIRMED_REVIEW_AFTER_HOURS) leaves PENDING
-- without being cancelled: it no longer blocks new checkouts, nothing is
-- cancelled at Culqi, and it can still be resolved by a later verified charge.
--
-- Own migration: a new enum value cannot be used in the transaction that adds
-- it; 20261007150100 uses it.
-- ============================================================

alter type public.billing_subscription_status add value if not exists 'REVIEW_REQUIRED';
