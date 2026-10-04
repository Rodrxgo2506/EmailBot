import type { CustomerIdentifierType, CustomerStatus } from "@emailbot/types";
import { customerCreateSchema, normalizeIdentifier } from "@emailbot/validation";
import { z } from "zod";

/*
 * Pure helpers of the customers screens (tested without a DOM). The API
 * validates again; normalization comes from the single shared normalizer.
 */

export const CUSTOMER_PAGE_SIZE = 25;

export const customerFormSchema = z.object({
  displayName: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  externalRef: z.string().trim().max(100),
  notes: z.string().max(2000)
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

/** Form values -> POST/PATCH body ("" becomes null; the API never receives organizationId). */
export function toCustomerPayload(values: CustomerFormValues) {
  return {
    displayName: values.displayName.trim(),
    externalRef: values.externalRef.trim() || null,
    notes: values.notes.trim() || null
  };
}

/** The create body passes the API schema (strict). */
export function isValidCustomerPayload(values: CustomerFormValues): boolean {
  return customerCreateSchema.safeParse(toCustomerPayload(values)).success;
}

/** What will be stored and matched for an identifier (same function as the API). */
export function identifierPreview(type: CustomerIdentifierType, value: string): { ok: true; normalized: string } | { ok: false; message: string } {
  if (value.trim().length === 0) return { ok: false, message: "" };
  const result = normalizeIdentifier(type, value);
  return result.ok ? { ok: true, normalized: result.normalized } : { ok: false, message: `El valor ${translateProblem(result.problem)}` };
}

function translateProblem(problem: string): string {
  if (problem.includes("email")) return "debe ser un correo electrónico";
  if (problem.includes("digits")) return "debe tener entre 6 y 15 dígitos";
  if (problem.includes("only contain")) return "solo admite dígitos, espacios, ( ) . - / y un + inicial";
  if (problem.includes("at most")) return "es demasiado largo";
  return "no es válido";
}

export interface CustomerListParams {
  search: string;
  status: CustomerStatus | "";
  page: number;
}

/** Query string of GET /api/customers (scoped to the active organization by the API). */
export function toCustomerQuery(params: CustomerListParams): Record<string, string | number | undefined> {
  return {
    page: params.page,
    pageSize: CUSTOMER_PAGE_SIZE,
    search: params.search.trim() || undefined,
    status: params.status || undefined
  };
}
