import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { AttachmentRepository, AuditRepository, EmailRepository, StoredObjectRef } from "../types.js";
import {
  ATTACHMENT_COLUMNS,
  AUDIT_COLUMNS,
  EMAIL_DETAIL_COLUMNS,
  EMAIL_SUMMARY_COLUMNS,
  toAttachment,
  toAuditEntry,
  toEmailDetail,
  toEmailSummary,
  type Row
} from "./mappers.js";

export function emailRepository(db: SupabaseClient): EmailRepository {
  return {
    async list(organizationId, query) {
      const from = (query.page - 1) * query.pageSize;
      const to = from + query.pageSize - 1;

      // Attachment filters use an embedded resource: !inner = has attachments,
      // left embed + IS NULL = has none.
      const select =
        query.hasAttachments === true
          ? `${EMAIL_SUMMARY_COLUMNS},email_attachments!inner(id)`
          : query.hasAttachments === false
            ? `${EMAIL_SUMMARY_COLUMNS},email_attachments(id)`
            : EMAIL_SUMMARY_COLUMNS;

      let request = db
        .from("emails")
        .select(select, { count: "exact" })
        .eq("organization_id", organizationId);

      if (query.hasAttachments === false) request = request.is("email_attachments", null);
      if (query.accountId) request = request.eq("email_account_id", query.accountId);
      if (query.categoryId === "none") request = request.is("category_id", null);
      else if (query.categoryId) request = request.eq("category_id", query.categoryId);
      if (query.status) request = request.eq("processing_status", query.status);
      if (query.isRead !== undefined) request = request.eq("is_read", query.isRead);
      if (query.isImportant !== undefined) request = request.eq("is_important", query.isImportant);
      if (query.isArchived !== undefined) request = request.eq("is_archived", query.isArchived);
      if (query.from) request = request.gte("received_at", query.from);
      if (query.to) request = request.lte("received_at", query.to);
      if (query.search) {
        request = request.textSearch("search_vector", query.search, { type: "websearch", config: "simple" });
      }

      const result = await request
        .order("received_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);

      const rows = unwrap(result) as Row[];

      return {
        items: rows.map(toEmailSummary),
        page: query.page,
        pageSize: query.pageSize,
        total: result.count ?? rows.length
      };
    },

    async get(organizationId, id) {
      const row = unwrap(
        await db.from("emails").select(EMAIL_DETAIL_COLUMNS).eq("organization_id", organizationId).eq("id", id).maybeSingle()
      ) as Row | null;
      return row ? toEmailDetail(row) : null;
    },

    async update(organizationId, id, patch) {
      const row = unwrap(
        await db
          .from("emails")
          .update(patch)
          .eq("organization_id", organizationId)
          .eq("id", id)
          .select(EMAIL_SUMMARY_COLUMNS)
          .maybeSingle()
      ) as Row | null;
      return row ? toEmailSummary(row) : null;
    },

    async remove(organizationId, id) {
      const rows = unwrap(
        await db.from("emails").delete().eq("organization_id", organizationId).eq("id", id).select("id")
      ) as Row[];
      return rows.length > 0;
    }
  };
}

export function attachmentRepository(db: SupabaseClient): AttachmentRepository {
  return {
    async get(organizationId, id) {
      const row = unwrap(
        await db
          .from("email_attachments")
          .select(`${ATTACHMENT_COLUMNS},organization_id,storage_bucket,storage_path`)
          .eq("organization_id", organizationId)
          .eq("id", id)
          .maybeSingle()
      ) as Row | null;

      if (!row) return null;
      return {
        ...toAttachment(row),
        organizationId: row.organization_id,
        storageBucket: row.storage_bucket,
        storagePath: row.storage_path
      };
    },

    async listStoredObjects(organizationId, scope) {
      const objects: StoredObjectRef[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        let request = db
          .from("email_attachments")
          .select("id,email_id,storage_bucket,storage_path,emails!inner(email_account_id)")
          .eq("organization_id", organizationId)
          .eq("storage_uploaded", true);
        request = "emailId" in scope ? request.eq("email_id", scope.emailId) : request.eq("emails.email_account_id", scope.accountId);
        const rows = unwrap(await request.order("id", { ascending: true }).range(from, from + pageSize - 1)) as Row[];
        for (const row of rows) {
          objects.push({ id: row.id, emailId: row.email_id, storageBucket: row.storage_bucket, storagePath: row.storage_path });
        }
        if (rows.length < pageSize) return objects;
      }
    }
  };
}

export function auditRepository(db: SupabaseClient): AuditRepository {
  return {
    async list(organizationId, query) {
      const from = (query.page - 1) * query.pageSize;
      let request = db
        .from("audit_logs")
        .select(AUDIT_COLUMNS, { count: "exact" })
        .eq("organization_id", organizationId);

      if (query.action) request = request.eq("action", query.action);
      if (query.entityType) request = request.eq("entity_type", query.entityType);

      const result = await request.order("created_at", { ascending: false }).range(from, from + query.pageSize - 1);
      const rows = unwrap(result) as Row[];

      return {
        items: rows.map(toAuditEntry),
        page: query.page,
        pageSize: query.pageSize,
        total: result.count ?? rows.length
      };
    }
  };
}
