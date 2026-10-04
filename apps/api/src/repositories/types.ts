import type {
  AuditAction,
  AuditLogEntry,
  Bot,
  BotCustomerAssignment,
  BotStatus,
  Category,
  Customer,
  CustomerIdentifier,
  CustomerIdentifierType,
  CustomerResolution,
  CustomerStatus,
  EmailAccount,
  EmailAccountStatus,
  EmailAttachment,
  EmailDetail,
  EmailProvider,
  EmailRuleRecord,
  EmailSummary,
  Organization,
  OrganizationMember,
  OrganizationMembership,
  OrganizationRole,
  OrganizationSettings,
  OrganizationStatus,
  Paginated,
  PortalSettings
} from "@emailbot/types";
import type { CustomerListQuery, EmailListQuery, RuleAction, RuleCondition } from "@emailbot/validation";

/*
 * Data-access contracts.
 *
 * `Repositories` are created PER REQUEST from the caller's access token, so
 * every query runs through PostgREST as the `authenticated` role and RLS is
 * always enforced. Every method also takes the active organization id and
 * filters by it explicitly: a user can belong to several organizations, and
 * RLS alone would return rows of all of them.
 *
 * `PrivilegedOperations` use the service role (bypasses RLS). They are only
 * used for operations the authenticated role is intentionally not allowed to
 * do (credentials, audit writes, signed URLs, cross-user lookups) and are
 * always called AFTER the API has verified membership and role.
 */

export type EmailRule = EmailRuleRecord<RuleCondition, RuleAction>;

export interface MembershipRepository {
  listForUser(userId: string): Promise<OrganizationMembership[]>;
  findRole(userId: string, organizationId: string): Promise<OrganizationRole | null>;
  /** Role and organization status in one query (organization context of every request). */
  findAccess(
    userId: string,
    organizationId: string
  ): Promise<{ role: OrganizationRole; organizationStatus: OrganizationStatus } | null>;
}

export interface OrganizationRepository {
  create(name: string, slug: string): Promise<string>;
  get(organizationId: string): Promise<Organization | null>;
  update(organizationId: string, patch: { name?: string; slug?: string }): Promise<Organization | null>;
  getSettings(organizationId: string): Promise<OrganizationSettings | null>;
  updateSettings(organizationId: string, patch: Record<string, unknown>): Promise<OrganizationSettings | null>;
  transferOwnership(organizationId: string, newOwnerUserId: string): Promise<void>;
}

export interface MemberRepository {
  list(organizationId: string): Promise<OrganizationMember[]>;
  get(organizationId: string, memberId: string): Promise<OrganizationMember | null>;
  add(organizationId: string, userId: string, role: OrganizationRole): Promise<OrganizationMember>;
  updateRole(organizationId: string, memberId: string, role: OrganizationRole): Promise<OrganizationMember | null>;
  remove(organizationId: string, memberId: string): Promise<boolean>;
}

export interface EmailAccountRepository {
  list(organizationId: string): Promise<EmailAccount[]>;
  get(organizationId: string, id: string): Promise<EmailAccount | null>;
  update(
    organizationId: string,
    id: string,
    patch: { status?: EmailAccountStatus; display_name?: string | null }
  ): Promise<EmailAccount | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export interface CategoryInsert {
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  sort_order?: number;
}

export interface CategoryRepository {
  list(organizationId: string): Promise<Category[]>;
  get(organizationId: string, id: string): Promise<Category | null>;
  create(organizationId: string, input: CategoryInsert): Promise<Category>;
  update(organizationId: string, id: string, patch: Partial<CategoryInsert>): Promise<Category | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export interface BotWrite {
  name?: string;
  slug?: string;
  description?: string | null;
  status?: BotStatus;
  customerResolution?: CustomerResolution;
  portalSettings?: PortalSettings;
}

export interface BotRepository {
  list(organizationId: string): Promise<Bot[]>;
  get(organizationId: string, id: string): Promise<Bot | null>;
  create(organizationId: string, userId: string, input: BotWrite & { name: string; slug: string }): Promise<Bot>;
  update(organizationId: string, id: string, userId: string, patch: BotWrite): Promise<Bot | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
  /** Whether any processed email was routed to the bot (history that a delete would orphan). */
  hasEmails(organizationId: string, id: string): Promise<boolean>;
  /** Whether customers are assigned to the bot or identifiers are scoped to it (the database blocks the delete). */
  hasCustomerLinks(organizationId: string, id: string): Promise<boolean>;
}

export interface CustomerWrite {
  displayName?: string;
  status?: CustomerStatus;
  externalRef?: string | null;
  notes?: string | null;
}

/** Customers are suspended, never deleted, by members (no delete method). */
export interface CustomerRepository {
  /** Scoped to the organization; search matches name, external ref or a normalized identifier. */
  list(organizationId: string, query: CustomerListQuery): Promise<Paginated<Customer>>;
  get(organizationId: string, id: string): Promise<Customer | null>;
  create(organizationId: string, userId: string, input: CustomerWrite & { displayName: string }): Promise<Customer>;
  update(organizationId: string, id: string, patch: CustomerWrite): Promise<Customer | null>;
}

export interface CustomerIdentifierWrite {
  value?: string;
  normalizedValue?: string;
  botId?: string | null;
  active?: boolean;
}

export interface CustomerIdentifierRepository {
  list(organizationId: string, customerId: string): Promise<CustomerIdentifier[]>;
  get(organizationId: string, customerId: string, id: string): Promise<CustomerIdentifier | null>;
  create(
    organizationId: string,
    customerId: string,
    input: { type: CustomerIdentifierType; value: string; normalizedValue: string; botId: string | null; active: boolean }
  ): Promise<CustomerIdentifier>;
  update(organizationId: string, customerId: string, id: string, patch: CustomerIdentifierWrite): Promise<CustomerIdentifier | null>;
  remove(organizationId: string, customerId: string, id: string): Promise<boolean>;
}

export interface BotCustomerAssignmentRepository {
  /** With the customer summary embedded. */
  listForBot(organizationId: string, botId: string): Promise<BotCustomerAssignment[]>;
  /** With the bot summary embedded. */
  listForCustomer(organizationId: string, customerId: string): Promise<BotCustomerAssignment[]>;
  get(organizationId: string, botId: string, customerId: string): Promise<BotCustomerAssignment | null>;
  create(organizationId: string, userId: string, botId: string, customerId: string, active: boolean): Promise<BotCustomerAssignment>;
  update(organizationId: string, botId: string, customerId: string, active: boolean): Promise<BotCustomerAssignment | null>;
  remove(organizationId: string, botId: string, customerId: string): Promise<boolean>;
}

export interface RuleWrite {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  priority?: number;
  stopProcessing?: boolean;
  matchMode?: "AND" | "OR";
  categoryId?: string | null;
  botId?: string | null;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
}

export interface RuleRepository {
  /** filter.botId: rules of one bot; null = general rules only; omitted = all. */
  list(organizationId: string, filter?: { botId?: string | null }): Promise<EmailRule[]>;
  get(organizationId: string, id: string): Promise<EmailRule | null>;
  create(organizationId: string, userId: string, input: RuleWrite & { name: string }): Promise<EmailRule>;
  update(organizationId: string, id: string, userId: string, patch: RuleWrite): Promise<EmailRule | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export interface EmailPatch {
  is_read?: boolean;
  is_important?: boolean;
  is_archived?: boolean;
  category_id?: string | null;
}

export interface EmailRepository {
  list(organizationId: string, query: EmailListQuery): Promise<Paginated<EmailSummary>>;
  get(organizationId: string, id: string): Promise<EmailDetail | null>;
  update(organizationId: string, id: string, patch: EmailPatch): Promise<EmailSummary | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export interface StoredAttachment extends EmailAttachment {
  organizationId: string;
  storageBucket: string | null;
  storagePath: string | null;
}

/** Location of a stored attachment object (cleanup when its email/account is deleted). */
export interface StoredObjectRef {
  id: string;
  emailId: string;
  storageBucket: string | null;
  storagePath: string | null;
}

export interface AttachmentRepository {
  get(organizationId: string, id: string): Promise<StoredAttachment | null>;
  /** Stored objects of one email or of every email of one account (RLS applies). */
  listStoredObjects(organizationId: string, scope: { emailId: string } | { accountId: string }): Promise<StoredObjectRef[]>;
}

export interface AuditRepository {
  list(
    organizationId: string,
    query: { page: number; pageSize: number; action?: AuditAction | undefined; entityType?: string | undefined }
  ): Promise<Paginated<AuditLogEntry>>;
}

export interface Repositories {
  memberships: MembershipRepository;
  organizations: OrganizationRepository;
  members: MemberRepository;
  emailAccounts: EmailAccountRepository;
  categories: CategoryRepository;
  bots: BotRepository;
  customers: CustomerRepository;
  customerIdentifiers: CustomerIdentifierRepository;
  botCustomers: BotCustomerAssignmentRepository;
  rules: RuleRepository;
  emails: EmailRepository;
  attachments: AttachmentRepository;
  audit: AuditRepository;
}

export interface AuditEntry {
  organizationId: string;
  actorUserId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null | undefined;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
}

export interface OAuthAccountUpsert {
  organizationId: string;
  provider: Exclude<EmailProvider, "IMAP">;
  emailAddress: string;
  displayName: string | null;
  providerAccountId: string | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
  syncCursor: string | null;
}

export interface ImapAccountInsert {
  organizationId: string;
  emailAddress: string;
  displayName: string | null;
  passwordEncrypted: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
}

export interface PrivilegedOperations {
  findProfileIdByEmail(email: string): Promise<string | null>;
  getMemberRole(organizationId: string, userId: string): Promise<OrganizationRole | null>;
  upsertOAuthEmailAccount(input: OAuthAccountUpsert): Promise<{ account: EmailAccount; created: boolean }>;
  createImapEmailAccount(input: ImapAccountInsert): Promise<EmailAccount>;
  disconnectEmailAccount(organizationId: string, id: string): Promise<EmailAccount | null>;
  insertAuditLog(entry: AuditEntry): Promise<void>;
  createSignedDownloadUrl(bucket: string, path: string, expiresInSeconds: number, filename: string): Promise<string>;
  /** Deletes Storage objects; returns how many paths could not be removed. */
  removeStorageObjects(bucket: string, paths: string[]): Promise<{ failed: number }>;
}
