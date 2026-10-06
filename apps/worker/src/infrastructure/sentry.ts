import { filterSentryBreadcrumb, scrubSentryEvent } from "@emailbot/shared";
import * as Sentry from "@sentry/node";

/*
 * Worker error reporting (F8-B). Same hygiene as the API (no request data,
 * user data or network breadcrumbs; scrubbed free text). A failing job is
 * retried by BullMQ with backoff, so it is reported once, on its final
 * attempt: a transient failure that later succeeds is never reported and a
 * permanent one produces one event instead of one per attempt.
 */

let enabled = false;

export function initWorkerSentry(options: { dsn: string | null; environment: string; release?: string | undefined }): void {
  if (!options.dsn || enabled) return;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    ...(options.release ? { release: options.release } : {}),
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false
    },
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => filterSentryBreadcrumb(breadcrumb)
  });
  enabled = true;
}

/** The BullMQ job fields that decide whether this run is the last one (attemptsMade = failed runs so far). */
export interface JobAttempts {
  attemptsMade: number;
  opts: { attempts?: number | undefined };
}

/** What reportJobFailure needs from a BullMQ job. */
export interface FailedJob extends JobAttempts {
  queueName: string;
  data: unknown;
}

/** The job's `type` (email-events jobs), if any. */
export function jobType(data: unknown): string | undefined {
  const type = typeof data === "object" && data !== null ? (data as { type?: unknown }).type : undefined;
  return typeof type === "string" ? type : undefined;
}

/** True when a failure of this run will not be retried by BullMQ. */
export function isFinalAttempt(job: JobAttempts): boolean {
  return job.attemptsMade + 1 >= Math.max(1, job.opts.attempts ?? 1);
}

/**
 * Reports a job failure that BullMQ is about to retry or fail, only on the
 * final attempt. Tags: queue and job type (no ids, addresses or payload).
 */
export function reportJobFailure(error: unknown, job: JobAttempts, tags: { queue: string; type?: string | undefined }): void {
  if (!enabled || !isFinalAttempt(job)) return;
  Sentry.withScope((scope) => {
    scope.setTag("queue", tags.queue);
    if (tags.type) scope.setTag("jobType", tags.type);
    Sentry.captureException(error);
  });
}

/** Reports a failure outside a job (e.g. worker initialization). */
export function captureWorkerException(error: unknown, tags: Record<string, string>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

export async function flushWorkerSentry(): Promise<void> {
  if (enabled) await Sentry.flush(2000);
}
