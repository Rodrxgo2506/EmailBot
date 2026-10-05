import type { CustomerAccessCredential } from "@emailbot/types";

/*
 * Portal access card logic (EmailBot V2 phase 4), kept free of React so it
 * can be unit tested. The full Access ID only exists in the response of the
 * generation request and in component state until the dialog is closed.
 */

export type AccessState = "NONE" | "ACTIVE" | "EXPIRED";

export function accessState(credential: CustomerAccessCredential | null, now = Date.now()): AccessState {
  if (!credential || credential.status !== "ACTIVE") return "NONE";
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= now) return "EXPIRED";
  return "ACTIVE";
}

export const ACCESS_STATE_LABELS: Record<AccessState, string> = {
  NONE: "Sin Access ID",
  ACTIVE: "Activo",
  EXPIRED: "Caducado"
};

/** Text of the generate button: generating again replaces (and invalidates) the current Access ID. */
export function generateLabel(credential: CustomerAccessCredential | null): string {
  return credential ? "Regenerar Access ID" : "Generar Access ID";
}

/** Optional expiration in days -> ISO date (null = never expires). */
export function expirationFromDays(days: string, now = Date.now()): string | null {
  const value = Number(days);
  if (!days.trim() || !Number.isInteger(value) || value <= 0) return null;
  return new Date(now + value * 86_400_000).toISOString();
}
