/*
 * EmailBot F8-B - GET /health/sync counts against a LOCAL Supabase stack
 * (real PostgREST filters and embedded organization / account joins).
 *
 * The local database is shared with other E2E runs, so the check is
 * differential: counts are read, a known set of organizations, mailboxes and
 * emails is added, counts are read again and the difference must be exactly
 * what the ACTIVE organization contributes (inactive organizations, paused
 * mailboxes and out-of-window emails must not count). Everything created is
 * deleted at the end. Fixtures are written with SQL as postgres in the local
 * database container (the service role has no privileges on organizations);
 * the counts under test go through PostgREST with the service role, as in
 * production.
 *
 *   supabase start
 *   pnpm --filter @emailbot/api e2e
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { SyncHealthCounts } from "../src/modules/health/sync-health.js";
import { privilegedOperations } from "../src/repositories/supabase/index.js";
import { localEnv, localSql } from "./local-supabase.js";

const { url, serviceKey } = localEnv();
const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const privileged = privilegedOperations(service);
const run = randomBytes(3).toString("hex");

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}
const must = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`setup failed: ${label}`);
  return value;
};

const MINUTE = 60_000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const params = {
  staleBefore: iso(-20 * MINUTE),
  stuckBefore: iso(-30 * MINUTE),
  failedSince: iso(-24 * 60 * MINUTE)
};
// `push`: Gmail watch and Microsoft subscription checks on (both warn 12 h before expiry).
const counts = (push: boolean) =>
  privileged.syncHealthCounts({ ...params, watchExpiringBefore: push ? iso(12 * 60 * MINUTE) : null, microsoftSubscriptionsBefore: push ? iso(12 * 60 * MINUTE) : null });

/* ------------------------------------------------------------------ fixtures (SQL as postgres, local container) */

const organizations: string[] = [];
const statements: string[] = [];
const literal = (value: string | null) => (value === null ? "null" : `'${value.replace(/'/g, "''")}'`);

function organization(label: string, status: "ACTIVE" | "SUSPENDED" | "CANCELLED") {
  const id = randomUUID();
  organizations.push(id);
  statements.push(
    `insert into public.organizations (id, name, slug, status) values (${literal(id)}, ${literal(`Sync health ${label} ${run}`)}, ${literal(`sync-health-${label}-${run}`)}, ${literal(status)});`
  );
  return id;
}

function mailbox(
  organizationId: string,
  label: string,
  state: { provider?: "GMAIL" | "MICROSOFT"; status: "ACTIVE" | "ERROR" | "PAUSED"; syncedMinutesAgo: number | null; errorCode?: string; watchExpiresInHours?: number }
) {
  const id = randomUUID();
  const values = [
    literal(id),
    literal(organizationId),
    literal(state.provider ?? "GMAIL"),
    literal(state.status),
    literal(`${label}-${run}@sync-health.test`),
    state.syncedMinutesAgo === null ? "null" : literal(iso(-state.syncedMinutesAgo * MINUTE)),
    literal(state.errorCode ?? null),
    state.watchExpiresInHours === undefined ? "null" : literal(iso(state.watchExpiresInHours * 60 * MINUTE)),
    // Created two hours ago: a never-synced mailbox counts as stale too.
    literal(iso(-120 * MINUTE))
  ];
  statements.push(
    `insert into public.email_accounts (id, organization_id, provider, status, email_address, last_synced_at, last_error_code, watch_expires_at, created_at) values (${values.join(", ")});`
  );
  return id;
}

function email(
  organizationId: string,
  emailAccountId: string,
  label: string,
  state: { status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED"; createdMinutesAgo: number; updatedMinutesAgo?: number }
) {
  const created = literal(iso(-state.createdMinutesAgo * MINUTE));
  const values = [
    literal(organizationId),
    literal(emailAccountId),
    literal(`${label}-${run}`),
    literal("remitente@sync-health.test"),
    created,
    literal(state.status),
    created,
    // The updated_at trigger runs on UPDATE only: an inserted value is kept.
    literal(iso(-(state.updatedMinutesAgo ?? state.createdMinutesAgo) * MINUTE))
  ];
  statements.push(
    `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, received_at, processing_status, created_at, updated_at) values (${values.join(", ")});`
  );
}

const firstLine = (error: unknown) => (error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));

/* ------------------------------------------------------------------ scenario */

let before: SyncHealthCounts | undefined;
try {
  before = await counts(false);
  const beforeWithWatch = await counts(true);

  // ACTIVE organization: what must be counted.
  const active = organization("active", "ACTIVE");
  const fresh = mailbox(active, "fresh", { status: "ACTIVE", syncedMinutesAgo: 2, watchExpiresInHours: 6 });
  mailbox(active, "stale", { status: "ACTIVE", syncedMinutesAgo: 90, errorCode: "GMAIL_HTTP_500", watchExpiresInHours: 100 });
  mailbox(active, "never-synced", { status: "ACTIVE", syncedMinutesAgo: null });
  const errored = mailbox(active, "error", { status: "ERROR", syncedMinutesAgo: 600 });
  mailbox(active, "error-ms", { provider: "MICROSOFT", status: "ERROR", syncedMinutesAgo: null });
  mailbox(active, "paused", { status: "PAUSED", syncedMinutesAgo: 600, errorCode: "X", watchExpiresInHours: 1 });
  // F9: Microsoft mailboxes (fresh syncs) with a valid, missing and expiring Graph subscription.
  mailbox(active, "ms-subscribed", { provider: "MICROSOFT", status: "ACTIVE", syncedMinutesAgo: 2, watchExpiresInHours: 50 });
  mailbox(active, "ms-missing", { provider: "MICROSOFT", status: "ACTIVE", syncedMinutesAgo: 2 });
  mailbox(active, "ms-expiring", { provider: "MICROSOFT", status: "ACTIVE", syncedMinutesAgo: 2, watchExpiresInHours: 6 });

  email(active, fresh, "received-recent", { status: "RECEIVED", createdMinutesAgo: 5 });
  email(active, fresh, "received-old", { status: "RECEIVED", createdMinutesAgo: 31 });
  email(active, fresh, "processing-recent", { status: "PROCESSING", createdMinutesAgo: 10 });
  email(active, fresh, "processing-old", { status: "PROCESSING", createdMinutesAgo: 45 });
  email(active, fresh, "processed-old", { status: "PROCESSED", createdMinutesAgo: 600 });
  email(active, fresh, "failed-recent", { status: "FAILED", createdMinutesAgo: 120, updatedMinutesAgo: 60 });
  email(active, fresh, "failed-old", { status: "FAILED", createdMinutesAgo: 26 * 60, updatedMinutesAgo: 25 * 60 });
  // Stuck on a mailbox in ERROR: the worker's recovery skips it (not counted); a failure there still counts.
  email(active, errored, "received-old-error-account", { status: "RECEIVED", createdMinutesAgo: 60 });
  email(active, errored, "failed-recent-error-account", { status: "FAILED", createdMinutesAgo: 120, updatedMinutesAgo: 30 });

  // Inactive organizations: nothing of theirs may count.
  for (const [label, status] of [
    ["suspended", "SUSPENDED"],
    ["cancelled", "CANCELLED"]
  ] as const) {
    const inactive = organization(label, status);
    const box = mailbox(inactive, `${label}-active`, { status: "ACTIVE", syncedMinutesAgo: 600, errorCode: "X", watchExpiresInHours: 1 });
    mailbox(inactive, `${label}-error`, { status: "ERROR", syncedMinutesAgo: 600 });
    mailbox(inactive, `${label}-ms`, { provider: "MICROSOFT", status: "ACTIVE", syncedMinutesAgo: 600 });
    email(inactive, box, `${label}-stuck`, { status: "RECEIVED", createdMinutesAgo: 60 });
    email(inactive, box, `${label}-failed`, { status: "FAILED", createdMinutesAgo: 60, updatedMinutesAgo: 30 });
  }
  localSql(`begin;\n${statements.join("\n")}\ncommit;\n`);

  const after = await counts(false);
  const afterWithWatch = await counts(true);
  const delta = (key: keyof SyncHealthCounts) => after[key] - must(before, "baseline")[key];

  check(delta("monitored") === 6, "monitored: ACTIVE Gmail / Microsoft mailboxes of the ACTIVE organization only", `+${delta("monitored")}`);
  check(delta("errored") === 2, "errored: Gmail + Microsoft mailboxes in ERROR of the ACTIVE organization only", `+${delta("errored")}`);
  check(delta("stale") === 2, "stale: synced 90 min ago and never synced (created 2 h ago); not the fresh one", `+${delta("stale")}`);
  check(delta("erroring") === 1, "erroring: ACTIVE mailbox with last_error_code; not the paused one", `+${delta("erroring")}`);
  check(delta("watchExpiring") === 0, "watchExpiring: 0 when Gmail push is off", `+${delta("watchExpiring")}`);
  check(
    afterWithWatch.watchExpiring - beforeWithWatch.watchExpiring === 1,
    "watchExpiring with push: only the ACTIVE Gmail mailbox whose watch ends within 12 h",
    `+${afterWithWatch.watchExpiring - beforeWithWatch.watchExpiring}`
  );
  check(delta("subscriptionIssues") === 0, "subscriptionIssues: 0 when Microsoft push is off", `+${delta("subscriptionIssues")}`);
  check(
    afterWithWatch.subscriptionIssues - beforeWithWatch.subscriptionIssues === 2,
    "subscriptionIssues with push: ACTIVE Microsoft mailboxes without a subscription or expiring within 12 h (not the valid one, not inactive organizations)",
    `+${afterWithWatch.subscriptionIssues - beforeWithWatch.subscriptionIssues}`
  );
  check(delta("stuckEmails") === 2, "stuckEmails: RECEIVED / PROCESSING older than 30 min, on ACTIVE mailboxes", `+${delta("stuckEmails")}`);
  check(delta("failedEmails") === 2, "failedEmails: FAILED in the last 24 h (not the one from 25 h ago)", `+${delta("failedEmails")}`);
} catch (error) {
  fail++;
  console.log(`FAIL setup or query: ${firstLine(error)}`);
} finally {
  if (organizations.length > 0) {
    try {
      localSql(`delete from public.organizations where id in (${organizations.map(literal).join(", ")});\n`);
      check(true, "cleanup: test organizations deleted (cascade)");
      if (before) check(JSON.stringify(await counts(false)) === JSON.stringify(before), "cleanup: counts back to the baseline");
    } catch (error) {
      check(false, "cleanup: test organizations deleted (cascade)", firstLine(error));
    }
  }
}

console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
