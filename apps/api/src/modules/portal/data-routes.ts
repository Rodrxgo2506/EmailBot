import { ATTACHMENT_URL_TTL_SECONDS } from "@emailbot/shared";
import type { PortalFilters, PortalInboxPage } from "@emailbot/types";
import { idSchema, portalAttachmentParamsSchema, portalDeliveryParamsSchema, portalInboxQuerySchema } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { isExpectedStorageLocation } from "../emails/routes.js";
import { portalTokenHash } from "./session.js";

/*
 * Customer portal data (EmailBot V2 phase 5).
 *
 *   GET /api/portal/inbox                                    the customer's visible deliveries, newest received first (keyset pages)
 *   GET /api/portal/filters                                  bots / categories to filter by
 *   GET /api/portal/email/:deliveryId                        detail, as allowed by the bot's portal settings
 *   GET /api/portal/email/:deliveryId/attachments/:attachmentId   short-lived signed URL
 *
 * Authority: ONLY the portal session (requirePortalSession, then the
 * portal.* functions receive the session token hash again and re-derive
 * session -> customer -> delivery -> email -> bot -> organization). No
 * customerId / organizationId / botId is ever read from the request; a
 * delivery or attachment that is not the customer's is a generic 404.
 */

const cursorSchema = z.object({ r: z.iso.datetime({ offset: true }), i: idSchema }).strict();

/** Opaque for clients: position (received_at, delivery id) of the last item of the page. */
export function encodeCursor(receivedAt: string, deliveryId: string): string {
  return Buffer.from(JSON.stringify({ r: receivedAt, i: deliveryId })).toString("base64url");
}

export function decodeCursor(cursor: string): { receivedAt: string; deliveryId: string } {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { receivedAt: parsed.r, deliveryId: parsed.i };
  } catch {
    throw badRequest("Invalid cursor", "INVALID_CURSOR");
  }
}

export function portalDataRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: [app.requirePortalSession], config: { rateLimit: RATE_LIMITS.portalRead } };

    app.get("/portal/inbox", read, async (request): Promise<PortalInboxPage> => {
      // Unknown parameters (customerId, organizationId, botId...) are dropped by the schema: no effect.
      const query = parseWith(portalInboxQuerySchema, request.query, "query");
      const rows = await deps.privileged.listPortalInbox(portalTokenHash(request), {
        limit: query.limit + 1,
        before: query.cursor ? decodeCursor(query.cursor) : null,
        bot: query.bot,
        category: query.category,
        unread: query.unread,
        important: query.important,
        from: query.from,
        to: query.to,
        search: query.search
      });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(last.receivedAt, last.deliveryId) : null };
    });

    app.get("/portal/filters", read, async (request): Promise<PortalFilters> => {
      const filters = await deps.privileged.listPortalFilters(portalTokenHash(request));
      return filters ?? { bots: [], categories: [] };
    });

    app.get("/portal/email/:deliveryId", read, async (request) => {
      const { deliveryId } = parseWith(portalDeliveryParamsSchema, request.params, "params");
      const email = await deps.privileged.getPortalEmail(portalTokenHash(request), deliveryId);
      if (!email) throw notFound("Email");
      return { email };
    });

    app.get(
      "/portal/email/:deliveryId/attachments/:attachmentId",
      { preHandler: [app.requirePortalSession], config: { rateLimit: RATE_LIMITS.portalDownload } },
      async (request) => {
        const { deliveryId, attachmentId } = parseWith(portalAttachmentParamsSchema, request.params, "params");
        const attachment = await deps.privileged.getPortalAttachment(portalTokenHash(request), deliveryId, attachmentId);
        if (!attachment || !attachment.storagePath) throw notFound("Attachment");

        // Never sign an arbitrary location: it must be the one the worker writes for this attachment.
        if (!isExpectedStorageLocation(attachment, attachment.organizationId, deps.config.attachmentsBucket)) {
          request.log.warn({ attachmentId: attachment.id }, "portal attachment storage location mismatch; refusing to sign");
          throw notFound("Attachment");
        }
        const url = await deps.privileged.createSignedDownloadUrl(
          deps.config.attachmentsBucket,
          attachment.storagePath,
          ATTACHMENT_URL_TTL_SECONDS,
          attachment.filename
        );
        request.log.info({ event: "portal.attachment.signed", deliveryId, attachmentId }, "portal attachment URL signed");
        return { url, expiresIn: ATTACHMENT_URL_TTL_SECONDS };
      }
    );
  };
}
