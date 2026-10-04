import { ATTACHMENT_URL_TTL_SECONDS, serializeError } from "@emailbot/shared";
import type { AuditAction } from "@emailbot/types";
import { emailListQuerySchema, emailUpdateSchema, idParamsSchema } from "@emailbot/validation";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { conflict, notFound, unprocessable } from "../../lib/errors.js";
import { captureException } from "../../lib/sentry.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import type { EmailPatch, StoredObjectRef } from "../../repositories/types.js";

/** Exact layout written by the worker: <org>/<email>/<attachment>/<sanitized filename>. */
export function isExpectedStorageLocation(
  attachment: { id: string; emailId: string; storageBucket: string | null; storagePath: string | null },
  organizationId: string,
  bucket: string
): boolean {
  if (attachment.storageBucket !== bucket || !attachment.storagePath) return false;
  const segments = attachment.storagePath.split("/");
  return (
    segments.length === 4 &&
    segments[0] === organizationId &&
    segments[1] === attachment.emailId &&
    segments[2] === attachment.id &&
    Boolean(segments[3]) &&
    segments[3] !== "." &&
    segments[3] !== ".." &&
    !attachment.storagePath.includes("\\")
  );
}

/**
 * Compensating cleanup after rows were deleted (cascade does not reach
 * Storage). Only objects at the exact location the worker writes for THIS
 * organization are removed; a failure is logged and reported, the user's
 * deletion is not undone (the rows are already gone).
 */
export async function removeStoredObjects(
  deps: Pick<AppDeps, "config" | "privileged">,
  log: FastifyBaseLogger,
  organizationId: string,
  objects: StoredObjectRef[]
): Promise<void> {
  const bucket = deps.config.attachmentsBucket;
  const paths = objects
    .filter((object) => isExpectedStorageLocation(object, organizationId, bucket))
    .map((object) => object.storagePath as string);
  if (paths.length < objects.length) {
    log.warn({ skipped: objects.length - paths.length }, "attachment objects outside the expected location were not removed");
  }
  if (paths.length === 0) return;

  try {
    const { failed } = await deps.privileged.removeStorageObjects(bucket, paths);
    if (failed > 0) log.error({ failed, total: paths.length }, "some attachment objects could not be removed (orphans)");
  } catch (error) {
    log.error({ err: serializeError(error), total: paths.length }, "attachment object cleanup failed (orphans)");
    captureException(error, { organizationId });
  }
}

export function emailRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("emails:read")] };

    /** Processed emails of the active organization (filters + pagination + full-text search). */
    app.get("/emails", read, async (request) => {
      const query = parseWith(emailListQuerySchema, request.query, "query");
      return getAuth(request).repos.emails.list(getOrganization(request).id, query);
    });

    app.get("/emails/:id", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const email = await getAuth(request).repos.emails.get(getOrganization(request).id, id);
      if (!email) throw notFound("Email");
      return { email };
    });

    /** Read/unread, important, archive, manual category. OPERATOR and above (RLS). */
    app.patch(
      "/emails/:id",
      { preHandler: [app.authenticate, app.requireOrganization, requirePermission("emails:update")] },
      async (request) => {
        const repos = getAuth(request).repos;
        const organizationId = getOrganization(request).id;
        const { id } = parseWith(idParamsSchema, request.params, "params");
        const input = parseWith(emailUpdateSchema, request.body);

        if (input.categoryId) {
          const category = await repos.categories.get(organizationId, input.categoryId);
          if (!category) throw unprocessable("Category not found in this organization", "INVALID_CATEGORY");
        }

        const patch: EmailPatch = {};
        if (input.isRead !== undefined) patch.is_read = input.isRead;
        if (input.isImportant !== undefined) patch.is_important = input.isImportant;
        if (input.isArchived !== undefined) patch.is_archived = input.isArchived;
        if (input.categoryId !== undefined) patch.category_id = input.categoryId;

        const email = await repos.emails.update(organizationId, id, patch);
        if (!email) throw notFound("Email");

        // Read/unread toggles are too frequent to be worth an audit record.
        const audited: Array<[AuditAction, Record<string, unknown>]> = [];
        if (input.isImportant !== undefined) {
          audited.push([input.isImportant ? "MARK_IMPORTANT" : "MARK_NOT_IMPORTANT", {}]);
        }
        if (input.isArchived !== undefined) audited.push([input.isArchived ? "ARCHIVE" : "UNARCHIVE", {}]);
        if (input.categoryId !== undefined) audited.push(["UPDATE", { categoryId: input.categoryId }]);

        for (const [action, metadata] of audited) {
          await app.audit(request, { action, entityType: "email", entityId: id, metadata });
        }
        return { email };
      }
    );

    app.delete(
      "/emails/:id",
      { preHandler: [app.authenticate, app.requireOrganization, requirePermission("emails:delete")] },
      async (request, reply) => {
        const { id } = parseWith(idParamsSchema, request.params, "params");
        const repos = getAuth(request).repos;
        const organizationId = getOrganization(request).id;
        const objects = await repos.attachments.listStoredObjects(organizationId, { emailId: id });
        const removed = await repos.emails.remove(organizationId, id);
        if (!removed) throw notFound("Email");
        await removeStoredObjects(deps, request.log, organizationId, objects);
        await app.audit(request, { action: "DELETE", entityType: "email", entityId: id });
        return reply.status(204).send();
      }
    );

    /**
     * Short-lived signed download URL. Access is verified by reading the
     * attachment row with the caller's JWT (RLS + organization filter); only
     * then is the URL signed with the service role.
     */
    app.get("/attachments/:id/download", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const organizationId = getOrganization(request).id;
      const attachment = await getAuth(request).repos.attachments.get(organizationId, id);
      if (!attachment) throw notFound("Attachment");

      if (!attachment.storageUploaded || !attachment.storagePath) {
        throw conflict("The attachment content has not been stored", "ATTACHMENT_NOT_STORED");
      }

      // The URL is signed with the service role, so the location must be the
      // one the worker writes. Only the service role writes storage_*
      // (migration 6); this check is defense in depth: never sign an
      // arbitrary bucket/path.
      if (!isExpectedStorageLocation(attachment, organizationId, deps.config.attachmentsBucket)) {
        request.log.warn({ attachmentId: attachment.id }, "attachment storage location mismatch; refusing to sign");
        throw notFound("Attachment");
      }

      const url = await deps.privileged.createSignedDownloadUrl(
        deps.config.attachmentsBucket,
        attachment.storagePath,
        ATTACHMENT_URL_TTL_SECONDS,
        attachment.filename
      );
      return { url, expiresIn: ATTACHMENT_URL_TTL_SECONDS };
    });
  };
}
