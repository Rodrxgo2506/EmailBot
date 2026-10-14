import { AUDIT_ACTIONS, EMAIL_PROCESSING_STATUSES, IMAP_SECURITY_MODES, imapHostProblem, imapTransportProblem, normalizeImapHost } from "@emailbot/types";
import { z } from "zod";
import { booleanQuerySchema, idSchema, paginationQuerySchema, slugSchema } from "./common.js";

/* ---------------------------------------------------------------- *
 * Email accounts
 * ---------------------------------------------------------------- */

export const OAUTH_PROVIDERS = ["gmail", "microsoft"] as const;
export type OAuthProviderSlug = (typeof OAUTH_PROVIDERS)[number];

export const oauthProviderParamsSchema = z.object({
  provider: z.enum(OAUTH_PROVIDERS)
});

export const emailAccountUpdateSchema = z
  .object({
    /** Only pause/resume. ERROR and DISCONNECTED are set by the system. */
    status: z.enum(["ACTIVE", "PAUSED"]),
    displayName: z.string().trim().max(200).nullable()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

/**
 * IMAP server: normalized (trim, lower-case, no trailing dot) and checked with
 * the same rules as the network guard (@emailbot/types imapHostProblem): a
 * public FQDN, no IP literal, no internal name. The resolved addresses are
 * verified separately (resolveImapDestination) before any connection.
 */
const imapHostSchema = z
  .string()
  .max(300)
  .transform(normalizeImapHost)
  .superRefine((host, context) => {
    const problem = imapHostProblem(host);
    if (problem) context.addIssue({ code: "custom", message: `Invalid IMAP server (${problem})` });
  });

/** Only 993 + TLS or 143 + STARTTLS (mandatory). No plaintext, no other port. */
export const imapEndpointSchema = z
  .object({
    host: imapHostSchema,
    port: z.number().int(),
    security: z.enum(IMAP_SECURITY_MODES)
  })
  .superRefine((endpoint, context) => {
    const problem = imapTransportProblem(endpoint.port, endpoint.security);
    if (problem) context.addIssue({ code: "custom", path: ["port"], message: "Use port 993 with TLS or port 143 with STARTTLS" });
  });

export const imapAccountCreateSchema = z
  .object({
    emailAddress: z.email().max(320),
    displayName: z.string().trim().max(200).optional(),
    host: imapHostSchema,
    port: z.number().int(),
    security: z.enum(IMAP_SECURITY_MODES),
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1000)
  })
  .strict()
  .superRefine((input, context) => {
    const problem = imapTransportProblem(input.port, input.security);
    if (problem) context.addIssue({ code: "custom", path: ["port"], message: "Use port 993 with TLS or port 143 with STARTTLS" });
  });

export type ImapAccountCreateInput = z.infer<typeof imapAccountCreateSchema>;

/* ---------------------------------------------------------------- *
 * Categories
 * ---------------------------------------------------------------- */

const categoryFields = {
  name: z.string().trim().min(1).max(100),
  slug: slugSchema,
  description: z.string().trim().max(500).nullable(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Use a hex color like #1A2B3C")
    .nullable(),
  icon: z.string().trim().max(100).nullable(),
  sortOrder: z.number().int().min(0).max(100_000)
};

export const categoryCreateSchema = z.object({
  name: categoryFields.name,
  slug: categoryFields.slug.optional(),
  description: categoryFields.description.optional(),
  color: categoryFields.color.optional(),
  icon: categoryFields.icon.optional(),
  sortOrder: categoryFields.sortOrder.default(0)
});

export const categoryUpdateSchema = z
  .object(categoryFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

/* ---------------------------------------------------------------- *
 * Emails
 * ---------------------------------------------------------------- */

export const emailListQuerySchema = paginationQuerySchema.extend({
  accountId: idSchema.optional(),
  /** Emails routed to this bot (EmailBot V2). */
  botId: idSchema.optional(),
  /** A category id, or "none" for uncategorized emails. */
  categoryId: z.union([idSchema, z.literal("none")]).optional(),
  status: z.enum(EMAIL_PROCESSING_STATUSES).optional(),
  isRead: booleanQuerySchema.optional(),
  isImportant: booleanQuerySchema.optional(),
  isArchived: booleanQuerySchema.optional(),
  hasAttachments: booleanQuerySchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional()
});

export type EmailListQuery = z.infer<typeof emailListQuerySchema>;

export const emailUpdateSchema = z
  .object({
    isRead: z.boolean(),
    isImportant: z.boolean(),
    isArchived: z.boolean(),
    categoryId: idSchema.nullable()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

/* ---------------------------------------------------------------- *
 * Audit
 * ---------------------------------------------------------------- */

export const auditListQuerySchema = paginationQuerySchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  entityType: z.string().trim().min(1).max(100).optional()
});
