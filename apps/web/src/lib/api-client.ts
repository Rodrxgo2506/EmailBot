import type { ApiErrorBody } from "@emailbot/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Current Supabase access token (refreshed by supabase-js). */
  getAccessToken(): Promise<string | null>;
  /** Active organization, sent as X-Organization-Id. */
  getOrganizationId(): string | null;
  fetch?: typeof fetch;
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * Thin JSON client for the EmailBot API. Tokens are only ever sent in the
 * Authorization header (never in URLs) and errors are surfaced as ApiError.
 */
export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = await options.getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const organizationId = options.getOrganizationId();
    if (organizationId) headers["x-organization-id"] = organizationId;
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "No se pudo conectar con la API");
    }

    if (response.status === 204) return undefined as T;

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "HTTP_ERROR",
        error?.message ?? `HTTP ${response.status}`,
        error?.details
      );
    }
    return payload as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
    delete: <T = void>(path: string) => request<T>("DELETE", path)
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
