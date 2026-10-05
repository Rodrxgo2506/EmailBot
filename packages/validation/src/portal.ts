import { z } from "zod";
import { idSchema, slugSchema } from "./common.js";

/*
 * Customer portal requests (EmailBot V2 phase 5). The customer, organization
 * and permissions always come from the portal session: these schemas carry
 * NO customerId / organizationId / botId. Unknown query parameters are
 * dropped (no effect), never used for authorization.
 */

export const PORTAL_INBOX_MAX_LIMIT = 50;

const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");

export const portalInboxQuerySchema = z.object({
  /** Opaque keyset cursor returned as nextCursor. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PORTAL_INBOX_MAX_LIMIT).default(25),
  /** Filters, applied inside the customer's own deliveries. */
  bot: slugSchema.optional(),
  category: slugSchema.optional(),
  unread: booleanFlag.optional(),
  important: booleanFlag.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  search: z.string().trim().min(1).max(100).optional()
});

export type PortalInboxQuery = z.infer<typeof portalInboxQuerySchema>;

export const portalDeliveryParamsSchema = z.object({ deliveryId: idSchema }).strict();

export const portalAttachmentParamsSchema = z.object({ deliveryId: idSchema, attachmentId: idSchema }).strict();

/** POST /api/emails/:id/deliveries (organization from the operator's session). */
export const manualDeliveryCreateSchema = z.object({ customerId: idSchema }).strict();

export const emailDeliveryParamsSchema = z.object({ id: idSchema, deliveryId: idSchema }).strict();
