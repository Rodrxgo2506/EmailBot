/*
 * Every outbound HTTP call (Google, Microsoft, Supabase) goes through a fetch
 * with a deadline. Without one, a provider that accepts the connection and
 * never answers keeps an API request or a worker slot busy forever.
 */

/** An outbound request did not complete (headers AND body) within its deadline. */
export class HttpTimeoutError extends Error {
  constructor(
    readonly host: string,
    readonly timeoutMs: number
  ) {
    super(`Request to ${host} timed out after ${timeoutMs} ms`);
    this.name = "HttpTimeoutError";
  }
}

function hostOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Wraps fetch with a deadline covering the whole exchange: the response body
 * is read inside the deadline and handed back as an in-memory Response, so a
 * stalled body cannot hang a later `response.json()`. A caller-provided
 * signal is still honoured. Timeouts surface as HttpTimeoutError; other
 * network errors are rethrown unchanged.
 */
export function fetchWithTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;

    try {
      const response = await fetchImpl(input, { ...init, signal });
      const body = NULL_BODY_STATUSES.has(response.status) || init?.method === "HEAD" ? null : await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (deadline.aborted && !init?.signal?.aborted) throw new HttpTimeoutError(hostOf(input), timeoutMs);
      throw error;
    }
  };
}
