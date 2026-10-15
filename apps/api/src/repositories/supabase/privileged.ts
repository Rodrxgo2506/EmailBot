import { redactSensitive } from "@emailbot/shared";
import type { ComplaintEmailStatus, ComplaintKind, EmailAccountStatus, OrganizationRole } from "@emailbot/types";
import type { ComplaintEmailRecordStatus } from "../types.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, unwrap } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";
import { portalSessionOperations } from "./customer-access-repositories.js";
import { portalDataOperations } from "./delivery-repositories.js";
import { legalAcceptanceOperations } from "./legal-repositories.js";
import { microsoftSubscriptionOperations } from "./microsoft-subscription-repositories.js";
import { PLAN_CATALOG_COLUMNS, planRepository, toPlanCatalog } from "./plan-repositories.js";
import { syncHealthOperations } from "./sync-health-repositories.js";
import { complaintEmailOutcomeArgs, EMAIL_ACCOUNT_COLUMNS, toComplaintCopy, toEmailAccount, type Row } from "./mappers.js";

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

    async submitComplaintBookEntry(input) {
      // public.submit_complaint_book_entry: validates again and takes the correlative number atomically.
      const rows = unwrap(
        await service.rpc("submit_complaint_book_entry", {
          p_submission_id: input.submissionId,
          p_kind: input.kind,
          p_first_names: input.firstNames,
          p_last_names: input.lastNames,
          p_document_type: input.documentType,
          p_document_number: input.documentNumber,
          p_email: input.email,
          p_phone: input.phone,
          p_address: input.address,
          p_is_minor: input.isMinor,
          p_guardian_name: input.guardianName,
          p_good_type: input.goodType,
          p_good_description: input.goodDescription,
          p_claimed_amount_cents: input.claimedAmountCents,
          p_detail: input.detail,
          p_consumer_request: input.consumerRequest,
          p_request_id: input.requestId
        })
      ) as Row[] | null;
      const row = rows?.[0];
      if (!row) throw new AppError(500, "COMPLAINT_NOT_RECORDED", "The complaint could not be recorded");
      return {
        id: row.id as string,
        code: row.code as string,
        number: Number(row.number),
        kind: row.kind as ComplaintKind,
        createdAt: row.created_at as string,
        confirmationEmailStatus: row.confirmation_email_status as ComplaintEmailStatus,
        replayed: row.replayed === true
      };
    },

    async claimComplaintConfirmationEmail(entryId) {
      const rows = unwrap(await service.rpc("claim_complaint_confirmation_email", { p_entry_id: entryId })) as Row[] | null;
      const row = rows?.[0];
      return row ? toComplaintCopy(row) : null;
    },

    async recordComplaintConfirmationEmail(entryId, outcome) {
      const status = unwrap(
        await service.rpc("record_complaint_confirmation_email", { p_entry_id: entryId, ...complaintEmailOutcomeArgs(outcome) })
      ) as ComplaintEmailRecordStatus | null;
      return status ?? null;
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

    async connectImapEmailAccount(input) {
      // One transaction under the organization lock: plan feature IMAP + EMAIL_ACCOUNTS limit + insert / reconnection.
      // See 20261014120000_imap_e1_security.sql and 20261015120000_imap_m1_lifecycle.sql. The mailbox is stored
      // PAUSED (IMAP_ACTIVATION_PENDING): it only synchronizes after activateImapEmailAccount.
      const rows = unwrap(
        await service.rpc("connect_imap_email_account", {
          p_organization_id: input.organizationId,
          p_email_address: input.emailAddress,
          p_display_name: input.displayName,
          p_username: input.username,
          p_host: input.host,
          p_port: input.port,
          p_security: input.security,
          p_password_encrypted: input.passwordEncrypted,
          p_sync_cursor: input.syncCursor
        })
      ) as Row[] | null;
      const result = rows?.[0];
      if (!result) throw new AppError(500, "EMAIL_ACCOUNT_CONNECT_FAILED", "The mailbox connection returned no result");

      const outcome = result.outcome as string;
      if (outcome === "PLAN_LIMIT_REACHED") {
        return { outcome, used: Number(result.used ?? 0), limit: Number(result.limit_value ?? 0) };
      }
      if (outcome === "FEATURE_NOT_AVAILABLE" || outcome === "DUPLICATE_ACCOUNT") return { outcome };
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

    async activateImapEmailAccount(organizationId, id) {
      // IMAP M1 (20261015120000_imap_m1_lifecycle.sql): one transaction under the organization lock; the
      // database decides plan feature IMAP + access, the stored login / settings and the state transition.
      const rows = unwrap(
        await service.rpc("activate_imap_email_account", { p_organization_id: organizationId, p_email_account_id: id })
      ) as Row[] | null;
      const result = rows?.[0];
      if (!result) throw new AppError(500, "EMAIL_ACCOUNT_ACTIVATE_FAILED", "The mailbox activation returned no result");

      const outcome = result.outcome as string;
      if (
        outcome === "NOT_FOUND" ||
        outcome === "NOT_IMAP" ||
        outcome === "DISCONNECTED" ||
        outcome === "RECONNECT_REQUIRED" ||
        outcome === "CREDENTIALS_MISSING" ||
        outcome === "SETTINGS_INVALID" ||
        outcome === "FEATURE_NOT_AVAILABLE"
      ) {
        return { outcome };
      }
      if (outcome !== "ACTIVATED" && outcome !== "ALREADY_ACTIVE") {
        throw new AppError(500, "EMAIL_ACCOUNT_ACTIVATE_FAILED", "The mailbox activation returned an unknown outcome");
      }

      const row = unwrap(
        await service.from("email_accounts").select(EMAIL_ACCOUNT_COLUMNS).eq("id", id).eq("organization_id", organizationId).single()
      ) as Row;
      return { outcome, account: toEmailAccount(row), previousStatus: result.previous_status as EmailAccountStatus };
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
