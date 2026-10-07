-- ============================================================
-- EmailBot - Commercial V1: email account limits per plan
--
-- Raises ONLY the EMAIL_ACCOUNTS limit of the catalog
-- (public.plan_entitlements, the single source of the limits):
--
--   BASIC      2 -> 25
--   PRO        5 -> 125
--   BUSINESS  20 -> 250
--
-- Unchanged: prices (plan_prices), every other limit, every feature,
-- plan names and the rest of the catalog.
--
-- The limit is read live by public.organization_entitlements (API) and
-- is only checked when a mailbox is added; existing mailboxes,
-- subscriptions and organizations are not touched (no row outside the
-- three EMAIL_ACCOUNTS entitlements is written). Raising a limit cannot
-- put any organization over it.
-- ============================================================

do $$
declare
  updated integer;
begin
  update public.plan_entitlements e
  set limit_value = v.limit_value
  from (
    values
      ('BASIC', 25::bigint),
      ('PRO', 125::bigint),
      ('BUSINESS', 250::bigint)
  ) as v(code, limit_value)
  join public.plan_catalog c on c.code = v.code::public.organization_plan
  where e.plan_id = c.id
    and e.key = 'EMAIL_ACCOUNTS'
    and e.kind = 'LIMIT';

  get diagnostics updated = row_count;
  if updated <> 3 then
    raise exception 'email account limits: expected 3 catalog rows, updated %', updated;
  end if;
end;
$$;
