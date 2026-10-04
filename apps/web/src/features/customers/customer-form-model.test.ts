import { customerCreateSchema, customerListQuerySchema, normalizeIdentifier } from "@emailbot/validation";
import { describe, expect, it } from "vitest";
import { ApiError, buildQuery } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/query-keys";
import { identifierPreview, isValidCustomerPayload, toCustomerPayload, toCustomerQuery } from "./customer-form-model";

describe("customer form", () => {
  it("maps the form to the API body: trimmed, empty optional fields become null, no organizationId", () => {
    const payload = toCustomerPayload({ displayName: "  Juan Pérez ", externalRef: " ", notes: "" });
    expect(payload).toEqual({ displayName: "Juan Pérez", externalRef: null, notes: null });
    expect(customerCreateSchema.safeParse(payload).success).toBe(true);
    expect(isValidCustomerPayload({ displayName: "Juan", externalRef: "CLI-1", notes: "VIP" })).toBe(true);
    expect(isValidCustomerPayload({ displayName: "   ", externalRef: "", notes: "" })).toBe(false);
  });
});

describe("identifier management", () => {
  it("previews exactly what the API stores (shared normalizer)", () => {
    expect(identifierPreview("EMAIL", " John.Smith+Netflix@Gmail.com ")).toEqual({ ok: true, normalized: "john.smith+netflix@gmail.com" });
    expect(identifierPreview("PHONE", "+51 987-654-321")).toEqual({ ok: true, normalized: "+51987654321" });
    for (const [type, value] of [
      ["EMAIL", "Juan@Gmail.com"],
      ["USERNAME", " Juan.P "],
      ["PHONE", "(01) 234 5678"]
    ] as const) {
      const preview = identifierPreview(type, value);
      const shared = normalizeIdentifier(type, value);
      expect(preview.ok && shared.ok && preview.normalized === shared.normalized).toBe(true);
    }
  });

  it("explains invalid values in Spanish and stays silent while empty", () => {
    expect(identifierPreview("EMAIL", "")).toEqual({ ok: false, message: "" });
    expect(identifierPreview("EMAIL", "juan")).toEqual({ ok: false, message: "El valor debe ser un correo electrónico" });
    expect(identifierPreview("PHONE", "123")).toEqual({ ok: false, message: "El valor debe tener entre 6 y 15 dígitos" });
    expect(identifierPreview("PHONE", "98-abc-12345")).toMatchObject({ ok: false });
  });
});

describe("customer list", () => {
  it("builds a query the API schema accepts (search and status are optional)", () => {
    const query = toCustomerQuery({ search: "  juan ", status: "SUSPENDED", page: 2 });
    expect(query).toEqual({ page: 2, pageSize: 25, search: "juan", status: "SUSPENDED" });
    const params = Object.fromEntries(new URLSearchParams(buildQuery(query).slice(1)));
    expect(customerListQuerySchema.safeParse(params).success).toBe(true);
    expect(toCustomerQuery({ search: " ", status: "", page: 1 })).toEqual({ page: 1, pageSize: 25, search: undefined, status: undefined });
  });
});

describe("organization switch", () => {
  it("every customer and assignment cache key is scoped to the organization (dropped on switch)", () => {
    const org = "11111111-1111-4111-8111-111111111111";
    for (const key of [
      queryKeys.customers(org),
      queryKeys.customerList(org, { page: 1 }),
      queryKeys.customer(org, "c"),
      queryKeys.customerIdentifiers(org, "c"),
      queryKeys.customerBots(org, "c"),
      queryKeys.botCustomers(org, "b")
    ]) {
      expect(key.slice(0, 2)).toEqual(["org", org]);
    }
    // Invalidating the customers root also refreshes the detail, identifiers and bots of a customer.
    expect(queryKeys.customerIdentifiers(org, "c").slice(0, 3)).toEqual(queryKeys.customers(org));
  });
});

describe("error states", () => {
  it.each([
    ["INVALID_CUSTOMER", "El cliente no pertenece a esta organización."],
    ["INVALID_IDENTIFIER", "El identificador no tiene un formato válido."],
    ["BOT_IN_USE", "Quita los clientes asociados y los identificadores de este bot antes de eliminarlo."],
    ["ORGANIZATION_INACTIVE", "Esta organización no está activa. Sus datos se conservan, pero no se puede operar."]
  ])("%s has a friendly message", (code, message) => {
    expect(getErrorMessage(new ApiError(409, code, "raw"))).toBe(message);
  });
});
