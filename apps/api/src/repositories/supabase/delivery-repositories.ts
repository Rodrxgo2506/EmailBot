import type { EmailDelivery, PortalAttachmentSummary, PortalEmailDetail, PortalFieldValue, PortalInboxItem } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { EmailDeliveryRepository, PortalAttachmentLocation, PortalInboxRow, PrivilegedOperations } from "../types.js";
import type { Row } from "./mappers.js";

/*
 * Deliveries (EmailBot V2 phase 5).
 *
 * Members (caller's JWT, RLS): read the deliveries of an email of the active
 * organization; add / remove MANUAL deliveries through the atomic
 * public.add_manual_delivery / public.remove_manual_delivery functions.
 * Portal (service role): ONLY portal.list_inbox / get_email / get_attachment,
 * whose sole authority is the session token hash.
 */

const DELIVERY_COLUMNS =
  "id,email_id,customer_id,bot_id,resolution,created_by,created_at,removed_at,removed_by,customer_read_at,customer:customers!inner(id,display_name,status)";

function toDelivery(row: Row): EmailDelivery {
  const customer = Array.isArray(row.customer) ? row.customer[0] : row.customer;
  return {
    id: row.id,
    emailId: row.email_id,
    customerId: row.customer_id,
    botId: row.bot_id,
    resolution: row.resolution,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    removedAt: row.removed_at ?? null,
    removedBy: row.removed_by ?? null,
    customerReadAt: row.customer_read_at ?? null,
    ...(customer ? { customer: { id: customer.id, displayName: customer.display_name, status: customer.status } } : {})
  };
}

export function emailDeliveryRepository(db: SupabaseClient): EmailDeliveryRepository {
  return {
    async list(organizationId, emailId) {
      const rows = unwrap(
        await db
          .from("email_deliveries")
          .select(DELIVERY_COLUMNS)
          .eq("organization_id", organizationId)
          .eq("email_id", emailId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
      ) as Row[];
      return rows.map(toDelivery);
    },

    async get(organizationId, emailId, deliveryId) {
      const row = unwrap(
        await db
          .from("email_deliveries")
          .select(DELIVERY_COLUMNS)
          .eq("organization_id", organizationId)
          .eq("email_id", emailId)
          .eq("id", deliveryId)
          .maybeSingle()
      ) as Row | null;
      return row ? toDelivery(row) : null;
    },

    async addManual(emailId, customerId) {
      const rows = unwrap(await db.rpc("add_manual_delivery", { p_email_id: emailId, p_customer_id: customerId })) as Row[];
      const row = rows[0];
      if (!row) throw new Error("add_manual_delivery returned no row");
      return { deliveryId: row.delivery_id, outcome: row.outcome, botId: row.bot_id, resolution: row.resolution };
    },

    async removeManual(deliveryId) {
      const rows = unwrap(await db.rpc("remove_manual_delivery", { p_delivery_id: deliveryId })) as Row[];
      const row = rows[0];
      if (!row) throw new Error("remove_manual_delivery returned no row");
      return { removed: row.removed === true, emailId: row.email_id, customerId: row.customer_id, botId: row.bot_id };
    }
  };
}

const toFields = (value: unknown): PortalFieldValue[] =>
  (Array.isArray(value) ? value : []).map((field: Row) => ({
    key: String(field.key),
    label: String(field.label ?? field.key),
    value: field.value === null || field.value === undefined ? null : String(field.value)
  }));

type PortalDataOperations = Pick<
  PrivilegedOperations,
  "listPortalInbox" | "getPortalEmail" | "getPortalAttachment" | "listPortalFilters" | "portalSyncScope" | "hasActiveMailbox"
>;

const toNamed = (value: unknown) =>
  (Array.isArray(value) ? value : []).map((entry: Row) => ({ name: String(entry.name), slug: String(entry.slug) }));

export function portalDataOperations(service: SupabaseClient): PortalDataOperations {
  const portal = () => service.schema("portal");
  return {
    async listPortalInbox(tokenHash, filters): Promise<PortalInboxRow[]> {
      const rows = unwrap(
        await portal().rpc("list_inbox", {
          p_token_hash: tokenHash,
          p_limit: filters.limit,
          p_before_received_at: filters.before?.receivedAt ?? null,
          p_before_id: filters.before?.deliveryId ?? null,
          p_bot_slug: filters.bot ?? null,
          p_category_slug: filters.category ?? null,
          p_unread: filters.unread ?? null,
          p_important: filters.important ?? null,
          p_received_from: filters.from ?? null,
          p_received_to: filters.to ?? null,
          p_search: filters.search ?? null
        })
      ) as Row[];
      return rows.map((row) => {
        const item: PortalInboxItem = {
          deliveryId: row.delivery_id,
          deliveredAt: row.delivered_at,
          receivedAt: row.received_at,
          subject: row.subject ?? null,
          sender: { email: row.sender_email, name: row.sender_name ?? null },
          bot: { name: row.bot_name, slug: row.bot_slug },
          category: row.category_slug ? { name: row.category_name, slug: row.category_slug } : null,
          important: row.is_important === true,
          read: row.is_read === true,
          hasAttachments: row.has_attachments === true,
          fields: toFields(row.fields)
        };
        return item;
      });
    },

    async getPortalEmail(tokenHash, deliveryId): Promise<PortalEmailDetail | null> {
      const detail = unwrap(await portal().rpc("get_email", { p_token_hash: tokenHash, p_delivery_id: deliveryId })) as Row | null;
      if (!detail) return null;
      return {
        deliveryId: detail.deliveryId,
        deliveredAt: detail.deliveredAt,
        receivedAt: detail.receivedAt,
        subject: detail.subject ?? null,
        sender: { email: detail.sender?.email, name: detail.sender?.name ?? null },
        bot: { name: detail.bot?.name, slug: detail.bot?.slug },
        category: detail.category ? { name: detail.category.name, slug: detail.category.slug } : null,
        important: detail.important === true,
        read: detail.read === true,
        fields: toFields(detail.fields),
        body: detail.body ? { text: detail.body.text ?? null, html: detail.body.html ?? null } : null,
        attachments: Array.isArray(detail.attachments)
          ? detail.attachments.map(
              (attachment: Row): PortalAttachmentSummary => ({
                id: attachment.id,
                filename: attachment.filename,
                contentType: attachment.contentType ?? null,
                size: attachment.size === null || attachment.size === undefined ? null : Number(attachment.size),
                available: attachment.available === true
              })
            )
          : null
      };
    },

    async portalSyncScope(tokenHash) {
      const rows = unwrap(await portal().rpc("sync_scope", { p_token_hash: tokenHash })) as Row[];
      return rows.map((row) => ({ emailAccountId: row.email_account_id, organizationId: row.organization_id, lastSyncedAt: row.last_synced_at ?? null }));
    },

    async hasActiveMailbox(provider, emailAddress) {
      const rows = unwrap(
        await service
          .from("email_accounts")
          .select("id")
          .eq("provider", provider)
          .eq("status", "ACTIVE")
          .eq("email_address", emailAddress.toLowerCase())
          .limit(1)
      ) as Row[];
      return rows.length > 0;
    },

    async listPortalFilters(tokenHash) {
      const filters = unwrap(await portal().rpc("list_filters", { p_token_hash: tokenHash })) as Row | null;
      return filters ? { bots: toNamed(filters.bots), categories: toNamed(filters.categories) } : null;
    },

    async getPortalAttachment(tokenHash, deliveryId, attachmentId): Promise<PortalAttachmentLocation | null> {
      const rows = unwrap(
        await portal().rpc("get_attachment", { p_token_hash: tokenHash, p_delivery_id: deliveryId, p_attachment_id: attachmentId })
      ) as Row[];
      const row = rows[0];
      return row
        ? {
            id: row.attachment_id,
            emailId: row.email_id,
            organizationId: row.organization_id,
            filename: row.filename,
            contentType: row.content_type ?? null,
            storageBucket: row.storage_bucket ?? null,
            storagePath: row.storage_path ?? null
          }
        : null;
    }
  };
}
