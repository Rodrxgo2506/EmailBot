import { HttpTimeoutError } from "@emailbot/shared";
import { ResponseTooLargeError } from "../infrastructure/attachment-transfer.js";
import { RequestCancelledError } from "../infrastructure/http-cancellation.js";
import { ProviderAuthError, ProviderCancelledError, ProviderTransientError, type ProviderContext } from "./types.js";

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
 * - cancelled by the worker shutdown (F5.4): ProviderCancelledError, also transient (job is retried).
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
  return providerRequest(context, "GET", url, undefined, fetchImpl, headers);
}

/**
 * F5.7: authenticated GET whose successful response is handed to `read` instead of being parsed as JSON (Gmail
 * attachment bodies, decoded from their bytes). Same authentication and error classification as providerGet; the
 * errors of `read` itself are not reclassified (like a JSON parse error before).
 */
export async function providerGetResponse<T>(
  context: ProviderContext,
  url: string,
  fetchImpl: typeof fetch,
  read: (response: Response) => Promise<T>
): Promise<T> {
  return providerRequest(context, "GET", url, undefined, fetchImpl, {}, read);
}

/** Authenticated JSON POST (e.g. Gmail users.watch); same error classification as providerGet. */
export async function providerPost(context: ProviderContext, url: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  return providerRequest(context, "POST", url, body, fetchImpl, { "content-type": "application/json" });
}

/** Authenticated JSON PATCH (Graph subscription renewal); same error classification as providerGet. */
export async function providerPatch(context: ProviderContext, url: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  return providerRequest(context, "PATCH", url, body, fetchImpl, { "content-type": "application/json" });
}

/** Authenticated DELETE (Graph subscription removal); 204 resolves to null. */
export async function providerDelete(context: ProviderContext, url: string, fetchImpl: typeof fetch): Promise<unknown> {
  return providerRequest(context, "DELETE", url, undefined, fetchImpl, {});
}

/** No content (DELETE) resolves to null; every other success has a JSON body (GET / POST / PATCH). */
const readJson = (response: Response): Promise<unknown> => (response.status === 204 ? Promise.resolve(null) : response.json());

async function providerRequest<T = unknown>(
  context: ProviderContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  read: (response: Response) => Promise<T> = readJson as (response: Response) => Promise<T>
): Promise<T> {
  for (const forceRefresh of [false, true]) {
    const accessToken = await context.getAccessToken({ forceRefresh });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      if (error instanceof RequestCancelledError) throw new ProviderCancelledError(`Cancelled by the worker shutdown calling ${new URL(url).host}`);
      // F5.5: an attachment body over the size limit is not a network failure: retrying cannot help.
      if (error instanceof ResponseTooLargeError) throw error;
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
    return read(response);
  }

  throw new ProviderAuthError("Provider authentication failed", "PROVIDER_UNAUTHORIZED");
}

export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}
