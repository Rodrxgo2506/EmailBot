import { ADMIN_ORGANIZATION_SORTS, ORGANIZATION_PLANS, ORGANIZATION_STATUSES } from "@emailbot/types";
import { z } from "zod";
import { idSchema, paginationQuerySchema, slugSchema } from "./common.js";

/*
 * Platform administration (EmailBot V2 phase 6). Bodies are strict: only the
 * listed fields are accepted (no mass assignment of other organization
 * columns). Sorting is an enum, never a column name.
 */

export const adminOrganizationListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  status: z.enum(ORGANIZATION_STATUSES).optional(),
  plan: z.enum(ORGANIZATION_PLANS).optional(),
  sort: z.enum(ADMIN_ORGANIZATION_SORTS).default("created_desc")
});

export type AdminOrganizationListQuery = z.infer<typeof adminOrganizationListQuerySchema>;

export const adminOrganizationCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    /** Optional; derived from the name when omitted. */
    slug: slugSchema.max(60).optional(),
    plan: z.enum(ORGANIZATION_PLANS).default("FREE"),
    /** Must be an existing user with a confirmed e-mail (no account is created). */
    ownerEmail: z.email().max(320).transform((value) => value.trim().toLowerCase())
  })
  .strict();

export type AdminOrganizationCreateInput = z.infer<typeof adminOrganizationCreateSchema>;

export const adminOrganizationUpdateSchema = z
  .object({
    plan: z.enum(ORGANIZATION_PLANS),
    status: z.enum(ORGANIZATION_STATUSES)
  })
  .partial()
  .strict()
  .refine((value) => value.plan !== undefined || value.status !== undefined, "At least one field must be provided");

export type AdminOrganizationUpdateInput = z.infer<typeof adminOrganizationUpdateSchema>;

/** Activity and platform audit pages, optionally for one organization. */
export const adminLogQuerySchema = paginationQuerySchema.extend({
  organizationId: idSchema.optional()
});

export type AdminLogQuery = z.infer<typeof adminLogQuerySchema>;
