import {
  COMPLAINT_DOCUMENT_TYPES,
  COMPLAINT_GOOD_TYPES,
  COMPLAINT_KINDS,
  COMPLAINT_RESPONSE_MAX_LENGTH,
  COMPLAINT_RESPONSE_MIN_LENGTH
} from "@emailbot/types";
import { z } from "zod";

/*
 * Libro de Reclamaciones: the public form, validated in the browser AND by the API
 * (and once more by public.submit_complaint_book_entry in the database).
 * Lengths match the table constraints (migration 20261007170000).
 */

const text = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label}: mínimo ${min} caracteres`)
    .max(max, `${label}: máximo ${max} caracteres`);

const DOCUMENT_PATTERNS: Record<(typeof COMPLAINT_DOCUMENT_TYPES)[number], { pattern: RegExp; message: string }> = {
  DNI: { pattern: /^[0-9]{8}$/, message: "El DNI tiene 8 dígitos" },
  CE: { pattern: /^[A-Za-z0-9]{8,12}$/, message: "El carné de extranjería tiene entre 8 y 12 caracteres" },
  PASAPORTE: { pattern: /^[A-Za-z0-9]{6,12}$/, message: "El pasaporte tiene entre 6 y 12 letras o números" },
  RUC: { pattern: /^(10|15|17|20)[0-9]{9}$/, message: "El RUC tiene 11 dígitos" }
};

/** Optional amount in soles ("39.90"), max S/ 999,999,999.99; empty = not stated. */
const amountSchema = z
  .string()
  .trim()
  .regex(/^$|^[0-9]{1,9}(\.[0-9]{1,2})?$/, "Monto en soles, por ejemplo 39.90")
  .default("");

export const complaintBookSubmissionSchema = z
  .object({
    /**
     * Generated once per form by the browser: a retried submission returns the sheet already recorded
     * (same number, no second e-mail). Optional for other clients (the API then generates one).
     */
    submissionId: z.uuid().optional(),
    kind: z.enum(COMPLAINT_KINDS, { message: "Elige reclamo o queja" }),
    firstNames: text(1, 120, "Nombres"),
    lastNames: text(1, 120, "Apellidos"),
    documentType: z.enum(COMPLAINT_DOCUMENT_TYPES, { message: "Elige el tipo de documento" }),
    documentNumber: z.string().trim().toUpperCase().max(20),
    email: z.email("Correo electrónico no válido").max(254).transform((value) => value.trim().toLowerCase()),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 ]{5,18}$/, "Teléfono no válido (solo números, opcionalmente con +)"),
    address: text(5, 300, "Domicilio"),
    isMinor: z.boolean().default(false),
    guardianName: z.string().trim().max(200).default(""),
    goodType: z.enum(COMPLAINT_GOOD_TYPES, { message: "Elige producto o servicio" }),
    goodDescription: text(3, 300, "Descripción del bien contratado"),
    claimedAmount: amountSchema,
    detail: text(10, 5000, "Detalle"),
    consumerRequest: text(5, 3000, "Pedido"),
    /** The consumer confirms the data is true (the virtual sheet has no handwritten signature). */
    confirmTruth: z.literal(true, { message: "Debes confirmar que la información es verdadera" }),
    /** Honeypot: hidden from people; bots that fill it are refused. */
    website: z.string().max(0).default("")
  })
  .superRefine((value, ctx) => {
    const rule = DOCUMENT_PATTERNS[value.documentType];
    if (rule && !rule.pattern.test(value.documentNumber)) ctx.addIssue({ code: "custom", path: ["documentNumber"], message: rule.message });
    if (value.isMinor && value.guardianName.length < 3) {
      ctx.addIssue({ code: "custom", path: ["guardianName"], message: "Indica el nombre del padre, madre o apoderado" });
    }
  });

export type ComplaintBookSubmission = z.infer<typeof complaintBookSubmissionSchema>;
export type ComplaintBookSubmissionInput = z.input<typeof complaintBookSubmissionSchema>;

/** "39.90" -> 3990 céntimos; "" -> null. */
export function complaintAmountToCents(amount: string): number | null {
  if (!amount) return null;
  const [soles, cents = ""] = amount.split(".");
  return Number(soles) * 100 + Number(cents.padEnd(2, "0"));
}

/** Answer of a platform administrator (POST /api/admin/complaints-book/:id/response). Plain text, never HTML. */
export const complaintResponseSchema = z.object({
  response: z
    .string()
    .trim()
    .min(COMPLAINT_RESPONSE_MIN_LENGTH, `La respuesta debe tener al menos ${COMPLAINT_RESPONSE_MIN_LENGTH} caracteres`)
    .max(COMPLAINT_RESPONSE_MAX_LENGTH, `La respuesta puede tener hasta ${COMPLAINT_RESPONSE_MAX_LENGTH} caracteres`),
  /**
   * Only when the previous answer's outcome is unknown and the provider's idempotency window is over: the
   * administrator accepts that it may duplicate the answer (audited). Never needed otherwise.
   */
  forceResend: z.literal(true).optional()
});

export type ComplaintResponseInput = z.infer<typeof complaintResponseSchema>;

/** POST /api/admin/complaints-book/:id/confirmation-email: forceResend as above, for the consumer's copy. */
export const complaintCopyResendSchema = z.object({ forceResend: z.literal(true).optional() });

/**
 * Manual confirmation of an e-mail with an unknown outcome: the provider's message id the administrator found in
 * the provider's dashboard (or in the API logs). Ids only (letters, digits, "-" and "_").
 */
export const complaintEmailConfirmationSchema = z.object({
  providerMessageId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,200}$/, "Indica el ID del correo en Resend (letras, números y guiones)")
});
