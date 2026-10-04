import { redactSensitive } from "@emailbot/shared";
import type { OrganizationRole } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, unwrap } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";
import { EMAIL_ACCOUNT_COLUMNS, toEmailAccount, type Row } from "./mappers.js";

/**
 * Adds the `download` parameter (Content-Disposition file name) to a signed
 * URL, encoded exactly once. storage-js `createSignedUrl(..., { download })`
 * encodes the name with URLSearchParams and then runs encodeURI over the whole
 * URL, so "Cotización.xlsx" was downloaded as "Cotizaci%C3%B3n.xlsx".
 */
export function withDownloadName(signedUrl: string, filename: string): string {
  const separator = signedUrl.includes("?") ? "&" : "?";
  return `${signedUrl}${separator}download=${encodeURIComponent(filename)}`;
}

/**
 * SERVICE ROLE operations (bypass RLS). Keep this surface small and only
 * call it after the route has authenticated the user and checked the
 * organization role. Never return credential columns from here.
 */
export function privilegedOperations(service: SupabaseClient): PrivilegedOperations {
  return {
    async findProfileIdByEmail(email) {
      const row = unwrap(
        await service.from("profiles").select("id").eq("email", email.trim().toLowerCase()).limit(1).maybeSingle()
      ) as Row | null;
      if (!row?.id) return null;

      // Only users who proved ownership of the address can be added by email;
      // otherwise anyone could pre-register someone else's address.
      const { data, error } = await service.auth.admin.getUserById(row.id as string);
      if (error || !data.user?.email_confirmed_at) return null;
      return row.id as string;
    },

    async getMemberRole(organizationId, userId) {
      const row = unwrap(
        await service
          .from("organization_members")
          .select("role")
          .eq("organization_id", organizationId)
          .eq("user_id", userId)
          .maybeSingle()
      ) as Row | null;
      return (row?.role as OrganizationRole | undefined) ?? null;
    },

    async upsertOAuthEmailAccount(input) {
      const emailAddress = input.emailAddress.trim().toLowerCase();

      const existing = unwrap(
        await service
          .from("email_accounts")
          .select("id")
          .eq("organization_id", input.organizationId)
          .eq("provider", input.provider)
          .eq("email_address", emailAddress)
          .maybeSingle()
      ) as Row | null;

      const columns: Record<string, unknown> = {
        status: "ACTIVE",
        display_name: input.displayName,
        provider_account_id: input.providerAccountId,
        access_token_encrypted: input.accessTokenEncrypted,
        token_expires_at: input.tokenExpiresAt,
        sync_cursor: input.syncCursor,
        last_error_code: null,
        last_error_message: null
      };
      // Google only returns a refresh token on (re)consent: keep the old one otherwise.
      if (input.refreshTokenEncrypted) columns.refresh_token_encrypted = input.refreshTokenEncrypted;

      if (existing) {
        const row = unwrap(
          await service
            .from("email_accounts")
            .update(columns)
            .eq("id", existing.id)
            .eq("organization_id", input.organizationId)
            .select(EMAIL_ACCOUNT_COLUMNS)
            .single()
        ) as Row;
        return { account: toEmailAccount(row), created: false };
      }

      if (!input.refreshTokenEncrypted) {
        throw new AppError(
          422,
          "MISSING_REFRESH_TOKEN",
          "The provider did not return a refresh token; offline access is required"
        );
      }

      const row = unwrap(
        await service
          .from("email_accounts")
          .insert({
            ...columns,
            organization_id: input.organizationId,
            provider: input.provider,
            email_address: emailAddress
          })
          .select(EMAIL_ACCOUNT_COLUMNS)
          .single()
      ) as Row;
      return { account: toEmailAccount(row), created: true };
    },

    async createImapEmailAccount(input) {
      const row = unwrap(
        await service
          .from("email_accounts")
          .insert({
            organization_id: input.organizationId,
            provider: "IMAP",
            email_address: input.emailAddress.trim().toLowerCase(),
            display_name: input.displayName,
            // Credentials column documented by migration 2 as "OAuth / IMAP credentials".
            access_token_encrypted: input.passwordEncrypted,
            // Non-secret connection settings only.
            provider_metadata: { imap: { host: input.host, port: input.port, secure: input.secure, username: input.username } },
            // IMAP synchronization is not implemented yet (see apps/worker/src/providers/imap).
            status: "PAUSED",
            last_error_code: "IMAP_SYNC_NOT_IMPLEMENTED",
            last_error_message: "IMAP synchronization is not available yet. Credentials were stored encrypted."
          })
          .select(EMAIL_ACCOUNT_COLUMNS)
          .single()
      ) as Row;
      return toEmailAccount(row);
    },

    async disconnectEmailAccount(organizationId, id) {
      const row = unwrap(
        await service
          .from("email_accounts")
          .update({
            status: "DISCONNECTED",
            access_token_encrypted: null,
            refresh_token_encrypted: null,
            token_expires_at: null,
            sync_cursor: null,
            last_error_code: null,
            last_error_message: null
          })
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(EMAIL_ACCOUNT_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toEmailAccount(row) : null;
    },

    async insertAuditLog(entry) {
      unwrap(
        await service.from("audit_logs").insert({
          organization_id: entry.organizationId,
          actor_type: entry.actorUserId ? "USER" : "SYSTEM",
          actor_user_id: entry.actorUserId,
          action: entry.action,
          entity_type: entry.entityType,
          entity_id: entry.entityId ?? null,
          description: entry.description?.slice(0, 2000) ?? null,
          metadata: redactSensitive(entry.metadata ?? {}),
          request_id: entry.requestId?.slice(0, 200) ?? null
        })
      );
    },

    async createSignedDownloadUrl(bucket, path, expiresInSeconds, filename) {
      const { data, error } = await service.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      if (error || !data) {
        throw new AppError(502, "STORAGE_ERROR", "Could not create a download URL");
      }
      return withDownloadName(data.signedUrl, filename);
    },

    async removeStorageObjects(bucket, paths) {
      let failed = 0;
      // Storage accepts up to 1000 keys per request.
      for (let index = 0; index < paths.length; index += 1000) {
        const chunk = paths.slice(index, index + 1000);
        const { error } = await service.storage.from(bucket).remove(chunk);
        if (error) failed += chunk.length;
      }
      return { failed };
    }
  };
}
