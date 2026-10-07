import type { CustomerIdentifierType, CustomerResolution, CustomerResolutionSource, MultipleMatchPolicy } from "@emailbot/types";
import { customerResolutionSchema, type CustomerResolutionInput } from "@emailbot/validation";
import type { EmailRule } from "@/features/rules/api";

/*
 * Pure helpers of the bot's "Entrega al portal" card (tested without a DOM).
 * bots.customer_resolution decides which customers receive the bot's emails:
 * with source NONE (the default of every new bot) the worker stores the email
 * for the panel but never delivers it to any portal. The API validates again.
 */

export interface ResolutionFormValues {
  source: CustomerResolutionSource;
  /** EXTRACTED_FIELD only. */
  field: string;
  /** EXTRACTED_FIELD only (RECIPIENT / SENDER always match EMAIL identifiers). */
  identifierType: CustomerIdentifierType;
  onMultipleMatches: MultipleMatchPolicy;
}

export function toResolutionForm(resolution: CustomerResolution | null | undefined): ResolutionFormValues {
  return {
    source: resolution?.source ?? "NONE",
    field: resolution?.field ?? "",
    identifierType: resolution?.identifierType ?? "EMAIL",
    onMultipleMatches: resolution?.onMultipleMatches ?? "LEAVE_UNASSIGNED"
  };
}

/** Form values -> PATCH /api/bots/:id body (only the keys the chosen source accepts; the schema is strict). */
export function toResolutionPayload(values: ResolutionFormValues): CustomerResolutionInput {
  if (values.source === "EXTRACTED_FIELD") {
    return { source: values.source, field: values.field.trim(), identifierType: values.identifierType, onMultipleMatches: values.onMultipleMatches };
  }
  return { source: values.source, onMultipleMatches: values.onMultipleMatches };
}

/** Same schema as the API; null when valid, otherwise a message for the form. */
export function resolutionError(values: ResolutionFormValues): string | null {
  if (values.source === "EXTRACTED_FIELD" && values.field.trim().length === 0) return "Elige el dato extraído que identifica al cliente";
  return customerResolutionSchema.safeParse(toResolutionPayload(values)).success ? null : "La configuración no es válida";
}

export function deliveryEnabled(resolution: CustomerResolution | null | undefined): boolean {
  return (resolution?.source ?? "NONE") !== "NONE";
}

/** Names of the EXTRACT actions of the bot's rules (keys of emails.extracted_data), sorted. */
export function extractedFieldNames(rules: readonly EmailRule[], botId: string): string[] {
  const names = new Set<string>();
  for (const rule of rules) {
    if (rule.botId !== botId) continue;
    for (const action of rule.actions) if (action.type === "EXTRACT") names.add(action.name);
  }
  return [...names].sort();
}

/** What the worker compares, in the admin's words. */
export function resolutionHint(source: CustomerResolutionSource): string {
  switch (source) {
    case "NONE":
      return "Los correos de este bot se ven en el panel, pero no llegan al portal de ningún cliente.";
    case "RECIPIENT":
      return "Las direcciones Para y CC del correo se comparan con los identificadores de tipo Correo de los clientes.";
    case "SENDER":
      return "La dirección del remitente se compara con los identificadores de tipo Correo de los clientes.";
    case "EXTRACTED_FIELD":
      return "El valor que extrae una regla del bot (acción «Extraer») se compara con los identificadores de los clientes.";
  }
}
