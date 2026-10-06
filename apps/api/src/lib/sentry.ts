import { filterSentryBreadcrumb, scrubSentryEvent } from "@emailbot/shared";
import * as Sentry from "@sentry/node";

let enabled = false;

/**
 * Initializes Sentry only when SENTRY_DSN is configured. PII is never sent:
 * no request data, user data or network breadcrumbs, and free text is
 * scrubbed (@emailbot/shared sentry.ts). `release` is the deployed commit
 * (RENDER_GIT_COMMIT) when known.
 */
export function initSentry(dsn: string | null, environment: string, release?: string): void {
  if (!dsn || enabled) return;

  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate: 0,
    // Collect nothing that could contain credentials or mailbox content:
    // the SDK defaults include headers, bodies and stack-frame local variables.
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

export function captureException(error: unknown, context?: Record<string, string | undefined>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value) scope.setTag(key, value);
    }
    Sentry.captureException(error);
  });
}

export async function flushSentry(): Promise<void> {
  if (enabled) await Sentry.flush(2000);
}
