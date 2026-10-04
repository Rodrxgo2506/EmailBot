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

/** Date of the current version of both documents. */
export const LEGAL_LAST_UPDATED = "3 de octubre de 2026";

/** Exact Gmail scope requested by EmailBot (packages/shared/src/oauth.ts). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
