/*
 * Portal manual sync ("Actualizar") state and texts (EmailBot V2 phase 5.6),
 * kept free of React so they can be unit tested. The last sync time always
 * comes from the backend (GET /api/portal/sync); it is never invented here.
 */

export type SyncUiState = "idle" | "running" | "success" | "no_new" | "rate_limited" | "error";

export const SYNC_MESSAGES: Record<Exclude<SyncUiState, "idle" | "running">, string> = {
  success: "Bandeja actualizada",
  no_new: "No hay correos nuevos",
  rate_limited: "Espera unos segundos antes de volver a actualizar.",
  error: "No pudimos actualizar la bandeja."
};

/** How often the status is polled while a sync runs, and the longest wait before refreshing anyway. */
export const SYNC_POLL_INTERVAL_MS = 2_000;
export const SYNC_MAX_WAIT_MS = 60_000;

/** "hace 12 segundos", "hace 3 minutos"... from a backend timestamp; null when unknown. */
export function lastSyncText(lastSyncAt: string | null | undefined, now = Date.now()): string | null {
  if (!lastSyncAt) return null;
  const at = Date.parse(lastSyncAt);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "Última sincronización: hace unos segundos";
  if (seconds < 60) return `Última sincronización: hace ${seconds} segundos`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Última sincronización: hace ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Última sincronización: hace ${hours} ${hours === 1 ? "hora" : "horas"}`;
  const days = Math.round(hours / 24);
  return `Última sincronización: hace ${days} ${days === 1 ? "día" : "días"}`;
}

/** New mail after a sync = the newest visible email changed. */
export function syncOutcome(before: string | undefined, after: string | undefined): "success" | "no_new" {
  return after !== undefined && after !== before ? "success" : "no_new";
}
