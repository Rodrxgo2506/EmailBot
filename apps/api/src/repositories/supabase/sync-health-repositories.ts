import type { SupabaseClient } from "@supabase/supabase-js";
import { fromDatabaseError } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";

type SyncHealthOperations = Pick<PrivilegedOperations, "syncHealthCounts">;

/**
 * GET /health/sync data: HEAD count queries only (no rows, ids or addresses
 * leave the database), with the service role, over the same mailboxes the
 * worker polls (ACTIVE Gmail / Microsoft accounts of ACTIVE organizations).
 */
export function syncHealthOperations(service: SupabaseClient): SyncHealthOperations {
  const monitored = () =>
    service
      .from("email_accounts")
      .select("id,organizations!inner(status)", { count: "exact", head: true })
      .eq("status", "ACTIVE")
      .eq("organizations.status", "ACTIVE")
      .in("provider", ["GMAIL", "MICROSOFT"]);

  const count = async (query: PromiseLike<{ count: number | null; error: { message: string; code?: string } | null }>) => {
    const { count: value, error } = await query;
    if (error) throw fromDatabaseError(error);
    return value ?? 0;
  };

  return {
    async syncHealthCounts({ staleBefore, watchExpiringBefore }) {
      // Timestamps are quoted: they contain ":" and "." (PostgREST logic-filter syntax).
      const before = `"${staleBefore}"`;
      const [total, stale, erroring, watchExpiring] = await Promise.all([
        count(monitored()),
        count(monitored().or(`last_synced_at.lt.${before},and(last_synced_at.is.null,created_at.lt.${before})`)),
        count(monitored().not("last_error_code", "is", null)),
        // Without Gmail push the worker does not renew watches: leftover expiry dates are not a signal.
        watchExpiringBefore === null
          ? 0
          : count(monitored().eq("provider", "GMAIL").not("watch_expires_at", "is", null).lt("watch_expires_at", watchExpiringBefore))
      ]);
      return { monitored: total, stale, erroring, watchExpiring };
    }
  };
}
