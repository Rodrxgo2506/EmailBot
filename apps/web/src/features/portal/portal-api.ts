import type { ApiErrorBody, PortalEmailDetail, PortalFilters, PortalInboxPage, PortalProfile } from "@emailbot/types";
import { ApiError, buildQuery } from "@/lib/api-client";

/*
 * Customer portal API client (EmailBot V2). Only /api/portal/* is used.
 *
 * The session lives in the httpOnly `__Host-` cookie set by the API: requests
 * send it with `credentials: "include"`, and this code never sees it. No
 * bearer token, no organization header, nothing in localStorage /
 * sessionStorage / IndexedDB. No customer / organization / bot id is ever
 * sent: the session is the only authority.
 */

export interface PortalInboxParams {
  cursor?: string | undefined;
  limit?: number | undefined;
  unread?: boolean | undefined;
  important?: boolean | undefined;
  bot?: string | undefined;
  category?: string | undefined;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface PortalApi {
  login(accessId: string): Promise<{ customer: { displayName: string }; session: { idleExpiresAt: string; absoluteExpiresAt: string } }>;
  logout(): Promise<void>;
  me(): Promise<PortalProfile>;
  inbox(params: PortalInboxParams): Promise<PortalInboxPage>;
  filters(): Promise<PortalFilters>;
  email(deliveryId: string): Promise<PortalEmailDetail>;
  attachmentUrl(deliveryId: string, attachmentId: string): Promise<{ url: string; expiresIn: number }>;
  /** Asks the backend to sync the mailboxes behind this session now (returns immediately). */
  sync(): Promise<PortalSyncRequest>;
  /** Whether a sync is still running and when the last one finished (server time). */
  syncStatus(): Promise<PortalSyncStatus>;
}

export interface PortalSyncRequest {
  status: "QUEUED" | "ALREADY_RUNNING" | "NOTHING_TO_SYNC";
  lastSyncAt: string | null;
}

export interface PortalSyncStatus {
  running: boolean;
  lastSyncAt: string | null;
}

export function createPortalApi(options: { baseUrl: string; fetch?: typeof fetch }): PortalApi {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "Network error");
    }
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error;
      throw new ApiError(response.status, error?.code ?? "HTTP_ERROR", error?.message ?? `HTTP ${response.status}`);
    }
    return payload as T;
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    login: (accessId) => request("POST", "/api/portal/session", { accessId }),
    logout: () => request("POST", "/api/portal/logout"),
    me: () => request("GET", "/api/portal/me"),
    inbox: (params) =>
      request(
        "GET",
        `/api/portal/inbox${buildQuery({
          cursor: params.cursor,
          limit: params.limit,
          unread: params.unread,
          important: params.important,
          bot: params.bot,
          category: params.category,
          search: params.search,
          from: params.from,
          to: params.to
        })}`
      ),
    filters: () => request("GET", "/api/portal/filters"),
    email: async (deliveryId) => (await request<{ email: PortalEmailDetail }>("GET", `/api/portal/email/${id(deliveryId)}`)).email,
    attachmentUrl: (deliveryId, attachmentId) => request("GET", `/api/portal/email/${id(deliveryId)}/attachments/${id(attachmentId)}`),
    // No body: the session decides the scope (no customer / organization / bot / account ids are ever sent).
    sync: () => request("POST", "/api/portal/sync"),
    syncStatus: () => request("GET", "/api/portal/sync")
  };
}

/** Friendly, generic messages: never internal details. */
export function portalErrorMessage(error: unknown, context: "inbox" | "email" | "login" | "download" = "inbox"): string {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 429) return "Has realizado demasiadas solicitudes. Espera un momento e inténtalo nuevamente.";
  if (context === "login") {
    if (status === 401 || status === 400 || status === 403) return "Access ID o credenciales no válidas.";
    return "No pudimos iniciar sesión. Inténtalo nuevamente.";
  }
  if (status === 401) return "Tu sesión expiró. Vuelve a ingresar con tu Access ID.";
  if (status === 403) return "No tienes acceso a este contenido.";
  if (context === "email" && status === 404) return "El correo no está disponible.";
  if (context === "download") return "No pudimos preparar la descarga. Inténtalo nuevamente.";
  if (context === "email") return "No pudimos cargar el correo. Inténtalo nuevamente.";
  return "No pudimos cargar tus correos. Inténtalo nuevamente.";
}
