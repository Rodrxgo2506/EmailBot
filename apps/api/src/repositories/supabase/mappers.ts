import type {
  AuditLogEntry,
  Bot,
  BotCustomerAssignment,
  Category,
  Customer,
  CustomerIdentifier,
  EmailAccount,
  EmailAttachment,
  EmailDetail,
  EmailSummary,
  Organization,
  OrganizationMember,
  OrganizationSettings,
  Profile
} from "@emailbot/types";
import { ruleActionsDocumentSchema, ruleConditionsDocumentSchema } from "@emailbot/validation";
import type { EmailRule } from "../types.js";

/* snake_case rows (as returned by PostgREST) -> camelCase DTOs. */

// PostgREST rows are untyped here (no generated Database types yet).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const ORGANIZATION_COLUMNS = "id,name,slug,plan,status,created_at,updated_at";

export function toOrganization(row: Row): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const SETTINGS_COLUMNS =
  "organization_id,timezone,language,auto_processing_enabled,process_attachments,notifications_enabled,email_notifications_enabled,email_retention_days,default_inbox_filter,updated_at";

export function toSettings(row: Row): OrganizationSettings {
  return {
    organizationId: row.organization_id,
    timezone: row.timezone,
    language: row.language,
    autoProcessingEnabled: row.auto_processing_enabled,
    processAttachments: row.process_attachments,
    notificationsEnabled: row.notifications_enabled,
    emailNotificationsEnabled: row.email_notifications_enabled,
    emailRetentionDays: row.email_retention_days,
    defaultInboxFilter: row.default_inbox_filter,
    updatedAt: row.updated_at
  };
}

export const MEMBER_COLUMNS = "id,organization_id,user_id,role,created_at,profile:profiles(id,email,full_name,avatar_url)";

function toProfile(row: Row | null | undefined): Profile | null {
  if (!row) return null;
  return { id: row.id, email: row.email, fullName: row.full_name, avatarUrl: row.avatar_url };
}

export function toMember(row: Row): OrganizationMember {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    profile: toProfile(row.profile)
  };
}

/** Safe columns only: credentials, sync cursor and provider metadata are never selected. */
export const EMAIL_ACCOUNT_COLUMNS =
  "id,organization_id,provider,status,email_address,display_name,last_synced_at,last_error_code,last_error_message,created_at,updated_at";

export function toEmailAccount(row: Row): EmailAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    status: row.status,
    emailAddress: row.email_address,
    displayName: row.display_name,
    lastSyncedAt: row.last_synced_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const CATEGORY_COLUMNS =
  "id,organization_id,name,slug,description,color,icon,is_system,sort_order,created_at,updated_at";

export function toCategory(row: Row): Category {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    color: row.color,
    icon: row.icon,
    isSystem: row.is_system,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const BOT_COLUMNS =
  "id,organization_id,name,slug,description,status,customer_resolution,portal_settings,created_by,updated_by,created_at,updated_at";

export function toBot(row: Row): Bot {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    customerResolution: row.customer_resolution,
    portalSettings: row.portal_settings,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const CUSTOMER_COLUMNS = "id,organization_id,display_name,status,external_ref,notes,created_by,created_at,updated_at";

export function toCustomer(row: Row): Customer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    displayName: row.display_name,
    status: row.status,
    externalRef: row.external_ref,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const IDENTIFIER_COLUMNS = "id,organization_id,customer_id,type,value,normalized_value,bot_id,active,created_at,updated_at";

export function toCustomerIdentifier(row: Row): CustomerIdentifier {
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    type: row.type,
    value: row.value,
    normalizedValue: row.normalized_value,
    botId: row.bot_id,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const ASSIGNMENT_COLUMNS = "organization_id,bot_id,customer_id,active,created_by,created_at,updated_at";

/** Many-to-one embeds may come back as an object or a one-element array. */
const single = (value: unknown): Row | null => (Array.isArray(value) ? (value[0] ?? null) : ((value as Row | null) ?? null));

export function toAssignment(row: Row): BotCustomerAssignment {
  const bot = single(row.bot);
  const customer = single(row.customer);
  return {
    organizationId: row.organization_id,
    botId: row.bot_id,
    customerId: row.customer_id,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(bot ? { bot: { id: bot.id, name: bot.name, slug: bot.slug, status: bot.status } } : {}),
    ...(customer
      ? { customer: { id: customer.id, displayName: customer.display_name, status: customer.status, externalRef: customer.external_ref } }
      : {})
  };
}

export const RULE_COLUMNS =
  "id,organization_id,category_id,bot_id,name,description,enabled,priority,stop_processing,match_mode,conditions,actions,created_by,updated_by,created_at,updated_at";

export function toRule(row: Row): EmailRule {
  // Invalid JSON documents (e.g. edited by hand) are exposed as empty lists;
  // the worker skips such rules entirely (see rules-engine parseRuleRow).
  const conditions = ruleConditionsDocumentSchema.safeParse(row.conditions);
  const actions = ruleActionsDocumentSchema.safeParse(row.actions);

  return {
    id: row.id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    botId: row.bot_id ?? null,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    priority: row.priority,
    stopProcessing: row.stop_processing,
    matchMode: row.match_mode,
    conditions: conditions.success ? conditions.data.conditions : [],
    actions: actions.success ? actions.data.actions : [],
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const EMAIL_SUMMARY_COLUMNS =
  "id,organization_id,email_account_id,category_id,matched_rule_id,bot_id,direction,processing_status,sender_email,sender_name,to_emails,subject,snippet,received_at,extracted_data,is_read,is_important,is_archived,created_at,attachment_count:email_attachments(count)";

export const ATTACHMENT_COLUMNS = "id,email_id,filename,content_type,file_size,is_inline,storage_uploaded,created_at";

export const EMAIL_DETAIL_COLUMNS = `${EMAIL_SUMMARY_COLUMNS},cc_emails,text_body,html_body,sent_at,processed_at,email_attachments(${ATTACHMENT_COLUMNS})`;

export function toEmailSummary(row: Row): EmailSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    emailAccountId: row.email_account_id,
    categoryId: row.category_id,
    matchedRuleId: row.matched_rule_id,
    botId: row.bot_id ?? null,
    direction: row.direction,
    processingStatus: row.processing_status,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    toEmails: row.to_emails ?? [],
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    extractedData: row.extracted_data ?? {},
    isRead: row.is_read,
    isImportant: row.is_important,
    isArchived: row.is_archived,
    // PostgREST embedded count: attachment_count = [{ count: n }].
    attachmentCount: Number((row.attachment_count as Row[] | undefined)?.[0]?.count ?? 0),
    createdAt: row.created_at
  };
}

export function toAttachment(row: Row): EmailAttachment {
  return {
    id: row.id,
    emailId: row.email_id,
    filename: row.filename,
    contentType: row.content_type,
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    isInline: row.is_inline,
    storageUploaded: row.storage_uploaded,
    createdAt: row.created_at
  };
}

export function toEmailDetail(row: Row): EmailDetail {
  return {
    ...toEmailSummary(row),
    ccEmails: row.cc_emails ?? [],
    textBody: row.text_body,
    htmlBody: row.html_body,
    sentAt: row.sent_at,
    processedAt: row.processed_at,
    attachments: ((row.email_attachments as Row[] | undefined) ?? []).map(toAttachment)
  };
}

export const AUDIT_COLUMNS =
  "id,organization_id,actor_type,actor_user_id,action,entity_type,entity_id,description,metadata,request_id,created_at";

export function toAuditEntry(row: Row): AuditLogEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    description: row.description,
    metadata: row.metadata ?? {},
    requestId: row.request_id,
    createdAt: row.created_at
  };
}
