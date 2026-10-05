import type {
  AuditAction,
  AuditActorType,
  BotStatus,
  CustomerAccessStatus,
  CustomerIdentifierType,
  CustomerResolutionSource,
  CustomerSessionRevokedReason,
  CustomerStatus,
  EmailAccountStatus,
  EmailDirection,
  EmailProcessingStatus,
  EmailProvider,
  InboxFilter,
  MultipleMatchPolicy,
  OrganizationPlan,
  OrganizationRole,
  OrganizationStatus,
  RuleMatchMode
} from "./enums.js";

/* API-facing DTOs (camelCase). Repositories map snake_case rows to these. */

export interface Profile {
  id: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: OrganizationPlan;
  status: OrganizationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  organization: Organization;
  role: OrganizationRole;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
  profile: Profile | null;
}

export interface OrganizationSettings {
  organizationId: string;
  timezone: string;
  language: string;
  autoProcessingEnabled: boolean;
  processAttachments: boolean;
  notificationsEnabled: boolean;
  emailNotificationsEnabled: boolean;
  emailRetentionDays: number | null;
  defaultInboxFilter: InboxFilter;
  updatedAt: string;
}

/** Email account as exposed to clients. Never contains credentials. */
export interface EmailAccount {
  id: string;
  organizationId: string;
  provider: EmailProvider;
  status: EmailAccountStatus;
  emailAddress: string;
  displayName: string | null;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerResolution {
  source: CustomerResolutionSource;
  /** Identifier type looked up in customer_identifiers (EMAIL for RECIPIENT / SENDER). */
  identifierType?: CustomerIdentifierType | undefined;
  /** EXTRACTED_FIELD only: name of an EXTRACT action of the bot's rules. */
  field?: string | undefined;
  onMultipleMatches: MultipleMatchPolicy;
}

export interface PortalField {
  /** Key of emails.extracted_data (an EXTRACT action name). */
  key: string;
  label: string;
}

export interface PortalSettings {
  showBody: boolean;
  showAttachments: boolean;
  fields: PortalField[];
}

/** Organization-scoped email service (EmailBot V2). */
export interface Bot {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  status: BotStatus;
  customerResolution: CustomerResolution;
  portalSettings: PortalSettings;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** End customer of an organization (EmailBot V2). Not an auth user. */
export interface Customer {
  id: string;
  organizationId: string;
  displayName: string;
  status: CustomerStatus;
  externalRef: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Value that identifies a customer in emails. Not a credential. */
export interface CustomerIdentifier {
  id: string;
  organizationId: string;
  customerId: string;
  type: CustomerIdentifierType;
  value: string;
  normalizedValue: string;
  /** null = valid for every bot the customer is assigned to. */
  botId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Bot <-> customer relation (the customer may receive that bot's emails while active). */
export interface BotCustomerAssignment {
  organizationId: string;
  botId: string;
  customerId: string;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Embedded summaries (list endpoints). */
  bot?: Pick<Bot, "id" | "name" | "slug" | "status">;
  customer?: Pick<Customer, "id" | "displayName" | "status" | "externalRef">;
}

/**
 * Customer Access ID credential as members see it (EmailBot V2 phase 4). The
 * Access ID itself is never stored nor returned again after generation.
 */
export interface CustomerAccessCredential {
  id: string;
  customerId: string;
  displayPrefix: string;
  last4: string;
  /** "SP-••••••••P4Z7" */
  maskedAccessId: string;
  status: CustomerAccessStatus;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** Customer portal session as members see it (no token, no hash). */
export interface CustomerSession {
  id: string;
  credentialId: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  revokedReason: CustomerSessionRevokedReason | null;
  ip: string | null;
  userAgent: string | null;
}

/** GET /api/portal/me: the minimum the portal UI needs (no internal ids). */
export interface PortalProfile {
  customer: { displayName: string; status: CustomerStatus };
  organization: { name: string };
  bots: Array<{ name: string; portalSettings: PortalSettings }>;
  session: { idleExpiresAt: string; absoluteExpiresAt: string };
}

export interface Category {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isSystem: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailRuleRecord<TCondition = unknown, TAction = unknown> {
  id: string;
  organizationId: string;
  categoryId: string | null;
  /** Bot the rule belongs to; null = general rule (classifies, never routes). */
  botId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  stopProcessing: boolean;
  matchMode: RuleMatchMode;
  conditions: TCondition[];
  actions: TAction[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailSummary {
  id: string;
  organizationId: string;
  emailAccountId: string;
  categoryId: string | null;
  matchedRuleId: string | null;
  /** Bot selected when processed; null = none or an ambiguous tie between bots. */
  botId: string | null;
  direction: EmailDirection;
  processingStatus: EmailProcessingStatus;
  senderEmail: string;
  senderName: string | null;
  toEmails: string[];
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  extractedData: Record<string, unknown>;
  isRead: boolean;
  isImportant: boolean;
  isArchived: boolean;
  /** Number of attachments (metadata rows) of the email. */
  attachmentCount: number;
  createdAt: string;
}

export interface EmailAttachment {
  id: string;
  emailId: string;
  filename: string;
  contentType: string | null;
  fileSize: number | null;
  isInline: boolean;
  storageUploaded: boolean;
  createdAt: string;
}

export interface EmailDetail extends EmailSummary {
  ccEmails: string[];
  textBody: string | null;
  /** Untrusted HTML. Clients must render it sandboxed (no scripts). */
  htmlBody: string | null;
  sentAt: string | null;
  processedAt: string | null;
  attachments: EmailAttachment[];
}

export interface AuditLogEntry {
  id: string;
  organizationId: string;
  actorType: AuditActorType;
  actorUserId: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}
