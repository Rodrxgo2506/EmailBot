import {
  ADMIN_ORGANIZATION_SORTS,
  BILLING_PERIODS,
  COMMERCIAL_PLANS,
  MANUAL_PAYMENT_METHODS,
  ORGANIZATION_PLANS,
  ORGANIZATION_STATUSES,
  SUBSCRIPTION_ACTIONS
} from "@emailbot/types";
import { z } from "zod";
import { idSchema, paginationQuerySchema, slugSchema } from "./common.js";

/*
 * Platform administration (EmailBot V2 phase 6). Bodies are strict: only the
 * listed fields are accepted (no mass assignment of other organization
 * columns). Sorting is an enum, never a column name.
 *
 * Commercial V1.1: the plan is never set on the organization. Organizations
 * are created without a plan and get one through a subscription (manual
 * payment registered by the Super Admin; Culqi later). The list filter still
 * accepts every stored plan value, legacy FREE included.
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
    /** Must be an existing user with a confirmed e-mail (no account is created). */
    ownerEmail: z.email().max(320).transform((value) => value.trim().toLowerCase())
  })
  .strict();

export type AdminOrganizationCreateInput = z.infer<typeof adminOrganizationCreateSchema>;

/** Operational status only (organizations.status); the plan changes through the subscription. */
export const adminOrganizationUpdateSchema = z
  .object({
    status: z.enum(ORGANIZATION_STATUSES)
  })
  .strict();

export type AdminOrganizationUpdateInput = z.infer<typeof adminOrganizationUpdateSchema>;

/** Activity and platform audit pages, optionally for one organization. */
export const adminLogQuerySchema = paginationQuerySchema.extend({
  organizationId: idSchema.optional()
});

export type AdminLogQuery = z.infer<typeof adminLogQuerySchema>;

/** Amount in major units as a decimal string ("39.90"): never a float. */
export const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, "Use an amount like 39.90")
  .refine((value) => Number(value) > 0, "The amount must be greater than zero");

/**
 * Manual payment registered by the Super Admin (YAPE / CASH / TRANSFER /
 * MANUAL; CULQI is only activated by the payment provider). The price is the
 * ACTIVE catalog price of plan + period, resolved in the database.
 */
export const adminSubscriptionActivateSchema = z
  .object({
    plan: z.enum(COMMERCIAL_PLANS),
    billingPeriod: z.enum(BILLING_PERIODS),
    paymentMethod: z.enum(MANUAL_PAYMENT_METHODS),
    amount: moneyAmountSchema,
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
    /** Operation number / receipt: the same method + reference is registered once. */
    reference: z.string().trim().min(1).max(100).optional(),
    note: z.string().trim().min(1).max(500).optional()
  })
  .strict()
  .refine((value) => Date.parse(value.periodEnd) > Date.parse(value.periodStart), { message: "The period must end after it starts", path: ["periodEnd"] });

export type AdminSubscriptionActivateInput = z.infer<typeof adminSubscriptionActivateSchema>;

export const adminSubscriptionActionParamsSchema = z.object({
  id: idSchema,
  action: z.enum(SUBSCRIPTION_ACTIONS)
});

export const adminSubscriptionActionSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict();
