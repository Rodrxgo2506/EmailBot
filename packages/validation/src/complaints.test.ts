import { describe, expect, it } from "vitest";
import { complaintAmountToCents, complaintBookSubmissionSchema, complaintResponseSchema } from "./complaints.js";

const VALID = {
  kind: "RECLAMO",
  firstNames: "  Ana María ",
  lastNames: "Quispe Rojas",
  documentType: "DNI",
  documentNumber: "45678912",
  email: "Ana.Quispe@Example.com",
  phone: "+51 987 654 321",
  address: "Av. Siempre Viva 123, Lima",
  isMinor: false,
  guardianName: "",
  goodType: "SERVICIO",
  goodDescription: "Plan Pro mensual",
  claimedAmount: "39.90",
  detail: "Se realizó un cobro que no reconozco.",
  consumerRequest: "Solicito la revisión del cobro.",
  confirmTruth: true,
  website: ""
};

const errors = (input: Record<string, unknown>) => {
  const result = complaintBookSubmissionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("complaints book submission", () => {
  it("accepts a valid sheet and normalizes it", () => {
    const value = complaintBookSubmissionSchema.parse(VALID);
    expect(value).toMatchObject({ firstNames: "Ana María", email: "ana.quispe@example.com", claimedAmount: "39.90", kind: "RECLAMO" });
  });

  it("QUEJA and an empty amount are accepted", () => {
    expect(errors({ ...VALID, kind: "QUEJA", claimedAmount: "" })).toEqual([]);
  });

  it.each([
    ["kind", { kind: "SUGERENCIA" }],
    ["documentNumber", { documentNumber: "1234" }],
    ["documentNumber", { documentType: "RUC", documentNumber: "45678912" }],
    ["email", { email: "no-es-correo" }],
    ["phone", { phone: "abc" }],
    ["address", { address: "x" }],
    ["detail", { detail: "corto" }],
    ["detail", { detail: "x".repeat(5001) }],
    ["consumerRequest", { consumerRequest: "" }],
    ["claimedAmount", { claimedAmount: "-5" }],
    ["claimedAmount", { claimedAmount: "39.999" }],
    ["confirmTruth", { confirmTruth: false }],
    ["website", { website: "http://spam.example" }],
    ["guardianName", { isMinor: true, guardianName: "" }]
  ])("rejects an invalid %s", (path, override) => {
    expect(errors({ ...VALID, ...override })).toContain(path);
  });

  it("a minor with a parent or guardian is accepted; RUC 20 and passports are recognized", () => {
    expect(errors({ ...VALID, isMinor: true, guardianName: "Rosa Rojas" })).toEqual([]);
    expect(errors({ ...VALID, documentType: "RUC", documentNumber: "20123456789" })).toEqual([]);
    expect(errors({ ...VALID, documentType: "PASAPORTE", documentNumber: "AB12345" })).toEqual([]);
  });

  it("amount in soles to céntimos", () => {
    expect(complaintAmountToCents("")).toBeNull();
    expect(complaintAmountToCents("39.90")).toBe(3990);
    expect(complaintAmountToCents("39.9")).toBe(3990);
    expect(complaintAmountToCents("120")).toBe(12000);
    expect(complaintAmountToCents("0.05")).toBe(5);
  });
});

describe("complaint submission id", () => {
  it("is optional and must be a UUID when present", () => {
    expect(errors({ ...VALID, submissionId: "6f2b8c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e" })).toEqual([]);
    expect(errors({ ...VALID, submissionId: "not-a-uuid" })).toContain("submissionId");
  });
});

describe("complaintResponseSchema", () => {
  it("trims the answer and enforces 10..5000 characters", () => {
    expect(complaintResponseSchema.parse({ response: "  Respuesta suficiente  " }).response).toBe("Respuesta suficiente");
    expect(complaintResponseSchema.safeParse({ response: "corta" }).success).toBe(false);
    expect(complaintResponseSchema.safeParse({ response: "x".repeat(5001) }).success).toBe(false);
    expect(complaintResponseSchema.safeParse({ response: "x".repeat(5000) }).success).toBe(true);
    expect(complaintResponseSchema.safeParse({}).success).toBe(false);
  });
});
