import type { CustomerAccessCredential, CustomerSession, PortalSettings } from "@emailbot/types";
import { maskAccessId } from "@emailbot/validation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { CustomerAccessRepository, PortalLoginFailure, PortalSessionContext, PrivilegedOperations } from "../types.js";
import type { Row } from "./mappers.js";

/*
 * Customer Access IDs and portal sessions (EmailBot V2 phase 4).
 *
 * Members: as the caller (RLS) - column-granted reads without hashes plus
 * the atomic public.* SECURITY DEFINER functions.
 * Portal: service role, ONLY the portal.* functions (no table privilege).
 * secret_hash and token_hash are never selected (and no role could).
 */

const CREDENTIAL_COLUMNS = "id,customer_id,display_prefix,last4,status,expires_at,created_by,created_at,revoked_at,revoked_reason";
const SESSION_COLUMNS = "id,credential_id,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revoked_reason,ip,user_agent";

function toCredential(row: Row): CustomerAccessCredential {
  return {
    id: row.id,
    customerId: row.customer_id,
    displayPrefix: row.display_prefix,
    last4: row.last4,
    maskedAccessId: maskAccessId(row.display_prefix, row.last4),
    status: row.status,
    expiresAt: row.expires_at,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    revokedReason: row.revoked_reason ?? null
  };
}

function toSession(row: Row): CustomerSession {
  return {
    id: row.id,
    credentialId: row.credential_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at ?? null,
    revokedReason: row.revoked_reason ?? null,
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null
  };
}

export function customerAccessRepository(db: SupabaseClient): CustomerAccessRepository {
  return {
    async getActive(organizationId, customerId) {
      const row = unwrap(
        await db
          .from("customer_access_credentials")
          .select(CREDENTIAL_COLUMNS)
          .eq("organization_id", organizationId)
          .eq("customer_id", customerId)
          .eq("status", "ACTIVE")
          .maybeSingle()
      ) as Row | null;
      return row ? toCredential(row) : null;
    },

    async listSessions(organizationId, customerId, { activeOnly, limit }) {
      let query = db
        .from("customer_sessions")
        .select(SESSION_COLUMNS)
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId);
      if (activeOnly) query = query.is("revoked_at", null).gt("idle_expires_at", new Date().toISOString());
      const rows = unwrap(await query.order("created_at", { ascending: false }).limit(limit)) as Row[];
      return rows.map(toSession);
    },

    async issue(customerId, input) {
      const rows = unwrap(
        await db.rpc("issue_customer_access", {
          p_customer_id: customerId,
          p_secret_hash: input.secretHash,
          p_last4: input.last4,
          p_display_prefix: input.displayPrefix,
          p_expires_at: input.expiresAt
        })
      ) as Row[];
      const row = rows[0];
      if (!row) throw new Error("issue_customer_access returned no row");
      return {
        credential: toCredential({
          id: row.credential_id,
          customer_id: customerId,
          display_prefix: row.display_prefix,
          last4: row.last4,
          status: row.status,
          expires_at: row.expires_at,
          created_by: null,
          created_at: row.created_at
        }),
        previousCredentialId: row.previous_credential_id ?? null,
        revokedSessions: Number(row.revoked_sessions ?? 0)
      };
    },

    async revoke(customerId) {
      const rows = unwrap(await db.rpc("revoke_customer_access", { p_customer_id: customerId })) as Row[];
      return { credentialId: rows[0]?.credential_id ?? null, revokedSessions: Number(rows[0]?.revoked_sessions ?? 0) };
    },

    async revokeSessions(customerId, sessionId) {
      const count = unwrap(await db.rpc("revoke_customer_sessions", { p_customer_id: customerId, p_session_id: sessionId })) as number;
      return Number(count ?? 0);
    }
  };
}

const FAILURES: readonly PortalLoginFailure[] = ["INVALID", "REVOKED", "EXPIRED", "CUSTOMER_INACTIVE", "ORGANIZATION_INACTIVE"];

type PortalOperations = Pick<PrivilegedOperations, "createPortalSession" | "validatePortalSession" | "endPortalSession">;

export function portalSessionOperations(service: SupabaseClient): PortalOperations {
  // Resolved per call: the portal schema is only used by these three operations.
  const portal = () => service.schema("portal");
  return {
    async createPortalSession({ secretHash, tokenHash, ip, userAgent }) {
      const rows = unwrap(
        await portal().rpc("create_session", { p_secret_hash: secretHash, p_token_hash: tokenHash, p_ip: ip, p_user_agent: userAgent })
      ) as Row[];
      const row = rows[0];
      if (row?.outcome === "OK") {
        return {
          outcome: "OK",
          organizationId: row.organization_id,
          customerId: row.customer_id,
          sessionId: row.session_id,
          displayName: row.display_name,
          idleExpiresAt: row.idle_expires_at,
          absoluteExpiresAt: row.absolute_expires_at
        };
      }
      // Anything unexpected is a plain failure (fail closed).
      const outcome = FAILURES.includes(row?.outcome) ? (row?.outcome as PortalLoginFailure) : "INVALID";
      return { outcome, organizationId: row?.organization_id ?? null, customerId: row?.customer_id ?? null };
    },

    async validatePortalSession(tokenHash): Promise<PortalSessionContext | null> {
      const rows = unwrap(await portal().rpc("validate_session", { p_token_hash: tokenHash })) as Row[];
      const row = rows[0];
      if (!row) return null;
      const bots = (Array.isArray(row.bots) ? row.bots : []) as Array<{ name: string; slug: string; portalSettings: PortalSettings }>;
      return {
        sessionId: row.session_id,
        organizationId: row.organization_id,
        customerId: row.customer_id,
        profile: {
          customer: { displayName: row.display_name, status: row.customer_status },
          organization: { name: row.organization_name },
          bots: bots.map((bot) => ({ name: bot.name, slug: bot.slug, portalSettings: bot.portalSettings })),
          session: { idleExpiresAt: row.idle_expires_at, absoluteExpiresAt: row.absolute_expires_at }
        }
      };
    },

    async endPortalSession(tokenHash) {
      const rows = unwrap(await portal().rpc("end_session", { p_token_hash: tokenHash })) as Row[];
      const row = rows[0];
      return row ? { sessionId: row.session_id, organizationId: row.organization_id, customerId: row.customer_id } : null;
    }
  };
}
