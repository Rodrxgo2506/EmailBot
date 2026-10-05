/**
 * Enumerations mirrored 1:1 from the PostgreSQL enums defined in
 * supabase/migrations. Keep them in sync when a migration changes an enum.
 */

export const ORGANIZATION_ROLES = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_PLANS = ["FREE", "PRO", "BUSINESS"] as const;
export type OrganizationPlan = (typeof ORGANIZATION_PLANS)[number];

export const ORGANIZATION_STATUSES = ["ACTIVE", "SUSPENDED", "CANCELLED"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const EMAIL_PROVIDERS = ["GMAIL", "MICROSOFT", "IMAP"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const EMAIL_ACCOUNT_STATUSES = ["ACTIVE", "PAUSED", "ERROR", "DISCONNECTED"] as const;
export type EmailAccountStatus = (typeof EMAIL_ACCOUNT_STATUSES)[number];

export const BOT_STATUSES = ["ACTIVE", "PAUSED"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

/*
 * Customer routing configuration of a bot (EmailBot V2). Stored in
 * bots.customer_resolution (JSONB, validated by @emailbot/validation); the
 * identifier types become a PostgreSQL enum with customer_identifiers.
 */
export const CUSTOMER_RESOLUTION_SOURCES = ["NONE", "RECIPIENT", "SENDER", "EXTRACTED_FIELD"] as const;
export type CustomerResolutionSource = (typeof CUSTOMER_RESOLUTION_SOURCES)[number];

export const CUSTOMER_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const CUSTOMER_IDENTIFIER_TYPES = ["EMAIL", "PHONE", "USERNAME", "EXTERNAL_ID", "CUSTOM"] as const;
export type CustomerIdentifierType = (typeof CUSTOMER_IDENTIFIER_TYPES)[number];

/** EmailBot V2 phase 4: customer Access ID credential. Expiration is a date, not a status. */
export const CUSTOMER_ACCESS_STATUSES = ["ACTIVE", "REVOKED"] as const;
export type CustomerAccessStatus = (typeof CUSTOMER_ACCESS_STATUSES)[number];

export const CUSTOMER_SESSION_REVOKED_REASONS = [
  "LOGOUT",
  "REVOKED",
  "REVOKED_ALL",
  "CREDENTIAL_REGENERATED",
  "CREDENTIAL_REVOKED",
  "CUSTOMER_SUSPENDED"
] as const;
export type CustomerSessionRevokedReason = (typeof CUSTOMER_SESSION_REVOKED_REASONS)[number];

export const MULTIPLE_MATCH_POLICIES = ["LEAVE_UNASSIGNED", "DELIVER_ALL"] as const;
export type MultipleMatchPolicy = (typeof MULTIPLE_MATCH_POLICIES)[number];

export const RULE_MATCH_MODES = ["AND", "OR"] as const;
export type RuleMatchMode = (typeof RULE_MATCH_MODES)[number];

export const EMAIL_PROCESSING_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "IGNORED"
] as const;
export type EmailProcessingStatus = (typeof EMAIL_PROCESSING_STATUSES)[number];

export const EMAIL_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

export const AUDIT_ACTOR_TYPES = ["USER", "SYSTEM"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "CONNECT",
  "DISCONNECT",
  "LOGIN",
  "LOGOUT",
  "PROCESS",
  "FAIL",
  "READ",
  "ARCHIVE",
  "UNARCHIVE",
  "MARK_READ",
  "MARK_UNREAD",
  "MARK_IMPORTANT",
  "MARK_NOT_IMPORTANT",
  "ROLE_CHANGE",
  "OWNERSHIP_TRANSFER"
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Values allowed by the organization_settings_inbox_filter check constraint. */
export const INBOX_FILTERS = ["ALL", "UNREAD", "IMPORTANT", "ATTACHMENTS"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
