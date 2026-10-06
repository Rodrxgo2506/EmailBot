/*
 * GET /health/sync (F8-A B-4): is mail synchronization working?
 *
 * Monitored mailboxes are the ones the worker polls: ACTIVE Gmail / Microsoft
 * accounts of ACTIVE organizations. The worker syncs every one of them every
 * WORKER_POLL_INTERVAL_MINUTES (default 5) and a successful sync refreshes
 * last_synced_at and clears last_error_code, so a healthy mailbox is never
 * older than a few minutes.
 *
 * The answer is deliberately coarse, for an uptime monitor:
 *   503 down/unavailable  Redis or the database cannot be read: nothing can sync.
 *   503 down/stale        more than half of the monitored mailboxes are stale: the
 *                         pipeline (worker, queue) is stopped. With a single
 *                         mailbox, that mailbox being stale is enough (a stopped
 *                         worker and one broken mailbox look the same).
 *   200 degraded/degraded some mailboxes are stale, failing or their Gmail watch
 *                         is about to expire, but most still sync. One broken
 *                         mailbox among two or more never keeps the endpoint
 *                         failing; a monitor can still alert on "degraded".
 *   200 ok/healthy        every monitored mailbox is fresh.
 *   200 ok/idle           nothing to monitor (no active mailboxes).
 * No ids, addresses, counts or organization data are returned.
 */

export interface SyncHealthCounts {
  /** ACTIVE Gmail / Microsoft accounts of ACTIVE organizations. */
  monitored: number;
  /** Monitored accounts whose last successful sync (or creation, if never synced) is older than the threshold. */
  stale: number;
  /** Monitored accounts whose last sync attempt failed (last_error_code set). */
  erroring: number;
  /** Monitored Gmail accounts whose push watch expires within WATCH_EXPIRY_WARNING_MS (or has expired); 0 without Gmail push. */
  watchExpiring: number;
}

export type SyncHealthBody =
  | { status: "ok"; sync: "healthy" | "idle" }
  | { status: "degraded"; sync: "degraded" }
  | { status: "down"; sync: "stale" | "unavailable" };

export interface SyncHealthResult {
  statusCode: 200 | 503;
  body: SyncHealthBody;
}

export const SYNC_HEALTH_CACHE_MS = 30_000;
/**
 * The worker renews a Gmail watch (7 days) once less than 24 h remain, every
 * WORKER_WATCH_RENEW_INTERVAL_MINUTES (default 60). Every watch passes through
 * that 24 h window normally, so only half of it is reported: with the default
 * interval that takes about 12 missed renewals, and a renewed watch is 7 days out.
 */
export const WATCH_EXPIRY_WARNING_MS = 12 * 60 * 60 * 1000;

export const SYNC_UNAVAILABLE: SyncHealthResult = { statusCode: 503, body: { status: "down", sync: "unavailable" } };

export function evaluateSyncHealth(counts: SyncHealthCounts): SyncHealthResult {
  if (counts.monitored === 0) return { statusCode: 200, body: { status: "ok", sync: "idle" } };
  if (counts.stale * 2 > counts.monitored) return { statusCode: 503, body: { status: "down", sync: "stale" } };
  if (counts.stale > 0 || counts.erroring > 0 || counts.watchExpiring > 0) {
    return { statusCode: 200, body: { status: "degraded", sync: "degraded" } };
  }
  return { statusCode: 200, body: { status: "ok", sync: "healthy" } };
}
