import type {
  AuditAction,
  AuditActorType,
  BotStatus,
  CustomerStatus,
  EmailAccountStatus,
  EmailProvider,
  OrganizationPlan,
  OrganizationRole,
  OrganizationStatus
} from "./enums.js";

/*
 * Platform administration (EmailBot V2 phase 6, /api/admin/*). Metadata and
 * statistics only: no e-mail content, attachments, credentials, customer
 * identifiers, Access IDs or sessions ever appear in these shapes.
 */

/** Fixed sort options of GET /api/admin/organizations (never a column name). */
export const ADMIN_ORGANIZATION_SORTS = ["created_desc", "created_asc", "name_asc", "name_desc"] as const;
export type AdminOrganizationSort = (typeof ADMIN_ORGANIZATION_SORTS)[number];

export interface AdminStats {
  totalOrganizations: number;
  activeOrganizations: number;
  suspendedOrganizations: number;
  cancelledOrganizations: number;
  totalMembers: number;
  totalBots: number;
  totalCustomers: number;
  totalEmailAccounts: number;
  activeEmailAccounts: number;
  totalEmails: number;
  totalProcessedEmails: number;
  totalDeliveries: number;
}

export interface AdminOwner {
  userId: string;
  email: string | null;
  fullName: string | null;
}

export interface AdminOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  /** Cache of the plan of the ACTIVE subscription (null = none). */
  plan: OrganizationPlan | null;
  status: OrganizationStatus;
  owner: AdminOwner | null;
  membersCount: number;
  botsCount: number;
  customersCount: number;
  emailAccountsCount: number;
  processedEmailsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOrganizationDetail extends AdminOrganizationSummary {
  rulesCount: number;
  emailsCount: number;
  deliveriesCount: number;
}

export interface AdminMember {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: OrganizationRole;
  joinedAt: string;
}

export interface AdminBot {
  id: string;
  name: string;
  slug: string;
  status: BotStatus;
  rulesCount: number;
  activeCustomersCount: number;
  deliveriesCount: number;
  createdAt: string;
}

export interface AdminCustomer {
  id: string;
  displayName: string;
  status: CustomerStatus;
  /** Names of the bots of its ACTIVE assignments. */
  bots: string[];
  deliveriesCount: number;
  createdAt: string;
}

export interface AdminEmailAccount {
  id: string;
  provider: EmailProvider;
  emailAddress: string;
  status: EmailAccountStatus;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  watchExpiresAt: string | null;
  watchErrorCode: string | null;
  createdAt: string;
}

/** Operational activity of the organizations (their audit_logs: event names only). */
export interface AdminActivityItem {
  id: string;
  organization: { id: string; name: string };
  actorType: AuditActorType;
  action: AuditAction;
  entityType: string | null;
  event: string | null;
  createdAt: string;
}

/** Platform administration audit (platform_audit_logs). */
export interface AdminAuditEntry {
  id: string;
  actor: { userId: string | null; email: string | null };
  action: string;
  targetType: string;
  targetId: string | null;
  organization: { id: string; name: string | null } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Offset page without a total count (logs can be large): `hasMore` tells whether a next page exists. */
export interface OffsetPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}
