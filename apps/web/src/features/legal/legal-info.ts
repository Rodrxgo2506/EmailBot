import { CURRENT_LEGAL_VERSIONS } from "@emailbot/types";

/*
 * Owner data shown on the public legal pages (/privacy, /terms).
 *
 * `null` = not defined yet. The pages then omit the line or show a visible
 * "pending" marker instead of an invented value. Values come from the
 * owner's RUC record (SUNAT); nothing here is inferred.
 */

/** Legal name of the holder of the RUC that operates EmailBot (SUNAT record). */
export const SERVICE_OPERATOR: string | null = "REATEGUI RODRIGUEZ, RODRIGO FARID";

/** Taxpayer type of the holder (SUNAT record). */
export const SERVICE_OPERATOR_TYPE: string | null = "Persona natural con negocio";

/** RUC of the holder. */
export const SERVICE_OPERATOR_RUC: string | null = "10733272231";

/**
 * Fiscal address. The SUNAT record shows no fiscal address ("-") yet: kept
 * null (the line is omitted, never invented). Fill it in once SUNAT shows it.
 */
export const SERVICE_FISCAL_ADDRESS: string | null = null;

/** Public address for support, privacy and legal requests. */
export const LEGAL_CONTACT_EMAIL: string | null = "reateguirodrigo30@gmail.com";

/** Public contact phone. */
export const LEGAL_CONTACT_PHONE: string | null = "971458658";

/** Service / brand name used on the public pages (not a registered trade name). */
export const SERVICE_NAME = "EmailBot";

/**
 * Versions of the documents, from the single source shared with the API
 * (@emailbot/types CURRENT_LEGAL_VERSIONS). Sign-up and the re-acceptance
 * screen record them (public.legal_acceptances); change them there whenever
 * the content of a document changes, together with LEGAL_LAST_UPDATED.
 */
export const TERMS_VERSION = CURRENT_LEGAL_VERSIONS.terms;
export const PRIVACY_VERSION = CURRENT_LEGAL_VERSIONS.privacy;

/** Date of the last change of both documents (update it, with the versions, if the text changes before publication). */
export const LEGAL_LAST_UPDATED = "5 de octubre de 2026";

/** Public domains of the service (web app and API). */
export const SERVICE_DOMAIN = "emailbot.app";
export const API_DOMAIN = "api.emailbot.app";

/** Exact Gmail scope requested by EmailBot (packages/shared/src/oauth.ts GMAIL_SCOPES; checked by legal.test.tsx). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Microsoft scopes requested by EmailBot (packages/shared/src/oauth.ts MICROSOFT_SCOPES; checked by legal.test.tsx). */
export const MICROSOFT_SCOPES = ["Mail.Read", "User.Read", "offline_access"] as const;

/** Customer portal session limits (customer_sessions: 7 days idle, 30 days absolute). */
export const PORTAL_SESSION_IDLE_DAYS = 7;
export const PORTAL_SESSION_MAX_DAYS = 30;

/** Lifetime of a portal attachment download link (@emailbot/shared ATTACHMENT_URL_TTL_SECONDS). */
export const PORTAL_ATTACHMENT_LINK_SECONDS = 60;

/** Default maximum size of a stored attachment (WORKER_MAX_ATTACHMENT_BYTES default). */
export const ATTACHMENT_MAX_MB = 25;

/** Queue jobs (BullMQ DEFAULT_JOB_OPTIONS): completed jobs are kept up to 24 h, failed ones up to 7 days. */
export const QUEUE_COMPLETED_HOURS = 24;
export const QUEUE_FAILED_DAYS = 7;
