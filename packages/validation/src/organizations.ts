import { INBOX_FILTERS } from "@emailbot/types";
import { z } from "zod";
import { idSchema, isValidTimeZone, slugSchema } from "./common.js";

const organizationName = z.string().trim().min(2).max(120);

export const organizationCreateSchema = z.object({
  name: organizationName,
  slug: slugSchema.max(60).optional()
});

export const organizationUpdateSchema = z
  .object({
    name: organizationName,
    slug: slugSchema.max(60)
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export const organizationSettingsUpdateSchema = z
  .object({
    timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Unknown IANA time zone"),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, "Use a language tag like es or es-PE"),
    autoProcessingEnabled: z.boolean(),
    processAttachments: z.boolean(),
    notificationsEnabled: z.boolean(),
    emailNotificationsEnabled: z.boolean(),
    emailRetentionDays: z.number().int().min(1).max(36_500).nullable(),
    defaultInboxFilter: z.enum(INBOX_FILTERS)
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export const transferOwnershipSchema = z.object({
  newOwnerUserId: idSchema
});

/** OWNER can only be assigned by create_organization() or the transfer RPC. */
export const ASSIGNABLE_ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;

export const memberAddSchema = z.object({
  email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  role: z.enum(ASSIGNABLE_ROLES).default("VIEWER")
});

export const memberUpdateSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES)
});
