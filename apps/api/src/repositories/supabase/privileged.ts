import { redactSensitive } from "@emailbot/shared";
import type { EmailAccountStatus, OrganizationRole } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, unwrap } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";
import { portalSessionOperations } from "./customer-access-repositories.js";
import { portalDataOperations } from "./delivery-repositories.js";
import { legalAcceptanceOperations } from "./legal-repositories.js";
import { microsoftSubscriptionOperations } from "./microsoft-subscription-repositories.js";
import { PLAN_CATALOG_COLUMNS, planRepository, toPlanCatalog } from "./plan-repositories.js";
import { syncHealthOperations } from "./sync-health-repositories.js";
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
  const plans = planRepository(service);
  return {
    ...portalSessionOperations(service),
    ...portalDataOperations(service),
    ...legalAcceptanceOperations(service),
    ...syncHealthOperations(service),
    ...microsoftSubscriptionOperations(service),
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

    getOrganizationEntitlements: (organizationId) => plans.entitlements(organizationId),

    async listPlanCatalog() {
      // Read-only, public data: the service role has SELECT on the three catalog tables (no anon grant).
      const rows = unwrap(
        await service.from("plan_catalog").select(PLAN_CATALOG_COLUMNS).eq("active", true).order("sort_order", { ascending: true })
      ) as Row[];
      return toPlanCatalog(rows);
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

    async connectOAuthEmailAccount(input) {
      // One transaction under a per-organization lock: limit check + insert/update (P0), and the
      // Gmail cursor of an ERROR mailbox is kept (P1). See 20261007160000_email_account_oauth_connect.sql.
      const rows = unwrap(
        await service.rpc("connect_oauth_email_account", {
          p_organization_id: input.organizationId,
          p_provider: input.provider,
          p_email_address: input.emailAddress,
          p_display_name: input.displayName,
          p_provider_account_id: input.providerAccountId,
          p_access_token_encrypted: input.accessTokenEncrypted,
          p_refresh_token_encrypted: input.refreshTokenEncrypted,
          p_token_expires_at: input.tokenExpiresAt,
          p_sync_cursor: input.syncCursor
        })
      ) as Row[] | null;
      const result = rows?.[0];
      if (!result) throw new AppError(500, "EMAIL_ACCOUNT_CONNECT_FAILED", "The mailbox connection returned no result");

      const outcome = result.outcome as string;
      if (outcome === "PLAN_LIMIT_REACHED") {
        return { outcome, used: Number(result.used ?? 0), limit: Number(result.limit_value ?? 0) };
      }
      if (outcome === "MISSING_REFRESH_TOKEN") return { outcome };
      if (outcome !== "CREATED" && outcome !== "RECONNECTED") {
        throw new AppError(500, "EMAIL_ACCOUNT_CONNECT_FAILED", "The mailbox connection returned an unknown outcome");
      }

      const row = unwrap(
        await service
          .from("email_accounts")
          .select(EMAIL_ACCOUNT_COLUMNS)
          .eq("id", result.email_account_id)
          .eq("organization_id", input.organizationId)
          .single()
      ) as Row;
      return {
        outcome,
        account: toEmailAccount(row),
        created: outcome === "CREATED",
        previousStatus: (result.previous_status as EmailAccountStatus | null) ?? null
      };
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
