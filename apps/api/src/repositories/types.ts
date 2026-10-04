import type {
  AuditAction,
  AuditLogEntry,
  Category,
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
  Paginated
} from "@emailbot/types";
import type { EmailListQuery, RuleAction, RuleCondition } from "@emailbot/validation";

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

export interface RuleWrite {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  priority?: number;
  stopProcessing?: boolean;
  matchMode?: "AND" | "OR";
  categoryId?: string | null;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
}

export interface RuleRepository {
  list(organizationId: string): Promise<EmailRule[]>;
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
