/*
 * F5.4: cancellation of the worker's provider HTTP requests (Gmail, Microsoft Graph, OAuth token endpoints) by
 * the shutdown.
 *
 * Each request already has its own limit: fetchWithTimeout (@emailbot/shared, PROVIDER_HTTP_TIMEOUT_MS) aborts it
 * through an AbortSignal that reaches undici (the socket is closed) and covers the response body. This module adds
 * ONE worker-wide signal, combined with the caller's (AbortSignal.any: no listener stays on the long-lived signal):
 *   - abort() cancels every request in flight (same transport-level abort) and refuses new ones at once;
 *   - a request cancelled this way rejects with RequestCancelledError, distinct from a timeout (HttpTimeoutError)
 *     and from network / HTTP errors.
 * Cancelling only stops the local request: the provider may have received it and may still process it (a token
 * issued, a watch or subscription created, ...). Nothing is ever reported as undone.
 * Supabase (PostgREST / Storage) requests are NOT covered: they keep their own limit (F5.3).
 */

export class RequestCancelledError extends Error {
  constructor(readonly host: string) {
    super(`Request to ${host} cancelled by the worker shutdown`);
    this.name = "RequestCancelledError";
  }
}

export interface RequestCancellation {
  readonly signal: AbortSignal;
  /** Cancels the requests in flight and refuses new ones (idempotent). */
  abort(): void;
}

export function createRequestCancellation(): RequestCancellation {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: () => controller.abort(new Error("worker shutdown"))
  };
}

function hostOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

/** `fetchImpl` whose requests are also cancelled by `cancelled` (see the header). */
export function cancellableFetch(fetchImpl: typeof fetch, cancelled: AbortSignal): typeof fetch {
  return async (input, init) => {
    if (cancelled.aborted) throw new RequestCancelledError(hostOf(input));
    // Always a dependent signal: nothing is attached to the long-lived one itself.
    const signal = AbortSignal.any(init?.signal ? [init.signal, cancelled] : [cancelled]);
    try {
      return await fetchImpl(input, { ...init, signal });
    } catch (error) {
      if (cancelled.aborted && !init?.signal?.aborted) throw new RequestCancelledError(hostOf(input));
      throw error;
    }
  };
}
