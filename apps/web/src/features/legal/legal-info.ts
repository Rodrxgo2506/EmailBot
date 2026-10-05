/*
 * Owner data shown on the public legal pages (/privacy, /terms).
 *
 * `null` = not defined yet. The pages then show a visible "pending" marker
 * instead of an invented value. The service owner must complete these before
 * the pages are used for Google OAuth verification.
 */

/** Legal name of the person or entity that operates EmailBot. */
export const SERVICE_OPERATOR: string | null = "Rodrigo Reategui";

/** Public address for privacy and legal requests. */
export const LEGAL_CONTACT_EMAIL: string | null = "reateguirodrigo30@gmail.com";

/** Date of the current version of both documents (V2: bots, customer portal, Gmail push, platform administration). */
export const LEGAL_LAST_UPDATED = "5 de octubre de 2026";

/** Public domains of the service (web app and API). */
export const SERVICE_DOMAIN = "emailbot.app";
export const API_DOMAIN = "api.emailbot.app";

/** Exact Gmail scope requested by EmailBot (packages/shared/src/oauth.ts). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Customer portal session limits (apps/api/src/lib/customer-access.ts, customer_sessions constraints). */
export const PORTAL_SESSION_IDLE_DAYS = 7;
export const PORTAL_SESSION_MAX_DAYS = 30;

/** Lifetime of a portal attachment download link (apps/api/src/modules/portal/data-routes.ts). */
export const PORTAL_ATTACHMENT_LINK_SECONDS = 60;
