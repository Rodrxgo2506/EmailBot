import { CUSTOMER_IDENTIFIER_TYPES, CUSTOMER_STATUSES } from "@emailbot/types";
import { z } from "zod";
import { idSchema, paginationQuerySchema } from "./common.js";
import { MAX_IDENTIFIER_LENGTH, normalizeIdentifier } from "./identifiers.js";

/*
 * Customers, identifiers and bot assignments (EmailBot V2, phase 2).
 * Every schema is strict: organizationId / createdBy / normalizedValue are
 * never accepted from the client (the API derives them).
 */

const customerFields = {
  displayName: z.string().trim().min(1).max(120),
  externalRef: z.string().trim().min(1).max(100).nullable(),
  notes: z.string().trim().max(2000).nullable(),
  status: z.enum(CUSTOMER_STATUSES)
};

export const customerCreateSchema = z
  .object({
    displayName: customerFields.displayName,
    externalRef: customerFields.externalRef.optional(),
    notes: customerFields.notes.optional(),
    status: customerFields.status.default("ACTIVE")
  })
  .strict();

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

export const customerUpdateSchema = z
  .object(customerFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

/** Search is scoped to the active organization by the API. */
export const customerListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  status: z.enum(CUSTOMER_STATUSES).optional()
});

export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

const identifierValueSchema = z.string().max(MAX_IDENTIFIER_LENGTH * 2);

export const customerIdentifierCreateSchema = z
  .object({
    type: z.enum(CUSTOMER_IDENTIFIER_TYPES),
    value: identifierValueSchema,
    /** null / omitted = every bot the customer is assigned to. */
    botId: idSchema.nullable().optional(),
    active: z.boolean().default(true)
  })
  .strict()
  .superRefine((input, ctx) => {
    const result = normalizeIdentifier(input.type, input.value);
    if (!result.ok) ctx.addIssue({ code: "custom", path: ["value"], message: `Value ${result.problem}` });
  });

export type CustomerIdentifierCreateInput = z.infer<typeof customerIdentifierCreateSchema>;

/** The type is fixed: a different type is a different identifier (delete + create). */
export const customerIdentifierUpdateSchema = z
  .object({
    value: identifierValueSchema,
    botId: idSchema.nullable(),
    active: z.boolean()
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type CustomerIdentifierUpdateInput = z.infer<typeof customerIdentifierUpdateSchema>;

export const customerIdentifierParamsSchema = z.object({ id: idSchema, identifierId: idSchema });

export const botCustomerAssignSchema = z
  .object({
    customerId: idSchema,
    active: z.boolean().default(true)
  })
  .strict();

export const botCustomerUpdateSchema = z.object({ active: z.boolean() }).strict();

export const botCustomerParamsSchema = z.object({ id: idSchema, customerId: idSchema });
