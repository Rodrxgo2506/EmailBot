import { HttpTimeoutError } from "@emailbot/shared";
import { ProviderAuthError, ProviderTransientError, type ProviderContext } from "./types.js";

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/**
 * Authenticated JSON GET against a provider API.
 *
 * - 401: refreshes the token once and retries; a second 401 means the
 *   credentials are no longer valid (ProviderAuthError).
 * - 429 / 5xx / network errors: ProviderTransientError (job is retried).
 * - other 4xx: ProviderHttpError (caller decides).
 *
 * Error messages contain the status only, never tokens or response bodies.
 */
export async function providerGet(
  context: ProviderContext,
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {}
): Promise<unknown> {
  for (const forceRefresh of [false, true]) {
    const accessToken = await context.getAccessToken({ forceRefresh });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...headers }
      });
    } catch (error) {
      // Timeouts (HttpTimeoutError) and network failures are transient: BullMQ retries with backoff.
      const reason = error instanceof HttpTimeoutError ? "Timed out" : "Network error";
      throw new ProviderTransientError(`${reason} calling ${new URL(url).host}`, null);
    }

    if (response.status === 401 && !forceRefresh) continue;
    if (response.status === 401) {
      throw new ProviderAuthError("Provider rejected the refreshed access token", "PROVIDER_UNAUTHORIZED");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ProviderTransientError(`Provider returned HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      throw new ProviderHttpError(`Provider returned HTTP ${response.status}`, response.status);
    }
    return response.json();
  }

  throw new ProviderAuthError("Provider authentication failed", "PROVIDER_UNAUTHORIZED");
}

export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}
