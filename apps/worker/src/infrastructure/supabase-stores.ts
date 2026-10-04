import type { EmailRuleRow } from "@emailbot/rules-engine";
import { REALTIME_REDIS_CHANNEL } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Redis } from "ioredis";
import type {
  AccountStore,
  AttachmentStorage,
  EmailStore,
  OrganizationProcessingSettings,
  RealtimePublisher
} from "../pipeline/ports.js";
import type { WorkerAccount } from "../providers/types.js";

/*
 * SERVICE ROLE persistence for the worker. The worker has no end-user JWT,
 * so tenant isolation is preserved by always scoping writes with the
 * organization/account ids taken from the database (never from a client),
 * plus the cross-tenant triggers of migration 3.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ACCOUNT_COLUMNS =
  "id,organization_id,provider,status,email_address,sync_cursor,provider_metadata,access_token_encrypted,refresh_token_encrypted,token_expires_at";

function check<T>(result: { data: T; error: { message: string; code?: string } | null }, operation: string): T {
  if (result.error) {
    const error = new Error(`${operation} failed: ${result.error.message}`) as Error & { code?: string | undefined };
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}

function toAccount(row: Row): WorkerAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    status: row.status,
    emailAddress: row.email_address,
    syncCursor: row.sync_cursor,
    providerMetadata: row.provider_metadata ?? {},
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    tokenExpiresAt: row.token_expires_at
  };
}

export function createAccountStore(db: SupabaseClient): AccountStore {
  return {
    async getAccount(id) {
      const row = check(await db.from("email_accounts").select(ACCOUNT_COLUMNS).eq("id", id).maybeSingle(), "getAccount");
      return row ? toAccount(row as Row) : null;
    },

    async findActiveAccountsByAddress(provider, emailAddress) {
      const rows = check(
        await db
          .from("email_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("provider", provider)
          .eq("status", "ACTIVE")
          .eq("email_address", emailAddress.toLowerCase()),
        "findActiveAccountsByAddress"
      ) as Row[];
      return rows.map(toAccount);
    },

    async findAccountBySubscription(subscriptionId) {
      const row = check(
        await db
          .from("email_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("provider", "MICROSOFT")
          .eq("provider_metadata->>subscriptionId", subscriptionId)
          .maybeSingle(),
        "findAccountBySubscription"
      );
      return row ? toAccount(row as Row) : null;
    },

    async listActiveOAuthAccounts(limit) {
      const rows = check(
        await db
          .from("email_accounts")
          .select("id,organization_id")
          .eq("status", "ACTIVE")
          .in("provider", ["GMAIL", "MICROSOFT"])
          .order("last_synced_at", { ascending: true, nullsFirst: true })
          .limit(limit),
        "listActiveOAuthAccounts"
      ) as Row[];
      return rows.map((row) => ({ id: row.id, organizationId: row.organization_id }));
    },

    async updateSyncState(id, state) {
      check(
        await db
          .from("email_accounts")
          .update({
            sync_cursor: state.syncCursor,
            last_synced_at: state.lastSyncedAt,
            last_error_code: null,
            last_error_message: null
          })
          .eq("id", id),
        "updateSyncState"
      );
    },

    async saveTokens(id, tokens) {
      const columns: Row = {
        access_token_encrypted: tokens.accessTokenEncrypted,
        token_expires_at: tokens.tokenExpiresAt
      };
      if (tokens.refreshTokenEncrypted) columns.refresh_token_encrypted = tokens.refreshTokenEncrypted;
      check(await db.from("email_accounts").update(columns).eq("id", id), "saveTokens");
    },

    async markError(id, error) {
      check(
        await db
          .from("email_accounts")
          .update({
            last_error_code: error.code.slice(0, 100),
            last_error_message: error.message.slice(0, 2000),
            ...(error.status ? { status: error.status } : {})
          })
          .eq("id", id),
        "markError"
      );
    }
  };
}

export function createEmailStore(db: SupabaseClient): EmailStore {
  return {
    async findEmail(emailAccountId, providerMessageId) {
      const row = check(
        await db
          .from("emails")
          .select("id,processing_status,processing_attempts,processing_started_at")
          .eq("email_account_id", emailAccountId)
          .eq("provider_message_id", providerMessageId)
          .maybeSingle(),
        "findEmail"
      ) as Row | null;
      return row
        ? {
            id: row.id,
            processingStatus: row.processing_status,
            processingAttempts: row.processing_attempts,
            processingStartedAt: row.processing_started_at
          }
        : null;
    },

    async updateProcessingState(emailId, state) {
      const columns: Row = { processing_status: state.status };
      if (state.attempts !== undefined) columns.processing_attempts = state.attempts;
      if (state.processedAt !== undefined) columns.processed_at = state.processedAt;
      if (state.errorCode !== undefined) columns.processing_error_code = state.errorCode?.slice(0, 150) ?? null;
      if (state.errorMessage !== undefined) columns.processing_error_message = state.errorMessage?.slice(0, 4000) ?? null;
      check(await db.from("emails").update(columns).eq("id", emailId), "updateProcessingState");
    },

    async listIncompleteEmails({ startedBefore, limit }) {
      const rows = check(
        await db
          .from("emails")
          .select("id,organization_id,email_account_id,provider_message_id,processing_attempts,email_accounts!inner(provider,status)")
          .in("processing_status", ["RECEIVED", "PROCESSING"])
          .lt("processing_started_at", startedBefore)
          .eq("email_accounts.status", "ACTIVE")
          .order("processing_started_at", { ascending: true })
          .limit(limit),
        "listIncompleteEmails"
      ) as Row[];
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        emailAccountId: row.email_account_id,
        provider: row.email_accounts.provider,
        providerMessageId: row.provider_message_id,
        processingAttempts: row.processing_attempts
      }));
    },

    async loadEnabledRules(organizationId) {
      return check(
        await db
          .from("email_rules")
          .select("id,name,enabled,priority,stop_processing,match_mode,category_id,conditions,actions,created_at")
          .eq("organization_id", organizationId)
          .eq("enabled", true)
          .order("priority", { ascending: true })
          .order("created_at", { ascending: true }),
        "loadEnabledRules"
      ) as EmailRuleRow[];
    },

    async loadSettings(organizationId): Promise<OrganizationProcessingSettings> {
      const row = check(
        await db
          .from("organization_settings")
          .select("auto_processing_enabled,process_attachments,notifications_enabled,email_notifications_enabled")
          .eq("organization_id", organizationId)
          .maybeSingle(),
        "loadSettings"
      ) as Row | null;

      // Defaults of migration 4 if the row is missing.
      return {
        autoProcessingEnabled: row?.auto_processing_enabled ?? true,
        processAttachments: row?.process_attachments ?? true,
        notificationsEnabled: row?.notifications_enabled ?? true,
        emailNotificationsEnabled: row?.email_notifications_enabled ?? true
      };
    },

    async insertEmail(row) {
      // Relies on the unique index emails_account_provider_message_unique_idx (migration 5).
      const rows = check(
        await db
          .from("emails")
          .upsert(row, { onConflict: "email_account_id,provider_message_id", ignoreDuplicates: true })
          .select("id"),
        "insertEmail"
      ) as Row[];
      return rows[0] ? { id: rows[0].id as string } : null;
    },

    async insertAttachments(rows) {
      // Unique (email_id, provider_attachment_id) of migration 9: a concurrent or
      // resumed insert of the same attachment is a no-op (NULL ids never conflict).
      const inserted = check(
        await db
          .from("email_attachments")
          .upsert(rows, { onConflict: "email_id,provider_attachment_id", ignoreDuplicates: true })
          .select("id,provider_attachment_id"),
        "insertAttachments"
      ) as Row[];
      // PostgREST returns rows in insertion order.
      return inserted.map((row) => ({ id: row.id, providerAttachmentId: row.provider_attachment_id }));
    },

    async listAttachments(emailId) {
      const rows = check(
        await db
          .from("email_attachments")
          .select("id,provider_attachment_id,filename,content_type,file_size,is_inline,storage_uploaded")
          .eq("email_id", emailId)
          .order("created_at", { ascending: true }),
        "listAttachments"
      ) as Row[];
      return rows.map((row) => ({
        id: row.id,
        providerAttachmentId: row.provider_attachment_id,
        filename: row.filename,
        contentType: row.content_type,
        fileSize: row.file_size === null ? null : Number(row.file_size),
        isInline: row.is_inline,
        storageUploaded: row.storage_uploaded
      }));
    },

    async markAttachmentStored(attachmentId, bucket, path) {
      check(
        await db
          .from("email_attachments")
          .update({ storage_bucket: bucket, storage_path: path, storage_uploaded: true })
          .eq("id", attachmentId),
        "markAttachmentStored"
      );
    }
  };
}

export function createAttachmentStorage(db: SupabaseClient): AttachmentStorage {
  return {
    async upload(bucket, path, content, contentType) {
      const { error } = await db.storage.from(bucket).upload(path, content, {
        contentType: contentType ?? "application/octet-stream",
        upsert: true
      });
      if (error) throw new Error(`Storage upload failed: ${error.message}`);
    },
    async exists(bucket, path) {
      const { data, error } = await db.storage.from(bucket).exists(path);
      if (data) return true;
      // 400/404 = not found; anything else is a real failure (retried by the caller).
      const status = (error as { status?: number; statusCode?: string } | null)?.status;
      if (!error || status === 400 || status === 404) return false;
      throw new Error(`Storage existence check failed: ${error.message}`);
    }
  };
}

export function createRealtimePublisher(redis: Redis): RealtimePublisher {
  return {
    async publish(event) {
      await redis.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(event));
    }
  };
}
