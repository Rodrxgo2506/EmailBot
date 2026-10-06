import type { SupabaseClient } from "@supabase/supabase-js";
import { fromDatabaseError } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";

type SyncHealthOperations = Pick<PrivilegedOperations, "syncHealthCounts">;

const SYNCABLE_PROVIDERS = ["GMAIL", "MICROSOFT"];

/**
 * GET /health/sync data: HEAD count queries only (no rows, ids or addresses
 * leave the database), with the service role. Mailboxes: Gmail / Microsoft
 * accounts of ACTIVE organizations; emails: those of ACTIVE organizations
 * (stuck ones only for ACTIVE accounts, as the worker's recovery does).
 */
export function syncHealthOperations(service: SupabaseClient): SyncHealthOperations {
  const accounts = (status: "ACTIVE" | "ERROR") =>
    service
      .from("email_accounts")
      .select("id,organizations!inner(status)", { count: "exact", head: true })
      .eq("status", status)
      .eq("organizations.status", "ACTIVE")
      .in("provider", SYNCABLE_PROVIDERS);

  const count = async (query: PromiseLike<{ count: number | null; error: { message: string; code?: string } | null }>) => {
    const { count: value, error } = await query;
    if (error) throw fromDatabaseError(error);
    return value ?? 0;
  };

  return {
    async syncHealthCounts({ staleBefore, watchExpiringBefore, stuckBefore, failedSince, microsoftSubscriptionsBefore }) {
      // Timestamps are quoted: they contain ":" and "." (PostgREST logic-filter syntax).
      const before = `"${staleBefore}"`;
      const [monitored, errored, stale, erroring, watchExpiring, subscriptionIssues, stuckEmails, failedEmails] = await Promise.all([
        count(accounts("ACTIVE")),
        count(accounts("ERROR")),
        count(accounts("ACTIVE").or(`last_synced_at.lt.${before},and(last_synced_at.is.null,created_at.lt.${before})`)),
        count(accounts("ACTIVE").not("last_error_code", "is", null)),
        // Without Gmail push the worker does not renew watches: leftover expiry dates are not a signal.
        watchExpiringBefore === null
          ? 0
          : count(accounts("ACTIVE").eq("provider", "GMAIL").not("watch_expires_at", "is", null).lt("watch_expires_at", watchExpiringBefore)),
        // Without Microsoft push no subscription is expected.
        microsoftSubscriptionsBefore === null
          ? 0
          : count(accounts("ACTIVE").eq("provider", "MICROSOFT").or(`watch_expires_at.is.null,watch_expires_at.lt."${microsoftSubscriptionsBefore}"`)),
        count(
          service
            .from("emails")
            .select("id,email_accounts!inner(status),organizations!inner(status)", { count: "exact", head: true })
            .in("processing_status", ["RECEIVED", "PROCESSING"])
            .lt("created_at", stuckBefore)
            .eq("email_accounts.status", "ACTIVE")
            .eq("organizations.status", "ACTIVE")
        ),
        count(
          service
            .from("emails")
            .select("id,organizations!inner(status)", { count: "exact", head: true })
            .eq("processing_status", "FAILED")
            .gte("updated_at", failedSince)
            .eq("organizations.status", "ACTIVE")
        )
      ]);
      return { monitored, errored, stale, erroring, watchExpiring, subscriptionIssues, stuckEmails, failedEmails };
    }
  };
}
