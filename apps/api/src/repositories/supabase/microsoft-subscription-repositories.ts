import { isGraphSubscriptionId, MICROSOFT_SUBSCRIPTION_KEYS, readMicrosoftSubscription, withMicrosoftSubscription } from "@emailbot/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromDatabaseError } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";

type MicrosoftSubscriptionOperations = Pick<
  PrivilegedOperations,
  "findMicrosoftSubscription" | "getMicrosoftSubscriptionCredentials" | "clearMicrosoftSubscription"
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function unwrap<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) throw fromDatabaseError(result.error);
  return result.data;
}

/**
 * Microsoft Graph subscriptions (F9), service role. The subscription id and
 * the SHA-256 of its clientState live in email_accounts.provider_metadata;
 * expiry / renewal / last error in the watch_* columns (no migration).
 */
export function microsoftSubscriptionOperations(service: SupabaseClient): MicrosoftSubscriptionOperations {
  return {
    async findMicrosoftSubscription(subscriptionId) {
      if (!isGraphSubscriptionId(subscriptionId)) return null;
      const row = unwrap(
        await service
          .from("email_accounts")
          .select("id,organization_id,status,provider_metadata,organizations!inner(status)")
          .eq("provider", "MICROSOFT")
          .eq(`provider_metadata->>${MICROSOFT_SUBSCRIPTION_KEYS.id}`, subscriptionId)
          .limit(1)
          .maybeSingle()
      ) as Row | null;
      if (!row) return null;
      return {
        emailAccountId: row.id,
        organizationId: row.organization_id,
        accountStatus: row.status,
        // Fail closed: an organization whose status cannot be read is treated as inactive.
        organizationStatus: row.organizations?.status ?? "SUSPENDED",
        clientStateHash: readMicrosoftSubscription(row.provider_metadata)?.clientStateHash ?? null
      };
    },

    async getMicrosoftSubscriptionCredentials(organizationId, id) {
      const row = unwrap(
        await service
          .from("email_accounts")
          .select("provider_metadata,access_token_encrypted,refresh_token_encrypted,token_expires_at")
          .eq("organization_id", organizationId)
          .eq("id", id)
          .eq("provider", "MICROSOFT")
          .maybeSingle()
      ) as Row | null;
      if (!row) return null;
      return {
        subscriptionId: readMicrosoftSubscription(row.provider_metadata)?.id ?? null,
        accessTokenEncrypted: row.access_token_encrypted ?? null,
        refreshTokenEncrypted: row.refresh_token_encrypted ?? null,
        tokenExpiresAt: row.token_expires_at ?? null
      };
    },

    async clearMicrosoftSubscription(organizationId, id) {
      const row = unwrap(
        await service
          .from("email_accounts")
          .select("provider_metadata")
          .eq("organization_id", organizationId)
          .eq("id", id)
          .eq("provider", "MICROSOFT")
          .maybeSingle()
      ) as Row | null;
      if (!row) return;
      unwrap(
        await service
          .from("email_accounts")
          .update({
            provider_metadata: withMicrosoftSubscription(row.provider_metadata, null),
            watch_expires_at: null,
            watch_renewed_at: null,
            watch_error_code: null,
            watch_error_at: null
          })
          .eq("organization_id", organizationId)
          .eq("id", id)
          .eq("provider", "MICROSOFT")
      );
    }
  };
}
