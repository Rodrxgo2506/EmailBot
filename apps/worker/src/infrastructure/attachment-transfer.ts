import { HttpTimeoutError } from "@emailbot/shared";

/*
 * F5.5: limits of the worker's attachment downloads (Gmail / Microsoft Graph return the content base64-encoded in a
 * JSON body).
 *
 * Every other provider request keeps one total limit (fetchWithTimeout, PROVIDER_HTTP_TIMEOUT_MS, 20 s by default).
 * For an attachment that limit made a healthy but slow transfer fail on every attempt: a 25 MiB attachment is about
 * 33 MiB of JSON, which needs more than 1.7 MiB/s to arrive in 20 s. Here the body is read as a stream with:
 *   - an inactivity limit (idleMs): no byte for that long - a hung or stalled server fails as fast as before;
 *   - a total limit (totalMs): a transfer that keeps progressing may last that long;
 *   - a size limit (maxBytes): reading stops (and the request is aborted) as soon as the body exceeds it, so a body
 *     larger than the attachment limit is never held in memory.
 * Timeouts reject with HttpTimeoutError (classified as before: transient, the job is retried); the size limit with
 * ResponseTooLargeError (the content is not stored, like an attachment over WORKER_MAX_ATTACHMENT_BYTES). A caller's
 * signal (the shutdown cancellation, F5.4) is honoured and its abort is rethrown unchanged. Aborting only stops the
 * local transfer.
 */

export class ResponseTooLargeError extends Error {
  constructor(
    readonly host: string,
    readonly maxBytes: number
  ) {
    super(`Response from ${host} is larger than ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/** Largest JSON body for an attachment of `maxAttachmentBytes`: its base64 form plus room for the JSON envelope. */
export function encodedAttachmentLimit(maxAttachmentBytes: number): number {
  return Math.ceil(maxAttachmentBytes / 3) * 4 + 64 * 1024;
}

export interface DownloadLimits {
  idleMs: number;
  totalMs: number;
  maxBytes: number;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function hostOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

/**
 * F5.7: the body already read, handed back chunk by chunk as it arrived (no joined copy); each chunk is released once
 * consumed. Reading it cannot time out, be cancelled or fail on the network: all of that happened before.
 */
function replay(chunks: Array<Uint8Array | undefined>): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[next];
        if (next >= chunks.length || !chunk) return controller.close();
        chunks[next++] = undefined;
        controller.enqueue(chunk);
      },
      cancel() {
        chunks.length = 0;
      }
    },
    { highWaterMark: 0 }
  );
}

/** `fetchImpl` with the download limits above; the body is handed back in memory (like fetchWithTimeout). */
export function boundedDownloadFetch(fetchImpl: typeof fetch, limits: DownloadLimits): typeof fetch {
  return async (input, init) => {
    const host = hostOf(input);
    const controller = new AbortController();
    let failure: Error | null = null;
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      controller.abort(error);
    };
    const total = setTimeout(() => fail(new HttpTimeoutError(host, limits.totalMs)), limits.totalMs);
    let idle = setTimeout(() => fail(new HttpTimeoutError(host, limits.idleMs)), limits.idleMs);
    const progress = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(new HttpTimeoutError(host, limits.idleMs)), limits.idleMs);
    };
    try {
      const signal = AbortSignal.any(init?.signal ? [init.signal, controller.signal] : [controller.signal]);
      const response = await fetchImpl(input, { ...init, signal });
      progress();
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        fail(new ResponseTooLargeError(host, limits.maxBytes));
        throw failure;
      }
      if (NULL_BODY_STATUSES.has(response.status) || init?.method === "HEAD" || !response.body) {
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limits.maxBytes) {
          fail(new ResponseTooLargeError(host, limits.maxBytes));
          await reader.cancel().catch(() => undefined);
          throw failure;
        }
        chunks.push(value);
        progress();
      }
      return new Response(replay(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      // Our own limit (timeout / size) wins; a caller's abort and network errors are rethrown unchanged.
      if (failure) throw failure;
      throw error;
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
    }
  };
}
