/*
 * Sentry event hygiene shared by the API and the worker (F8-B). Structural
 * types only: this package does not depend on @sentry/node.
 *
 * Error events must never carry credentials, mailbox content or personal
 * data: request headers, cookies, bodies and query strings are removed, user
 * data is dropped, and free text (messages, exception values, breadcrumbs) has
 * email addresses, tokens and URL paths / query strings masked. HTTP / fetch /
 * console breadcrumbs are discarded entirely: their URLs can carry PostgREST
 * filters with addresses, Gmail history ids or Graph ids.
 */

export interface ScrubbableBreadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: { [key: string]: unknown };
}

export interface ScrubbableEvent {
  message?: string;
  request?: { url?: string; headers?: unknown; cookies?: unknown; data?: unknown; query_string?: unknown; env?: unknown };
  user?: unknown;
  extra?: unknown;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: ScrubbableBreadcrumb[];
}

const EMAIL_ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Path and query of any URL: Gmail / Graph ids, PostgREST filters with addresses.
const URL_PATH_AND_QUERY = /(https?:\/\/[^\s/?#"'<>]+)[/?#][^\s"'<>]*/gi;
const SECRETS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w.~+/-]+=*/gi, "Bearer [token]"],
  // JWT (Supabase access tokens, OIDC id tokens).
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, "[token]"],
  // Google OAuth access / refresh tokens.
  [/\bya29\.[\w.-]+/g, "[token]"],
  [/\b1\/\/[\w-]{20,}/g, "[token]"],
  // key=value credentials in free text (form bodies, query strings already cut).
  [/\b(access_token|refresh_token|id_token|client_secret|password|token|code)=[^&\s"']+/gi, "$1=[redacted]"]
];
const DROPPED_BREADCRUMB_CATEGORIES = new Set(["http", "fetch", "xhr", "console", "navigation"]);

/** Masks email addresses, tokens and URL paths / query strings (the origin is kept) in free text. */
export function scrubSentryText(text: string): string {
  let result = text.replace(URL_PATH_AND_QUERY, "$1/[redacted]");
  for (const [pattern, replacement] of SECRETS) result = result.replace(pattern, replacement);
  return result.replace(EMAIL_ADDRESS, "[email]");
}

/** beforeBreadcrumb: drops network / console breadcrumbs, scrubs the rest and removes their data. */
export function filterSentryBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B | null {
  if (breadcrumb.type === "http" || DROPPED_BREADCRUMB_CATEGORIES.has(breadcrumb.category ?? "")) return null;
  delete breadcrumb.data;
  if (typeof breadcrumb.message === "string") breadcrumb.message = scrubSentryText(breadcrumb.message);
  return breadcrumb;
}

/** beforeSend: removes request data and user data, scrubs free text and breadcrumbs. */
export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    delete event.request.env;
    if (typeof event.request.url === "string") event.request.url = event.request.url.split(/[?#]/)[0] ?? "";
  }
  delete event.user;
  delete event.extra;
  if (typeof event.message === "string") event.message = scrubSentryText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") exception.value = scrubSentryText(exception.value);
  }
  const breadcrumbs = event.breadcrumbs ?? [];
  for (let index = breadcrumbs.length - 1; index >= 0; index--) {
    if (filterSentryBreadcrumb(breadcrumbs[index]!) === null) breadcrumbs.splice(index, 1);
  }
  return event;
}

/**
 * Release of this build: the commit Render deploys (RENDER_GIT_COMMIT, set by
 * the platform). Undefined locally or when the value does not look like a
 * commit hash.
 */
export function sentryRelease(env: Record<string, string | undefined>): string | undefined {
  const commit = env.RENDER_GIT_COMMIT?.trim();
  return commit && /^[0-9a-f]{7,64}$/i.test(commit) ? commit : undefined;
}
