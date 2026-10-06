/*
 * GET /health/sync (F8-A B-4, F8-B): is mail synchronization working?
 *
 * Syncable mailboxes are the Gmail / Microsoft accounts of ACTIVE
 * organizations that are ACTIVE (the worker polls them) or in ERROR (their
 * authorization must be renewed). The worker syncs every ACTIVE one every
 * WORKER_POLL_INTERVAL_MINUTES (default 5) through the "poll-active-accounts"
 * job scheduler; a successful sync refreshes last_synced_at and clears
 * last_error_code, so a healthy mailbox is never older than a few minutes.
 *
 * The answer is deliberately coarse, for an uptime monitor (checked in order):
 *   503 down/unavailable  Redis or the database cannot be read: nothing can sync.
 *   503 down/stalled      the polling scheduler is overdue by more than two
 *                         intervals: no worker consumes the email-events queue.
 *   200 ok/idle           no syncable mailbox (nothing to monitor).
 *   503 down/error        every syncable mailbox is in ERROR: nothing syncs.
 *   503 down/stale        more than half of the ACTIVE mailboxes are stale: the
 *                         pipeline is stopped. With a single ACTIVE mailbox,
 *                         that mailbox being stale is enough.
 *   200 degraded/degraded some mailbox is in ERROR, stale, failing, its Gmail
 *                         watch is about to expire or (Microsoft push on) its
 *                         Graph subscription is missing or about to expire, or emails are stuck
 *                         (RECEIVED / PROCESSING for more than 30 min) or failed
 *                         in the last 24 h; most of the pipeline still works.
 *                         A monitor can alert on the "degraded" keyword.
 *   200 ok/healthy        every syncable mailbox is fresh and nothing is stuck.
 * No ids, addresses, counts or organization data are returned.
 */

export interface SyncHealthCounts {
  /** ACTIVE Gmail / Microsoft accounts of ACTIVE organizations. */
  monitored: number;
  /** Gmail / Microsoft accounts in ERROR of ACTIVE organizations (authorization lost). */
  errored: number;
  /** Monitored accounts whose last successful sync (or creation, if never synced) is older than the threshold. */
  stale: number;
  /** Monitored accounts whose last sync attempt failed (last_error_code set). */
  erroring: number;
  /** Monitored Gmail accounts whose push watch expires within WATCH_EXPIRY_WARNING_MS (or has expired); 0 without Gmail push. */
  watchExpiring: number;
  /**
   * Monitored Microsoft accounts whose Graph subscription is missing, or expires
   * within WATCH_EXPIRY_WARNING_MS (or has expired); 0 without Microsoft push.
   */
  subscriptionIssues: number;
  /** Emails still RECEIVED / PROCESSING STUCK_EMAIL_MS after they were stored (ACTIVE accounts of ACTIVE organizations). */
  stuckEmails: number;
  /** Emails that became FAILED in the last FAILED_EMAIL_WINDOW_MS (ACTIVE organizations). */
  failedEmails: number;
}

export type SyncHealthBody =
  | { status: "ok"; sync: "healthy" | "idle" }
  | { status: "degraded"; sync: "degraded" }
  | { status: "down"; sync: "error" | "stale" | "stalled" | "unavailable" };

export interface SyncHealthResult {
  statusCode: 200 | 503;
  body: SyncHealthBody;
}

/** State of the polling job scheduler (BullMQ): next run and interval, both in milliseconds. */
export interface PollSchedulerState {
  next: number;
  every: number;
}

export const SYNC_HEALTH_CACHE_MS = 30_000;
/**
 * The worker renews a Gmail watch (7 days) once less than 24 h remain, every
 * WORKER_WATCH_RENEW_INTERVAL_MINUTES (default 60). Every watch passes through
 * that 24 h window normally, so only half of it is reported: with the default
 * interval that takes about 12 missed renewals, and a renewed watch is 7 days out.
 */
export const WATCH_EXPIRY_WARNING_MS = 12 * 60 * 60 * 1000;
/** RECOVER_INCOMPLETE resumes unfinished emails every 10 minutes: 30 minutes is three missed recoveries. */
export const STUCK_EMAIL_MS = 30 * 60 * 1000;
export const FAILED_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The scheduler is stalled when its next run is overdue by more than this many intervals. */
export const SCHEDULER_STALL_INTERVALS = 2;

export const SYNC_UNAVAILABLE: SyncHealthResult = { statusCode: 503, body: { status: "down", sync: "unavailable" } };
export const SYNC_STALLED: SyncHealthResult = { statusCode: 503, body: { status: "down", sync: "stalled" } };

/**
 * True when no worker is consuming the polling scheduler: its next run is
 * more than SCHEDULER_STALL_INTERVALS intervals in the past. A missing
 * scheduler (polling disabled) or unusable values are not a failure.
 */
export function isPollSchedulerStalled(state: PollSchedulerState | null, now: number): boolean {
  if (!state) return false;
  const { next, every } = state;
  if (!Number.isFinite(next) || !Number.isFinite(every) || every <= 0 || !Number.isFinite(now)) return false;
  return now - next > SCHEDULER_STALL_INTERVALS * every;
}

export function evaluateSyncHealth(counts: SyncHealthCounts): SyncHealthResult {
  if (counts.monitored + counts.errored === 0) return { statusCode: 200, body: { status: "ok", sync: "idle" } };
  if (counts.monitored === 0) return { statusCode: 503, body: { status: "down", sync: "error" } };
  if (counts.stale * 2 > counts.monitored) return { statusCode: 503, body: { status: "down", sync: "stale" } };
  const problems = [counts.errored, counts.stale, counts.erroring, counts.watchExpiring, counts.subscriptionIssues, counts.stuckEmails, counts.failedEmails];
  if (problems.some((count) => count > 0)) return { statusCode: 200, body: { status: "degraded", sync: "degraded" } };
  return { statusCode: 200, body: { status: "ok", sync: "healthy" } };
}
