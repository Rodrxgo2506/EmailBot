import * as Sentry from "@sentry/node";

let enabled = false;

/** Initializes Sentry only when SENTRY_DSN is configured. PII is never sent. */
export function initSentry(dsn: string | null, environment: string): void {
  if (!dsn || enabled) return;

  Sentry.init({
    dsn,
    environment,
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
    beforeSend(event) {
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
      }
      return event;
    }
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
