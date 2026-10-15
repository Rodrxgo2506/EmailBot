// F5.4 test fixture (not a test file): a provider request through the worker's real fetch chain (undici fetch,
// fetchWithTimeout with a 30 s limit, cancellableFetch) to F54_HANG_URL (a parent-process server that never
// answers), cancelled after 200 ms. It reports the error and its active resources, then must END BY ITSELF: no
// socket, listener or timer of the cancelled request may keep it alive (no process.exit here).
import { fetchWithTimeout } from "@emailbot/shared";
import { cancellableFetch, createRequestCancellation } from "../../infrastructure/http-cancellation.js";

const url = process.env.F54_HANG_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error("F54_HANG_URL must be a loopback URL");
const cancellation = createRequestCancellation();
const providerFetch = cancellableFetch(fetchWithTimeout(globalThis.fetch, 30_000), cancellation.signal);
setTimeout(() => cancellation.abort(), 200);
const started = Date.now();
const error = await providerFetch(url).then(
  () => null,
  (caught: unknown) => caught as Error
);
const ms = Date.now() - started;
// Let the aborted request's own cleanup run (it is asynchronous) before looking.
await new Promise((resolve) => setImmediate(resolve));
process.send?.({ error: error?.name ?? null, ms, resources: process.getActiveResourcesInfo() });
process.disconnect?.();
