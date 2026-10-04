-- ============================================================
-- EmailBot V2 - Phase 1: bot of a rule and of an email
--
-- email_rules.bot_id  NULL = general rule (classifies, never routes to customers)
-- emails.bot_id       NULL = no bot selected (no match with a bot rule, or an
--                     ambiguous tie between bots: see rules-engine evaluateRules)
--
-- Additive and backward compatible: nullable columns, no backfill, existing
-- rows stay bot_id = NULL. V1 policies are untouched: both tables keep their
-- organization policies and the new column is covered by them.
--
-- Tenant integrity is enforced by composite foreign keys on
-- (organization_id, bot_id) -> bots(organization_id, id): a rule or email can
-- only reference a bot of its own organization, for every role (including
-- the service role and the table owner). Deleting a bot clears only bot_id
-- (ON DELETE SET NULL (bot_id)), never organization_id.
-- ============================================================

alter table public.email_rules
  add column bot_id uuid;

alter table public.email_rules
  add constraint email_rules_bot_fkey
  foreign key (organization_id, bot_id)
  references public.bots(organization_id, id)
  on delete set null (bot_id);

create index email_rules_bot_idx
  on public.email_rules(organization_id, bot_id)
  where bot_id is not null;

comment on column public.email_rules.bot_id is
  'Bot this rule belongs to (EmailBot V2). NULL = general rule.';

-- Column grants only (V1 table): rule editors (OWNER/ADMIN through RLS) choose the bot.
grant insert (bot_id), update (bot_id)
on table public.email_rules
to authenticated;


alter table public.emails
  add column bot_id uuid;

alter table public.emails
  add constraint emails_bot_fkey
  foreign key (organization_id, bot_id)
  references public.bots(organization_id, id)
  on delete set null (bot_id);

create index emails_bot_received_idx
  on public.emails(organization_id, bot_id, received_at desc)
  where bot_id is not null;

comment on column public.emails.bot_id is
  'Bot selected by the rule engine when the email was processed (EmailBot V2). NULL = none or ambiguous.';

-- The worker (service role) already has table-wide INSERT on emails (migration 7),
-- which covers bot_id. Members can read it through the existing SELECT grant.
-- No UPDATE grant: re-routing an email is a later phase.
