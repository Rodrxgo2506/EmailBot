import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { fetchWithTimeout, type EmailProcessingJob } from "@emailbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import { boundedDownloadFetch, encodedAttachmentLimit } from "../infrastructure/attachment-transfer.js";
import { cancellableFetch, createRequestCancellation, RequestCancelledError } from "../infrastructure/http-cancellation.js";
import { createWorkerSupabase, createWorkerUploadClient } from "../infrastructure/supabase-client.js";
import { createAttachmentStorage } from "../infrastructure/supabase-stores.js";
import { AttachmentsPendingError, processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createGmailAdapter } from "../providers/gmail/adapter.js";
import { createMicrosoftAdapter } from "../providers/microsoft/adapter.js";
import { ProviderCancelledError, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAudit, makeEmail, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";

/*
 * F5.5: the attachment cycle (provider download -> Storage upload -> attachment row) through the worker's real chain:
 * the Gmail / Microsoft adapters' real downloads (undici fetch -> boundedDownloadFetch -> cancellableFetch) and the
 * real storage-js uploads (createWorkerUploadClient), against two throwaway HTTP servers on 127.0.0.1: a "provider"
 * (Gmail / Graph attachment endpoints) and a "Storage" (HEAD / POST /storage/v1/object/...). No Supabase, no remote.
 */

const MAX = 2 * 1024 * 1024; // attachment limit in these tests (production: 25 MiB)
const IDLE_MS = 400; // PROVIDER_HTTP_TIMEOUT_MS in these tests (production: 20 s)
const KEY = "service-role-test-key";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Plan = { content: Buffer; mode: "fast" | "slow" | "stall" | "reset" | "hang" | "huge"; chunk?: number; delayMs?: number };
const plans = new Map<string, Plan>(); // by attachment id
const downloads: Array<{ id: string; sent: number; closed: boolean }> = [];
const objects = new Map<string, Buffer>(); // Storage objects by path
const uploads: Array<{ path: string; closed: boolean; complete: boolean; received: number; closedAt: number }> = [];
let storageMode: "ok" | "store-then-hang" | "store-then-500" | "fail" | "slow-read" = "ok";
let throttle = true; // slow-read: once false, the server reads the rest at full speed
const slowRequests = new Set<IncomingMessage>();
const CHILD = fileURLToPath(new URL("./fixtures/attachment-child.ts", import.meta.url));
const sockets = new Set<Socket>();
let provider: Server;
let storage: Server;
let providerBase = "";
let storageBase = "";

function serveAttachment(request: IncomingMessage, response: ServerResponse) {
  const path = (request.url ?? "").split("?")[0] ?? "";
  const id = decodeURIComponent(path.split("/").at(-1) ?? "");
  const plan = plans.get(id);
  if (!plan) return void response.writeHead(404).end();
  const entry = { id, sent: 0, closed: false };
  downloads.push(entry);
  request.socket.once("close", () => (entry.closed = true));
  if (plan.mode === "hang") return;
  const encoded = path.includes("/v1.0/") ? plan.content.toString("base64") : plan.content.toString("base64url");
  const body = Buffer.from(JSON.stringify(path.includes("/v1.0/") ? { contentBytes: encoded } : { size: plan.content.length, data: encoded }));
  response.writeHead(200, { "content-type": "application/json" });
  if (plan.mode === "fast") return void (response.end(body), (entry.sent = body.length));
  const chunk = plan.chunk ?? 64 * 1024;
  void (async () => {
    for (let offset = 0; offset < body.length && !entry.closed; offset += chunk) {
      if (plan.mode === "stall" && offset >= body.length / 2) return; // stops sending, keeps the connection
      if (plan.mode === "reset" && offset >= body.length / 2) return void request.socket.destroy();
      response.write(body.subarray(offset, offset + chunk));
      entry.sent = Math.min(body.length, offset + chunk);
      await sleep(plan.delayMs ?? 0);
    }
    if (!entry.closed) response.end();
  })();
}

function serveStorage(request: IncomingMessage, response: ServerResponse) {
  const path = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(/^\/storage\/v1\/object\//, "");
  if (request.method === "HEAD") return void response.writeHead(objects.has(path) ? 200 : 404).end();
  const entry = { path, closed: false, complete: false, received: 0, closedAt: 0 };
  uploads.push(entry);
  request.on("end", () => (entry.complete = true));
  request.on("data", (part: Buffer) => (entry.received += part.length));
  request.socket.once("close", () => ((entry.closed = true), (entry.closedAt = Date.now())));
  if (storageMode === "slow-read") {
    // reads the body very slowly (a chunk every 200 ms): the upload is still running when it is cancelled
    slowRequests.add(request);
    request.on("data", () => {
      if (!throttle) return;
      request.pause();
      setTimeout(() => request.resume(), 200);
    });
    return;
  }
  const parts: Buffer[] = [];
  request.on("data", (part: Buffer) => parts.push(part));
  request.on("end", () => {
    if (storageMode === "fail") return void response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ statusCode: "500", error: "boom", message: "boom" }));
    objects.set(path, Buffer.concat(parts));
    if (storageMode === "store-then-hang") return; // stored, but the answer never comes
    if (storageMode === "store-then-500") return void response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ statusCode: "500", error: "boom", message: "boom" }));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Key: path, Id: "id" }));
  });
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Provider hosts -> the local "provider" (same path), through the real undici fetch. */
const toProvider: typeof fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return globalThis.fetch(new URL(url.pathname + url.search, providerBase), init);
};

/** The worker's wiring (index.ts) with test limits; `legacy` = attachments through the plain provider fetch (before F5.5). */
function pipeline(options: { provider?: "GMAIL" | "MICROSOFT"; totalMs?: number; uploadMs?: number; legacy?: boolean } = {}) {
  const cancellation = createRequestCancellation();
  const providerFetch = cancellableFetch(fetchWithTimeout(toProvider, IDLE_MS), cancellation.signal);
  const attachmentFetch = cancellableFetch(boundedDownloadFetch(toProvider, { idleMs: IDLE_MS, totalMs: options.totalMs ?? 10_000, maxBytes: encodedAttachmentLimit(MAX) }), cancellation.signal);
  const store = createAttachmentStorage(createWorkerSupabase(storageBase, KEY, 2_000), createWorkerUploadClient(storageBase, KEY, options.uploadMs ?? 10_000, cancellation.signal));
  const provider = options.provider ?? "GMAIL";
  const account: WorkerAccount = makeAccount({ id: `${provider.toLowerCase()}-1`, provider, emailAddress: provider === "GMAIL" ? "a@gmail.com" : "a@outlook.com" });
  const real = provider === "GMAIL" ? createGmailAdapter(providerFetch, options.legacy ? providerFetch : attachmentFetch) : createMicrosoftAdapter(providerFetch, options.legacy ? providerFetch : attachmentFetch);
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
  const attach = (id: string, size: number) => {
    const adapter = { ...real, fetchMessage: vi.fn(async (_c: unknown, messageId: string) => makeEmail({ providerMessageId: messageId, attachments: [{ providerAttachmentId: id, filename: `${id}.bin`, contentType: "application/octet-stream", size, contentId: null, isInline: false }] })) };
    const deps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]), emails, routing: new MemoryRoutingStore(emails), audit: makeAudit(), storage: store,
      realtime: makeRealtime(), producer: makeProducer(), providers: { GMAIL: adapter, MICROSOFT: adapter, IMAP: adapter } as never,
      createContext: (worker: WorkerAccount) => ({ account: worker, getAccessToken: async () => "access-token" }),
      attachmentsBucket: "email-attachments", maxAttachmentBytes: MAX, storageRetryDelayMs: 0, logger: silentLogger
    };
    const job: EmailProcessingJob = { organizationId: account.organizationId, emailAccountId: account.id, provider, providerMessageId: `msg-${id}` };
    return { deps, job, run: (attempt = 1) => processEmail(job, deps, { attempt }) };
  };
  return { cancellation, emails, attach };
}
const state = (emails: MemoryEmailStore) => ({ status: emails.rows[0]?.processing_status, error: emails.rows[0]?.processing_error_code ?? null, stored: emails.attachments.map((row) => row.storage_uploaded === true) });
async function timed<T>(work: () => Promise<T>) {
  const started = Date.now();
  try {
    return { value: await work(), error: null as unknown, ms: Date.now() - started };
  } catch (error) {
    return { value: null, error, ms: Date.now() - started };
  }
}

beforeAll(async () => {
  ({ server: provider, base: providerBase } = await listen(serveAttachment));
  ({ server: storage, base: storageBase } = await listen(serveStorage));
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([provider, storage].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});
beforeEach(() => {
  plans.clear();
  downloads.length = 0;
  objects.clear();
  uploads.length = 0;
  storageMode = "ok";
  throttle = true;
  slowRequests.clear();
});

describe("F5.5: attachment downloads and uploads - limits, retries, cancellation", () => {
  it("1 + 7. Gmail and Microsoft: an attachment within the limit, fast answer -> stored once, email PROCESSED", async () => {
    for (const providerName of ["GMAIL", "MICROSOFT"] as const) {
      const content = randomBytes(300 * 1024);
      plans.set(`fast-${providerName}`, { content, mode: "fast" });
      const env = pipeline({ provider: providerName });
      await env.attach(`fast-${providerName}`, content.length).run();
      expect(state(env.emails)).toMatchObject({ status: "PROCESSED", error: null });
      const [path, stored] = [...objects.entries()].find(([key]) => key.includes(`fast-${providerName}`))!;
      expect(stored.equals(content)).toBe(true);
      expect(uploads.filter((upload) => upload.path === path)).toHaveLength(1);
    }
    expect(downloads).toHaveLength(2);
  });

  it("2. an attachment close to the size limit, slow but steady (longer than the per-request limit): stored; before F5.5 it failed on every attempt", async () => {
    const content = randomBytes(MAX - 1024);
    const slow = { content, mode: "slow" as const, chunk: 64 * 1024, delayMs: 40 }; // ~2.7 MB of JSON in ~1.7 s, a chunk every 40 ms
    plans.set("near-max", slow);
    const env = pipeline({ totalMs: 10_000 });
    const result = await timed(() => env.attach("near-max", content.length).run());
    expect(result.error).toBeNull();
    expect(result.ms).toBeGreaterThan(4 * IDLE_MS); // took far longer than the per-request limit
    expect(state(env.emails)).toMatchObject({ status: "PROCESSED" });
    expect([...objects.values()][0]?.equals(content)).toBe(true);

    plans.set("near-max-legacy", slow);
    const legacy = pipeline({ legacy: true });
    const before = await timed(() => legacy.attach("near-max-legacy", content.length).run());
    expect(before.error).toBeInstanceOf(AttachmentsPendingError);
    expect(state(legacy.emails)).toMatchObject({ status: "PROCESSING", error: "ATTACHMENTS_PENDING" });
    console.log("F5.5 (2):", JSON.stringify({ f55Ms: result.ms, legacyMs: before.ms, legacy: "ATTACHMENTS_PENDING" }));
  }, 30_000);

  it("3. a download that stalls, is cut, never answers, or exceeds the total limit: the content stays pending (job retried), nothing uploaded, the connection is closed", async () => {
    const content = randomBytes(600 * 1024);
    const cases = [
      { id: "stall", plan: { content, mode: "stall" as const, chunk: 32 * 1024, delayMs: 10 }, totalMs: 10_000, max: IDLE_MS + 1_500 },
      { id: "reset", plan: { content, mode: "reset" as const, chunk: 32 * 1024, delayMs: 10 }, totalMs: 10_000, max: 1_500 },
      { id: "hang", plan: { content, mode: "hang" as const }, totalMs: 10_000, max: IDLE_MS + 1_000 },
      { id: "too-slow", plan: { content, mode: "slow" as const, chunk: 16 * 1024, delayMs: 50 }, totalMs: 1_000, max: 2_200 }
    ];
    for (const entry of cases) {
      plans.set(entry.id, entry.plan);
      const env = pipeline({ totalMs: entry.totalMs });
      const result = await timed(() => env.attach(entry.id, content.length).run());
      expect(result.error, entry.id).toBeInstanceOf(AttachmentsPendingError);
      expect(result.ms, entry.id).toBeLessThan(entry.max);
      expect(state(env.emails), entry.id).toMatchObject({ status: "PROCESSING", error: "ATTACHMENTS_PENDING" });
    }
    expect(uploads).toHaveLength(0);
    await vi.waitFor(() => expect(downloads.map((entry) => entry.closed)).toEqual([true, true, true, true]));
  }, 30_000);

  it("3b. a body larger than the limit (the provider declared a small size) is cut as soon as it exceeds it - never held in memory - and not stored", async () => {
    const content = randomBytes(3 * 1024 * 1024); // its JSON is ~4 MB; the cut is at ~2.8 MB
    plans.set("huge", { content, mode: "huge", chunk: 64 * 1024, delayMs: 5 });
    const env = pipeline();
    const result = await timed(() => env.attach("huge", 1_000).run());
    expect(result.error).toBeNull(); // like an attachment over WORKER_MAX_ATTACHMENT_BYTES: metadata kept, content not stored
    expect(state(env.emails)).toMatchObject({ status: "PROCESSED" });
    expect(uploads).toHaveLength(0);
    await vi.waitFor(() => expect(downloads[0]?.closed).toBe(true));
    const fullBody = Math.ceil(content.length / 3) * 4;
    expect(downloads[0]!.sent).toBeLessThan(fullBody); // the server could not send it all
    console.log("F5.5 (3b):", JSON.stringify({ limit: encodedAttachmentLimit(MAX), bodyBytes: fullBody, sentBeforeClose: downloads[0]!.sent }));
  }, 30_000);

  it("4 + 5. Storage stores the object but its answer never comes: the upload times out ONCE (no in-job retry), the content stays pending; the retry finds the object - no second download, upload or row", async () => {
    const content = randomBytes(200 * 1024);
    plans.set("stored-late", { content, mode: "fast" });
    const env = pipeline({ uploadMs: 800 });
    const first = env.attach("stored-late", content.length);
    storageMode = "store-then-hang";
    const result = await timed(() => first.run(1));
    expect(result.error).toBeInstanceOf(AttachmentsPendingError);
    expect(result.ms).toBeLessThan(800 + 1_000);
    expect(uploads).toHaveLength(1);
    expect(state(env.emails)).toMatchObject({ status: "PROCESSING", error: "ATTACHMENTS_PENDING" });
    storageMode = "ok";
    await first.run(2);
    expect(state(env.emails)).toMatchObject({ status: "PROCESSED", stored: [true] });
    expect({ downloads: downloads.length, uploads: uploads.length, objects: objects.size, rows: env.emails.rows.length, attachments: env.emails.attachments.length }).toEqual({ downloads: 1, uploads: 1, objects: 1, rows: 1, attachments: 1 });
  }, 20_000);

  it("5b. Storage fails (500): retried in-job as before; the next run uploads the same path again (overwrite) - one object, one row", async () => {
    const content = randomBytes(100 * 1024);
    plans.set("storage-500", { content, mode: "fast" });
    const env = pipeline();
    const first = env.attach("storage-500", content.length);
    storageMode = "fail";
    await expect(first.run(1)).rejects.toBeInstanceOf(AttachmentsPendingError);
    expect(uploads).toHaveLength(3); // storageAttempts (default 3), unchanged for errors that are not timeouts
    storageMode = "ok";
    await first.run(2);
    expect(state(env.emails)).toMatchObject({ status: "PROCESSED", stored: [true] });
    expect({ objects: objects.size, attachments: env.emails.attachments.length, rows: env.emails.rows.length }).toEqual({ objects: 1, attachments: 1, rows: 1 });
  });

  it("6. the shutdown cancels a download or an upload in flight: the job stops at once as CANCELLED (not 'pending' content); the download's connection closes at once, the upload's only after undici has flushed what it already handed to the socket", async () => {
    const content = randomBytes(1024 * 1024);
    plans.set("cancel-download", { content, mode: "slow", chunk: 16 * 1024, delayMs: 30 });
    const downloading = pipeline();
    setTimeout(() => downloading.cancellation.abort(), 300);
    const download = await timed(() => downloading.attach("cancel-download", content.length).run());
    expect(download.error).toBeInstanceOf(ProviderCancelledError);
    expect(download.ms).toBeLessThan(1_000);
    expect(uploads).toHaveLength(0);

    plans.set("cancel-upload", { content, mode: "fast" });
    storageMode = "slow-read";
    const uploading = pipeline();
    const run = timed(() => uploading.attach("cancel-upload", content.length).run());
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const abortedAt = Date.now();
    uploading.cancellation.abort();
    const upload = await run;
    expect(upload.error).toBeInstanceOf(RequestCancelledError);
    expect(Date.now() - abortedAt).toBeLessThan(200); // the job does not wait for the transfer
    expect(uploads).toHaveLength(1); // not retried in-job
    expect(objects.size).toBe(0);
    for (const emails of [downloading.emails, uploading.emails]) expect(state(emails).status).toBe("PROCESSING");
    await vi.waitFor(() => expect(downloads[0]?.closed).toBe(true), { timeout: 1_000 });
    // undici (Node 24) keeps writing what it had already handed to the socket before closing the connection: the
    // abort does not stop those bytes, and whether Storage gets the whole object is not guaranteed either way (R1).
    await vi.waitFor(() => expect(uploads[0]?.closed).toBe(true), { timeout: 15_000, interval: 100 });
    console.log("F5.5 (6):", JSON.stringify({ downloadMs: download.ms, uploadClosedAfterAbortMs: Date.now() - abortedAt, uploadCompleted: uploads[0]?.complete }));
  }, 30_000);

  it("R2. Storage persists the object, then its answer is lost (timeout), cancelled (shutdown) or an HTTP error: the row is NOT marked stored by that attempt; the retry finds the object at the deterministic path and marks it - no second download, no duplicate row or object", async () => {
    const results: Record<string, unknown> = {};
    for (const variant of ["timeout", "cancel", "http-500"] as const) {
      plans.clear();
      downloads.length = 0;
      objects.clear();
      uploads.length = 0;
      const content = randomBytes(150 * 1024);
      plans.set(`persisted-${variant}`, { content, mode: "fast" });
      const env = pipeline({ uploadMs: 800 });
      const job = env.attach(`persisted-${variant}`, content.length);
      storageMode = variant === "http-500" ? "store-then-500" : "store-then-hang";
      const pendingRun = timed(() => job.run(1));
      if (variant === "cancel") {
        await vi.waitFor(() => expect(objects.size).toBe(1)); // persisted, answer not sent yet
        env.cancellation.abort();
      }
      const first = await pendingRun;
      const afterFirst = { objects: objects.size, uploads: uploads.length, stored: state(env.emails).stored };
      storageMode = "ok";
      const retry = pipeline(); // the job's retry: a new process / attempt, the same rows
      const second = await timed(() => processEmail(job.job, { ...job.deps, storage: createAttachmentStorage(createWorkerSupabase(storageBase, KEY, 2_000), createWorkerUploadClient(storageBase, KEY, 10_000, retry.cancellation.signal)) }, { attempt: 2 }));
      results[variant] = {
        firstError: (first.error as Error | null)?.name ?? null,
        afterFirst,
        secondError: second.error,
        final: { ...state(env.emails), downloads: downloads.length, uploads: uploads.length, objects: objects.size, attachmentRows: env.emails.attachments.length, emailRows: env.emails.rows.length }
      };
    }
    console.log("F5.5 (R2):", JSON.stringify(results));
    expect(results).toEqual({
      timeout: { firstError: "AttachmentsPendingError", afterFirst: { objects: 1, uploads: 1, stored: [false] }, secondError: null, final: { status: "PROCESSED", error: null, stored: [true], downloads: 1, uploads: 1, objects: 1, attachmentRows: 1, emailRows: 1 } },
      cancel: { firstError: "RequestCancelledError", afterFirst: { objects: 1, uploads: 1, stored: [false] }, secondError: null, final: { status: "PROCESSED", error: null, stored: [true], downloads: 1, uploads: 1, objects: 1, attachmentRows: 1, emailRows: 1 } },
      // a 500 is retried in-job (storageAttempts 3): each attempt overwrites the same path
      "http-500": { firstError: "AttachmentsPendingError", afterFirst: { objects: 1, uploads: 3, stored: [false] }, secondError: null, final: { status: "PROCESSED", error: null, stored: [true], downloads: 1, uploads: 3, objects: 1, attachmentRows: 1, emailRows: 1 } }
    });
  }, 30_000);

  it("R1. shutdown with 3 uploads in flight (real F5.1 orchestrator and process.exit, child process): the jobs stop at once, no upload starts after the cancellation, the process exits within its budget; the bytes already handed over keep flowing - even after the exit - so Storage may still complete the cancelled uploads", async () => {
    storageMode = "slow-read";
    const proc = fork(CHILD, [], { execArgv: ["--import", "tsx"], env: { ...process.env, F55_MODE: "shutdown", F55_CONCURRENCY: "3", F55_PROVIDER_URL: providerBase, F55_STORAGE_URL: storageBase }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const events: Array<Record<string, unknown> & { at: number }> = [];
    proc.on("message", (message: Record<string, unknown>) => events.push({ ...message, at: Date.now() }));
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => proc.on("exit", (code) => resolve({ code, at: Date.now() })));
    try {
      await vi.waitFor(() => expect(uploads).toHaveLength(3), { timeout: 20_000 });
      await sleep(300);
      const signalAt = Date.now();
      const receivedAtSignal = uploads.map((upload) => upload.received);
      proc.send({ signal: "SIGTERM" });
      const exit = await Promise.race([exited, sleep(20_000).then(() => null)]);
      if (!exit) proc.kill();
      const receivedAtExit = uploads.map((upload) => upload.received);
      // The child is gone: let the server read what is left in its buffers at full speed, until each connection ends.
      throttle = false;
      for (const request of slowRequests) request.resume();
      await vi.waitFor(() => expect(uploads.every((upload) => upload.closed)).toBe(true), { timeout: 20_000 });
      const report = events.find((event) => event.event === "exit");
      const run = {
        exitCode: exit?.code ?? "still running",
        exitAfterSignalMs: exit ? exit.at - signalAt : null,
        child: report && { code: report.code, jobs: report.jobs, late: report.late, shutdownMs: report.shutdownMs, socketsAtExit: report.socketsAtExit },
        uploadRequests: uploads.length, // the late upload never reached Storage
        completed: uploads.filter((upload) => upload.complete).length,
        receivedAtSignalKiB: receivedAtSignal.map((bytes) => Math.round(bytes / 1024)),
        receivedAtExitKiB: receivedAtExit.map((bytes) => Math.round(bytes / 1024)),
        receivedInTotalKiB: uploads.map((upload) => Math.round(upload.received / 1024)),
        bodyKiB: 4 * 1024
      };
      console.log("F5.5 (R1):", JSON.stringify(run));
      expect(run.exitCode).toBe(1); // something had to be interrupted
      expect(run.exitAfterSignalMs!).toBeLessThan(15_000);
      expect(run.child).toMatchObject({ jobs: ["RequestCancelledError", "RequestCancelledError", "RequestCancelledError"], late: "RequestCancelledError" });
      expect(run.uploadRequests).toBe(3);
      // Not asserted either way: the abort and the exit do not stop what the OS already holds (observed here: all 3
      // completed after the exit). Safe: same deterministic path, and the retry finds the object (R2 "cancel").
    } finally {
      if (proc.exitCode === null) proc.kill();
    }
  }, 60_000);

  it("R3. memory: peak of one and of three concurrent 25 MiB attachments through the real chain (child process: download -> JSON -> base64 decode -> storage-js upload)", async () => {
    const runs: Array<Record<string, unknown>> = [];
    for (const [concurrency, legacy] of [[1, true], [1, false], [3, true], [3, false]] as const) {
      plans.clear();
      objects.clear();
      for (let n = 0; n < concurrency; n++) plans.set(`big-${n}`, { content: randomBytes(25 * 1024 * 1024 - 1024), mode: "fast" });
      const proc = fork(CHILD, [], { execArgv: ["--expose-gc", "--import", "tsx"], env: { ...process.env, F55_MODE: "memory", F55_LEGACY: legacy ? "1" : "0", F55_CONCURRENCY: String(concurrency), F55_PROVIDER_URL: providerBase, F55_STORAGE_URL: storageBase }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const report = await new Promise<Record<string, unknown>>((resolve, reject) => {
        proc.on("message", (message: Record<string, unknown>) => resolve(message));
        proc.on("exit", (code) => reject(new Error(`child exited ${code} without a report`)));
      });
      runs.push(report);
      expect(objects.size).toBe(concurrency);
      for (const [, stored] of objects) expect(stored.length).toBe(25 * 1024 * 1024 - 1024);
    }
    console.log("F5.5 (R3):", JSON.stringify(runs));
    expect(runs.map((run) => run.concurrency)).toEqual([1, 1, 3, 3]);
  }, 120_000);

  it("config: WORKER_ATTACHMENT_TIMEOUT_MS 120000 by default, 10000..600000, never below PROVIDER_HTTP_TIMEOUT_MS; the attachment limit is unchanged; IMAP stays disabled", () => {
    const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };
    const config = loadWorkerConfig(base);
    expect(config.attachmentTimeoutMs).toBe(120_000);
    expect(config.maxAttachmentBytes).toBe(25 * 1024 * 1024);
    expect(config.providerHttpTimeoutMs).toBe(20_000);
    expect(config.supabaseHttpTimeoutMs).toBe(60_000);
    expect(loadWorkerConfig({ ...base, WORKER_ATTACHMENT_TIMEOUT_MS: "300000" }).attachmentTimeoutMs).toBe(300_000);
    for (const bad of [{ WORKER_ATTACHMENT_TIMEOUT_MS: "9999" }, { WORKER_ATTACHMENT_TIMEOUT_MS: "600001" }, { WORKER_ATTACHMENT_TIMEOUT_MS: "abc" }, { WORKER_ATTACHMENT_TIMEOUT_MS: "15000", PROVIDER_HTTP_TIMEOUT_MS: "20000" }]) {
      expect(() => loadWorkerConfig({ ...base, ...bad })).toThrow(/WORKER_ATTACHMENT_TIMEOUT_MS/);
    }
    expect(encodedAttachmentLimit(25 * 1024 * 1024)).toBe(Math.ceil((25 * 1024 * 1024) / 3) * 4 + 64 * 1024);
    expect(config.imapSyncEnabled).toBe(false);
  });
});
