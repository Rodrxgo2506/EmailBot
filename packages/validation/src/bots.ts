import {
  BOT_STATUSES,
  CUSTOMER_IDENTIFIER_TYPES,
  CUSTOMER_RESOLUTION_SOURCES,
  MULTIPLE_MATCH_POLICIES
} from "@emailbot/types";
import { z } from "zod";
import { slugSchema } from "./common.js";

/*
 * Bots (EmailBot V2). customer_resolution and portal_settings are JSONB in
 * public.bots: these schemas are the only accepted shapes. The worker must
 * re-validate them before use (a row may have been edited by hand).
 */

/** Same format as the name of an EXTRACT rule action (keys of emails.extracted_data). */
export const extractedFieldNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, "Use lowercase letters, digits and underscores");

export const customerResolutionSchema = z
  .object({
    source: z.enum(CUSTOMER_RESOLUTION_SOURCES),
    identifierType: z.enum(CUSTOMER_IDENTIFIER_TYPES).optional(),
    field: extractedFieldNameSchema.optional(),
    // Never resolve to an arbitrary customer: ambiguous matches stay unassigned unless explicitly allowed.
    onMultipleMatches: z.enum(MULTIPLE_MATCH_POLICIES).default("LEAVE_UNASSIGNED")
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

    if (value.source === "NONE") {
      if (value.identifierType !== undefined) issue("identifierType", "Not used when source is NONE");
      if (value.field !== undefined) issue("field", "Not used when source is NONE");
      return;
    }
    if (value.source === "RECIPIENT" || value.source === "SENDER") {
      // Addresses are matched against EMAIL identifiers.
      if (value.identifierType !== undefined && value.identifierType !== "EMAIL") {
        issue("identifierType", `Source ${value.source} only matches EMAIL identifiers`);
      }
      if (value.field !== undefined) issue("field", `Not used when source is ${value.source}`);
      return;
    }
    // EXTRACTED_FIELD
    if (value.field === undefined) issue("field", "Name of the extracted field that identifies the customer");
    if (value.identifierType === undefined) issue("identifierType", "Identifier type of the extracted value");
  })
  .transform((value) =>
    value.source === "RECIPIENT" || value.source === "SENDER" ? { ...value, identifierType: "EMAIL" as const } : value
  );

export type CustomerResolutionInput = z.input<typeof customerResolutionSchema>;

export const MAX_PORTAL_FIELDS = 10;

export const portalSettingsSchema = z
  .object({
    showBody: z.boolean().default(false),
    showAttachments: z.boolean().default(false),
    fields: z
      .array(
        z
          .object({
            key: extractedFieldNameSchema,
            label: z.string().trim().min(1).max(50)
          })
          .strict()
      )
      .max(MAX_PORTAL_FIELDS)
      .default([])
      .refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, "Each field key may appear once")
  })
  .strict();

const botFields = {
  name: z.string().trim().min(1).max(100),
  slug: slugSchema,
  description: z.string().trim().max(500).nullable(),
  status: z.enum(BOT_STATUSES),
  customerResolution: customerResolutionSchema,
  portalSettings: portalSettingsSchema
};

export const botCreateSchema = z
  .object({
    name: botFields.name,
    slug: botFields.slug.optional(),
    description: botFields.description.optional(),
    status: botFields.status.default("ACTIVE"),
    customerResolution: botFields.customerResolution.optional(),
    portalSettings: botFields.portalSettings.optional()
  })
  .strict();

export type BotCreateInput = z.infer<typeof botCreateSchema>;

export const botUpdateSchema = z
  .object(botFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type BotUpdateInput = z.infer<typeof botUpdateSchema>;
