// F5.5 test fixture (not a test file): the worker's attachment chain in its own process (index.ts wiring: undici
// fetch -> boundedDownloadFetch -> cancellableFetch for downloads, createWorkerUploadClient for uploads), against the
// parent's throwaway servers (F55_PROVIDER_URL, F55_STORAGE_URL: loopback only). The servers live in the parent so
// that their buffers do not count here. Driven over IPC by worker-attachment-transfer.test.ts.
//   F55_MODE=memory   downloads + uploads F55_CONCURRENCY attachments "big-<n>" at once; reports peak memory
//                     (F55_LEGACY=1: attachments through the plain provider fetch, as before F5.5 - for comparison)
//   F55_MODE=shutdown starts F55_CONCURRENCY uploads (Storage reads them very slowly); on {signal} runs the real F5.1
//                     shutdown (exit = process.exit); tries one more upload after the cancellation
import { fetchWithTimeout } from "@emailbot/shared";
import { boundedDownloadFetch, encodedAttachmentLimit } from "../../infrastructure/attachment-transfer.js";
import { cancellableFetch, createRequestCancellation } from "../../infrastructure/http-cancellation.js";
import { createJobTracker, createShutdown, shutdownLimits } from "../../infrastructure/shutdown.js";
import { createWorkerSupabase, createWorkerUploadClient } from "../../infrastructure/supabase-client.js";
import { createAttachmentStorage } from "../../infrastructure/supabase-stores.js";
import { createGmailAdapter } from "../../providers/gmail/adapter.js";

const loopback = (value: string | undefined) => {
  if (!value || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) throw new Error("F55 URLs must be loopback");
  return value;
};
const providerUrl = loopback(process.env.F55_PROVIDER_URL);
const storageUrl = loopback(process.env.F55_STORAGE_URL);
const MAX = 25 * 1024 * 1024;
const concurrency = Number(process.env.F55_CONCURRENCY ?? 1);
const send = (message: Record<string, unknown>) => process.send?.(message);
const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

const toProvider: typeof fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return globalThis.fetch(new URL(url.pathname + url.search, providerUrl), init);
};
const requests = createRequestCancellation();
const providerFetch = cancellableFetch(fetchWithTimeout(toProvider, 20_000), requests.signal);
const attachmentFetch = cancellableFetch(boundedDownloadFetch(toProvider, { idleMs: 20_000, totalMs: 120_000, maxBytes: encodedAttachmentLimit(MAX) }), requests.signal);
const storage = createAttachmentStorage(createWorkerSupabase(storageUrl, "service-role-test-key", 60_000), createWorkerUploadClient(storageUrl, "service-role-test-key", 120_000, requests.signal));
const gmail = createGmailAdapter(providerFetch, process.env.F55_LEGACY === "1" ? cancellableFetch(fetchWithTimeout(toProvider, 120_000), requests.signal) : attachmentFetch);
const context = { account: { id: "gmail-1", provider: "GMAIL" }, getAccessToken: async () => "access-token" } as never;

async function memory() {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  gc?.();
  const base = process.memoryUsage();
  const baseMaxRss = process.resourceUsage().maxRSS * 1024;
  const peak = { rss: base.rss, heapUsed: base.heapUsed, external: base.external, arrayBuffers: base.arrayBuffers };
  const sampler = setInterval(() => {
    const now = process.memoryUsage();
    for (const key of Object.keys(peak) as Array<keyof typeof peak>) peak[key] = Math.max(peak[key], now[key]);
  }, 1);
  const started = Date.now();
  const sizes = await Promise.all(
    Array.from({ length: concurrency }, async (_, n) => {
      const content = await gmail.downloadAttachment(context, `msg-${n}`, `big-${n}`);
      await storage.upload("email-attachments", `memory/${n}.bin`, content, "application/octet-stream");
      return content.byteLength;
    })
  );
  clearInterval(sampler);
  const maxRss = process.resourceUsage().maxRSS * 1024;
  send({
    event: "memory",
    chain: process.env.F55_LEGACY === "1" ? "before F5.5" : "F5.5",
    concurrency,
    attachmentMiB: mib(sizes[0] ?? 0),
    ms: Date.now() - started,
    // peaks sampled every ~1 ms (synchronous steps such as JSON.parse are only seen once they return)
    peakDeltaMiB: { rss: mib(peak.rss - base.rss), heapUsed: mib(peak.heapUsed - base.heapUsed), external: mib(peak.external - base.external), arrayBuffers: mib(peak.arrayBuffers - base.arrayBuffers) },
    // the OS's peak resident set of the whole process (not sampled: every allocation counts)
    maxRssDeltaMiB: mib(maxRss - baseMaxRss),
    baseRssMiB: mib(base.rss)
  });
  process.disconnect?.();
}

async function shutdown() {
  const tracker = createJobTracker();
  const content = new Uint8Array(4 * 1024 * 1024);
  const jobs = Array.from({ length: concurrency }, (_, n) =>
    tracker.wrap(() => storage.upload("email-attachments", `shutdown/${n}.bin`, content, "application/octet-stream"))().then(
      () => "stored",
      (error: Error) => error.name
    )
  );
  let started = 0;
  const orchestrator = createShutdown(
    {
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      workers: [],
      tracker,
      markStopping: () => undefined,
      abortImap: () => undefined,
      interruptBlockedClients: () => requests.abort(),
      release: [],
      disconnect: () => undefined,
      flush: async () => undefined,
      exit: (code) => {
        void (async () => {
          // after the cancellation no new upload may start (refused before any request)
          const late = await storage.upload("email-attachments", "shutdown/late.bin", content, "application/octet-stream").then(
            () => "stored",
            (error: Error) => error.name
          );
          send({ event: "exit", code, jobs: await Promise.all(jobs), late, shutdownMs: Date.now() - started, socketsAtExit: process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length });
          process.exit(code);
        })();
      }
    },
    shutdownLimits(15_000)
  );
  process.on("message", (message: { signal?: string }) => {
    if (message.signal) {
      started = Date.now();
      orchestrator.onSignal(message.signal);
    }
  });
  send({ event: "uploading" });
}

if (process.env.F55_MODE === "memory") await memory();
else await shutdown();
