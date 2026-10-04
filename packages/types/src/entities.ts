import type {
  AuditAction,
  AuditActorType,
  EmailAccountStatus,
  EmailDirection,
  EmailProcessingStatus,
  EmailProvider,
  InboxFilter,
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
