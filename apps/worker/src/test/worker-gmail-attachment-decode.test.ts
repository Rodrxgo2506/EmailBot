import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { fetchWithTimeout, type EmailProcessingJob } from "@emailbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { boundedDownloadFetch, encodedAttachmentLimit, ResponseTooLargeError } from "../infrastructure/attachment-transfer.js";
import { createAttachmentContents, createAttachmentTransfers } from "../infrastructure/attachment-transfers.js";
import { cancellableFetch, createRequestCancellation, RequestCancelledError } from "../infrastructure/http-cancellation.js";
import { createWorkerSupabase, createWorkerUploadClient } from "../infrastructure/supabase-client.js";
import { createAttachmentStorage } from "../infrastructure/supabase-stores.js";
import { AttachmentsPendingError, processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createGmailAdapter } from "../providers/gmail/adapter.js";
import { decodeGmailAttachmentChunks, MalformedAttachmentError } from "../providers/gmail/attachment-body.js";
import { createMicrosoftAdapter } from "../providers/microsoft/adapter.js";
import { decodeBase64Url, ProviderHttpError } from "../providers/http.js";
import { ProviderAuthError, ProviderCancelledError, ProviderTransientError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAudit, makeEmail, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";

/*
 * F5.7: Gmail attachment bodies decoded from their bytes (providers/gmail/attachment-body.ts) instead of JSON text ->
 * parsed object -> base64 strings. Through the worker's real chain (undici fetch -> boundedDownloadFetch ->
 * cancellableFetch -> Gmail adapter; storage-js uploads) against two throwaway HTTP servers on 127.0.0.1: a Gmail
 * attachments endpoint that sends exactly the bytes planned, and a Storage. No Supabase, no remote, no real account.
 */

const MAX = 2 * 1024 * 1024; // attachment limit in these tests (production: 25 MiB)
const IDLE_MS = 400; // PROVIDER_HTTP_TIMEOUT_MS in these tests (production: 20 s)
const KEY = "service-role-test-key";
const BS = "\\";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Plan = { body: Buffer; statuses?: number[]; mode?: "send" | "hang" | "reset" | "stall"; chunk?: number; delayMs?: number };
const plans = new Map<string, Plan>(); // by attachment id
const requests: Array<{ id: string; status: number; closed: boolean }> = [];
const objects = new Map<string, Buffer>(); // Storage objects by path
const uploads: string[] = [];
let storageFailures = 0; // the next N uploads answer 500
const sockets = new Set<Socket>();
let provider: Server;
let storage: Server;
let providerBase = "";
let storageBase = "";

const gmailBody = (content: Buffer, data = content.toString("base64url")) => Buffer.from(JSON.stringify({ size: content.length, data }));
/** A body whose `data` is the given JSON string contents (written as is: escapes included). */
const dataBody = (data: string) => Buffer.from(`{"data":"${data}"}`, "utf8");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The chain before F5.7, step by step and independent of the new decoder: undici's response.json(), the adapter's
 * former zod schema, decodeBase64Url (unchanged, still used by Microsoft). Same results with Node 22.23.3 (the
 * worker's image) and Node 24.
 */
const previousSchema = z.object({ data: z.string() });
async function previousChain(body: Buffer): Promise<Buffer> {
  return Buffer.from(decodeBase64Url(previousSchema.parse(await new Response(body).json()).data));
}
async function previousOutcome(body: Buffer): Promise<string> {
  try {
    return (await previousChain(body)).toString("hex");
  } catch (error) {
    return `REJECTED ${(error as Error).name}`;
  }
}
/** The new decoder on `body`: whole, one byte per chunk, and split in two at every position (small bodies). */
function newOutcomes(body: Buffer): Set<string> {
  const outcomes = new Set<string>();
  const attempt = (chunks: Uint8Array[]) => {
    try {
      outcomes.add(Buffer.from(decodeGmailAttachmentChunks(chunks)).toString("hex"));
    } catch (error) {
      outcomes.add(error instanceof MalformedAttachmentError ? "MALFORMED" : `THREW ${(error as Error).name}`);
    }
  };
  attempt([body]);
  if (body.length > 4096) {
    for (const piece of [4093, 65_536]) attempt(Array.from({ length: Math.ceil(body.length / piece) }, (_, n) => body.subarray(n * piece, (n + 1) * piece)));
    return outcomes;
  }
  attempt(Array.from(body, (_, n) => body.subarray(n, n + 1)));
  for (let at = 1; at < body.length; at++) attempt([body.subarray(0, at), body.subarray(at)]);
  return outcomes;
}
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

function serveAttachment(request: IncomingMessage, response: ServerResponse) {
  const id = decodeURIComponent((request.url ?? "").split("?")[0]?.split("/").at(-1) ?? "");
  const plan = plans.get(id);
  const status = plan?.statuses?.shift() ?? (plan ? 200 : 404);
  const entry = { id, status, closed: false };
  requests.push(entry);
  response.once("close", () => (entry.closed = true)); // answered, or its connection closed
  if (status === 204) return void response.writeHead(204).end();
  if (!plan || status !== 200) return void response.writeHead(status, { "content-type": "application/json" }).end('{"error":{"code":1}}');
  if (plan.mode === "hang") return;
  response.writeHead(200, { "content-type": "application/json" });
  const chunk = plan.chunk ?? 64 * 1024;
  void (async () => {
    for (let offset = 0; offset < plan.body.length && !entry.closed; offset += chunk) {
      if (plan.mode === "stall" && offset >= plan.body.length / 2) return; // stops sending, keeps the connection
      if (plan.mode === "reset" && offset >= plan.body.length / 2) return void request.socket.destroy();
      response.write(plan.body.subarray(offset, offset + chunk));
      if (plan.delayMs) await sleep(plan.delayMs);
    }
    if (!entry.closed) response.end();
  })();
}

function serveStorage(request: IncomingMessage, response: ServerResponse) {
  const path = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(/^\/storage\/v1\/object\//, "");
  if (request.method === "HEAD") return void response.writeHead(objects.has(path) ? 200 : 404).end();
  uploads.push(path);
  const parts: Buffer[] = [];
  request.on("data", (part: Buffer) => parts.push(part));
  request.on("end", () => {
    if (storageFailures > 0) {
      storageFailures -= 1;
      return void response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ statusCode: "500", error: "boom", message: "boom" }));
    }
    objects.set(path, Buffer.concat(parts));
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

/**
 * The worker's wiring (index.ts) with test limits. `afterDownload` runs once the attachment body has been received
 * (before the adapter decodes it); `limit` adds the F5.6 limiters (k, m = k + 1).
 */
function pipeline(options: { totalMs?: number; afterDownload?: (cancel: () => void) => void; limit?: number } = {}) {
  const cancellation = createRequestCancellation();
  const providerFetch = cancellableFetch(fetchWithTimeout(toProvider, IDLE_MS), cancellation.signal);
  const bounded = cancellableFetch(boundedDownloadFetch(toProvider, { idleMs: IDLE_MS, totalMs: options.totalMs ?? 10_000, maxBytes: encodedAttachmentLimit(MAX) }), cancellation.signal);
  const attachmentFetch: typeof fetch = async (input, init) => {
    const response = await bounded(input, init);
    options.afterDownload?.(() => cancellation.abort());
    return response;
  };
  const store = createAttachmentStorage(createWorkerSupabase(storageBase, KEY, 2_000), createWorkerUploadClient(storageBase, KEY, 10_000, cancellation.signal));
  const transfers = options.limit === undefined ? undefined : createAttachmentTransfers(options.limit, cancellation.signal);
  const contents = options.limit === undefined ? undefined : createAttachmentContents(options.limit + 1, cancellation.signal);
  const account: WorkerAccount = makeAccount({ id: "gmail-1", provider: "GMAIL", emailAddress: "a@gmail.com" });
  const gmail = createGmailAdapter(providerFetch, attachmentFetch);
  const microsoft = createMicrosoftAdapter(providerFetch, attachmentFetch);
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
  const context = (): ProviderContext => ({ account, getAccessToken: async () => "access-token" });
  /** One email `msg-<id>` carrying the attachment `id` (declared size: `declared`, else the planned content's). */
  const attach = (id: string, declared: number) => {
    const adapter = { ...gmail, fetchMessage: vi.fn(async () => makeEmail({ providerMessageId: `msg-${id}`, attachments: [{ providerAttachmentId: id, filename: `${id}.bin`, contentType: "application/octet-stream", size: declared, contentId: null, isInline: false }] })) };
    const deps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]), emails, routing: new MemoryRoutingStore(emails), audit: makeAudit(), storage: store,
      realtime: makeRealtime(), producer: makeProducer(), providers: { GMAIL: adapter, MICROSOFT: adapter, IMAP: adapter } as never,
      createContext: context, attachmentsBucket: "email-attachments", maxAttachmentBytes: MAX, storageRetryDelayMs: 0, logger: silentLogger,
      ...(transfers ? { attachmentTransfers: transfers } : {}),
      ...(contents ? { attachmentContents: contents } : {})
    };
    const job: EmailProcessingJob = { organizationId: account.organizationId, emailAccountId: account.id, provider: "GMAIL", providerMessageId: `msg-${id}` };
    return (attempt = 1) => processEmail(job, deps, { attempt });
  };
  const row = (id: string) => emails.rows.find((entry) => entry.provider_message_id === `msg-${id}`);
  const attachmentRow = (id: string) => emails.attachments.find((entry) => entry.provider_attachment_id === id);
  return { cancellation, gmail, microsoft, context, emails, attach, row, attachmentRow, transfers, contents };
}
const stored = (id: string) => [...objects.entries()].find(([path]) => path.includes(`/${id}.bin`))?.[1];
const downloadsOf = (id: string) => requests.filter((entry) => entry.id === id).length;
async function failure(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
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
  requests.length = 0;
  objects.clear();
  uploads.length = 0;
  storageFailures = 0;
});

describe("F5.7: Gmail attachments decoded incrementally from the bytes of the body", () => {
  it("1. valid bodies of any size, key order, spacing and escapes, split at any byte: the same bytes as the previous chain (response.json + decodeBase64Url); the chunks are released", async () => {
    for (const size of [0, 1, 2, 3, 4, 5, 1024, 65_537, 300 * 1024]) {
      const content = randomBytes(size);
      const bodies = [
        gmailBody(content),
        gmailBody(content, content.toString("base64")), // standard alphabet with padding: accepted, as before
        Buffer.from(JSON.stringify({ data: content.toString("base64url"), attachmentId: `ANGjdJ${"x".repeat(300)}`, size }, null, 2)),
        Buffer.from(`\n { "nested" : {"data": ["x", {"data": "zz"}]}, "attachmentId":"a${BS}"b" ,"data" : "${content.toString("base64").replace(/\//g, `${BS}/`)}" } `),
        Buffer.from(`{"d${BS}u0061ta":"${[...content.toString("base64url")].map((character, index) => (index % 7 === 0 ? `${BS}u00${character.charCodeAt(0).toString(16).padStart(2, "0")}` : character)).join("")}"}`)
      ];
      for (const body of bodies) {
        const expected = await previousChain(body);
        expect(expected.equals(content)).toBe(true);
        for (const piece of body.length <= 4096 ? [1, 3, 7, body.length || 1] : [4093, 65_536, body.length]) {
          const chunks: Array<Uint8Array | undefined> = [];
          for (let offset = 0; offset < body.length; offset += piece) chunks.push(body.subarray(offset, offset + piece));
          const decoded = decodeGmailAttachmentChunks(chunks);
          expect(Buffer.from(decoded).equals(expected), `size ${size}, piece ${piece}`).toBe(true);
          expect(decoded.byteLength).toBe(content.length);
          expect(decoded.buffer.byteLength).toBe(content.length); // exactly sized: no larger buffer behind the content
          expect(chunks.every((chunk) => chunk === undefined)).toBe(true);
        }
      }
    }
  }, 20_000); // ~0.43 s alone, 1.6-1.9 s under the full CI test step (Linux, Node 22, 4 CPUs): same limit as tests 2-8

  it("2. through the real chain: small and near-limit attachments, received in odd-sized slow chunks, are stored byte-identical, downloaded and uploaded once", async () => {
    const env = pipeline();
    const cases = [
      { id: "small", content: randomBytes(10), chunk: 3, delayMs: 0 },
      { id: "medium", content: randomBytes(700 * 1024 + 1), chunk: 10_007, delayMs: 0 },
      { id: "near-max", content: randomBytes(MAX - 2), chunk: 65_521, delayMs: 5 }
    ];
    for (const entry of cases) {
      plans.set(entry.id, { body: gmailBody(entry.content), chunk: entry.chunk, delayMs: entry.delayMs });
      await env.attach(entry.id, entry.content.length)();
      expect(env.row(entry.id)?.processing_status, entry.id).toBe("PROCESSED");
      expect(stored(entry.id)?.equals(entry.content), entry.id).toBe(true);
      expect(env.attachmentRow(entry.id)?.storage_uploaded, entry.id).toBe(true);
      expect(downloadsOf(entry.id), entry.id).toBe(1);
    }
    expect(uploads).toHaveLength(3);
  }, 20_000);

  it("3. size limits unchanged: exactly the limit is stored; over the limit once decoded (body under the encoded limit) is not stored; a body over the encoded limit is cut while downloading and not stored", async () => {
    const env = pipeline();
    const exact = randomBytes(MAX);
    plans.set("exact", { body: gmailBody(exact) });
    await env.attach("exact", MAX)();
    expect(stored("exact")?.equals(exact)).toBe(true);

    const over = randomBytes(MAX + 1);
    expect(gmailBody(over).length).toBeLessThan(encodedAttachmentLimit(MAX)); // reaches the decoder
    plans.set("over", { body: gmailBody(over) });
    await env.attach("over", 1_000)(); // the provider declared a small size
    expect(env.row("over")?.processing_status).toBe("PROCESSED"); // like an attachment over the limit: metadata only
    expect(stored("over")).toBeUndefined();

    const huge = randomBytes(MAX + 64 * 1024);
    plans.set("huge", { body: gmailBody(huge), chunk: 32 * 1024, delayMs: 2 });
    await expect(env.gmail.downloadAttachment(env.context(), "msg-huge", "huge")).rejects.toBeInstanceOf(ResponseTooLargeError);
    await env.attach("huge", 1_000)();
    expect(stored("huge")).toBeUndefined();
    expect(env.row("huge")?.processing_status).toBe("PROCESSED");
    expect(uploads).toHaveLength(1); // only "exact"
    await vi.waitFor(() => expect(requests.filter((entry) => entry.id === "huge").every((entry) => entry.closed)).toBe(true));
  }, 20_000);

  it("4. rejected bodies (invalid before too, or decoded before into bytes that could not be trusted) through the job: MalformedAttachmentError, the content stays pending, nothing uploaded, one download per run", async () => {
    const malformed = {
      "not-json": "not json at all",
      truncated: '{"size":3,"data":"QUJD',
      "no-data": '{"size":3}',
      "data-number": '{"data":12}',
      "data-twice": '{"data":"QUJD","data":"QUJD"}',
      array: '[{"data":"QUJD"}]',
      "invalid-character": '{"data":"QU!JD"}',
      "data-after-padding": '{"data":"QQ==QUJD"}',
      "single-last-character": '{"data":"QUJDQ"}',
      "backspace-escape": `{"data":"QU${BS}bJD"}`,
      "bad-envelope": '{"size":tru,"data":"QUJD"}',
      "trailing-garbage": '{"data":"QUJD"} x'
    };
    const env = pipeline();
    for (const [id, body] of Object.entries(malformed)) {
      plans.set(id, { body: Buffer.from(body) });
      const error = await failure(() => env.gmail.downloadAttachment(env.context(), `msg-${id}`, id));
      expect(error, id).toBeInstanceOf(MalformedAttachmentError);
      expect(String((error as Error).message), id).not.toContain("QUJD"); // the message never carries content
      plans.set(id, { body: Buffer.from(body) });
      const run = await failure(() => env.attach(id, 3)());
      expect(run, id).toBeInstanceOf(AttachmentsPendingError);
      expect(env.row(id)?.processing_status, id).toBe("PROCESSING");
      expect(env.attachmentRow(id)?.storage_uploaded, id).not.toBe(true);
      expect(downloadsOf(id), id).toBe(2); // the direct call + the job's single download
    }
    expect(uploads).toHaveLength(0);
  }, 20_000);

  it("5. provider errors keep their classification (same as providerGet): 401 -> token refreshed once; 401 twice -> auth; 404 -> HTTP error; 429 / 500 / reset / stalled -> transient", async () => {
    const env = pipeline();
    const content = randomBytes(50 * 1024);
    const refreshes: boolean[] = [];
    const context: ProviderContext = { ...env.context(), getAccessToken: async ({ forceRefresh } = {}) => (refreshes.push(forceRefresh === true), "access-token") };
    plans.set("refresh", { body: gmailBody(content), statuses: [401] });
    expect(Buffer.from(await env.gmail.downloadAttachment(context, "msg-refresh", "refresh")).equals(content)).toBe(true);
    expect(refreshes).toEqual([false, true]);
    expect(requests.map((entry) => entry.status)).toEqual([401, 200]);

    plans.set("revoked", { body: gmailBody(content), statuses: [401, 401] });
    expect(await failure(() => env.gmail.downloadAttachment(env.context(), "msg-revoked", "revoked"))).toBeInstanceOf(ProviderAuthError);
    expect(await failure(() => env.gmail.downloadAttachment(env.context(), "msg-missing", "missing"))).toMatchObject({ name: ProviderHttpError.name, status: 404 });
    for (const status of [429, 500, 503]) {
      plans.set(`status-${status}`, { body: gmailBody(content), statuses: [status] });
      expect(await failure(() => env.gmail.downloadAttachment(env.context(), "msg", `status-${status}`)), String(status)).toMatchObject({ name: ProviderTransientError.name, status });
    }
    const big = randomBytes(600 * 1024);
    plans.set("reset", { body: gmailBody(big), mode: "reset", chunk: 32 * 1024, delayMs: 5 });
    const reset = await failure(() => env.gmail.downloadAttachment(env.context(), "msg-reset", "reset"));
    expect(reset).toBeInstanceOf(ProviderTransientError);
    expect((reset as Error).message).toMatch(/^Network error calling/);
    plans.set("stall", { body: gmailBody(big), mode: "stall", chunk: 32 * 1024, delayMs: 5 });
    const stalled = await failure(() => env.gmail.downloadAttachment(env.context(), "msg-stall", "stall"));
    expect(stalled).toBeInstanceOf(ProviderTransientError);
    expect((stalled as Error).message).toMatch(/^Timed out calling/);
    await vi.waitFor(() => expect(requests.filter((entry) => entry.id === "reset" || entry.id === "stall").every((entry) => entry.closed)).toBe(true));
  }, 20_000);

  it("6. cancellation: during the download the job stops at once as CANCELLED, the connection closes, nothing is decoded or uploaded; once the body has arrived the (local) decoding completes but nothing is uploaded and the row is not marked", async () => {
    const content = randomBytes(1024 * 1024);
    plans.set("cancel-download", { body: gmailBody(content), chunk: 16 * 1024, delayMs: 30 });
    const downloading = pipeline();
    setTimeout(() => downloading.cancellation.abort(), 300);
    const started = Date.now();
    expect(await failure(() => downloading.attach("cancel-download", content.length)())).toBeInstanceOf(ProviderCancelledError);
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(requests[0]?.closed).toBe(true), { timeout: 1_000 });

    plans.set("cancel-decode", { body: gmailBody(content) });
    let cancelledAfterDownload = false;
    const decoding = pipeline({ afterDownload: (cancel) => ((cancelledAfterDownload = true), cancel()) });
    expect(await failure(() => decoding.attach("cancel-decode", content.length)())).toBeInstanceOf(RequestCancelledError);
    expect(cancelledAfterDownload).toBe(true);
    for (const env of [downloading, decoding]) expect(env.emails.rows[0]?.processing_status).toBe("PROCESSING");
    expect(decoding.attachmentRow("cancel-decode")?.storage_uploaded).not.toBe(true);
    expect({ uploads: uploads.length, objects: objects.size, downloads: downloadsOf("cancel-decode") }).toEqual({ uploads: 0, objects: 0, downloads: 1 });
  }, 20_000);

  it("7. no duplicate download, idempotent storage: Storage fails, the in-job retry reuses the decoded content; a later run finds the object and neither downloads nor uploads again", async () => {
    const content = randomBytes(300 * 1024);
    plans.set("retry", { body: gmailBody(content) });
    const env = pipeline();
    storageFailures = 2;
    await env.attach("retry", content.length)(1);
    expect(env.row("retry")?.processing_status).toBe("PROCESSED");
    expect(downloadsOf("retry")).toBe(1);
    expect(uploads).toHaveLength(3); // 500, 500, 200: the same deterministic path each time
    expect(new Set(uploads).size).toBe(1);
    expect(stored("retry")?.equals(content)).toBe(true);

    // A run whose attachment row is not marked (as if that update had been lost): same deterministic path, the object
    // is found - no download, no upload, the row is marked.
    const again = pipeline();
    await again.attach("retry", content.length)(2);
    expect(again.attachmentRow("retry")?.storage_uploaded).toBe(true);
    expect(again.attachmentRow("retry")?.storage_path).toBe(env.attachmentRow("retry")?.storage_path);
    expect({ downloads: downloadsOf("retry"), uploads: uploads.length, objects: objects.size }).toEqual({ downloads: 1, uploads: 3, objects: 1 });
  }, 20_000);

  it("8. F5.6 limits unchanged: three emails at once with k = 1, m = 2 -> at most 1 transfer and 2 contents; every content stored intact; the limiters end empty", async () => {
    const env = pipeline({ limit: 1 });
    const contents = [0, 1, 2].map(() => randomBytes(400 * 1024));
    contents.forEach((content, n) => plans.set(`limited-${n}`, { body: gmailBody(content), chunk: 32 * 1024, delayMs: 2 }));
    let maxTransfers = 0;
    let maxContents = 0;
    const sampler = setInterval(() => {
      maxTransfers = Math.max(maxTransfers, env.transfers!.active());
      maxContents = Math.max(maxContents, env.contents!.active());
    }, 1);
    try {
      await Promise.all(contents.map((content, n) => env.attach(`limited-${n}`, content.length)()));
    } finally {
      clearInterval(sampler);
    }
    expect({ maxTransfers, maxContents }).toEqual({ maxTransfers: 1, maxContents: 2 });
    contents.forEach((content, n) => expect(stored(`limited-${n}`)?.equals(content)).toBe(true));
    expect([env.transfers!.active(), env.transfers!.waiting(), env.contents!.active(), env.contents!.waiting()]).toEqual([0, 0, 0, 0]);
    expect(requests).toHaveLength(3);
  }, 20_000);
});

describe("F5.7 M1: compatibility with the previous chain (response.json + decodeBase64Url)", () => {
  it("M1a. everything the previous chain decoded correctly is accepted with byte-identical output, whatever the chunk cuts: whitespace, line breaks, padding, escapes, byte order marks", async () => {
    const accepted: Record<string, Buffer> = {
      "url alphabet": dataBody("-_-_"),
      "standard alphabet": dataBody("+/+/"),
      "mixed alphabets": dataBody("-/+_"),
      "padding ==": dataBody("QQ=="),
      "padding =": dataBody("QUI="),
      "unpadded, 2 in the last group": dataBody("QQ"),
      "unpadded, 3 in the last group": dataBody("QUI"),
      "non-canonical trailing bits": dataBody("QR=="),
      "raw spaces": dataBody(" Q U J D "),
      "escaped line feed": dataBody(`QUJD${BS}nQUJD`),
      "escaped CRLF": dataBody(`QUJD${BS}r${BS}nQUJD`),
      "escaped tab": dataBody(`QU${BS}tJD`),
      "escaped form feed": dataBody(`QU${BS}fJD`),
      "unicode-escaped vertical tab": dataBody(`QU${BS}u000bJD`),
      "unicode-escaped space": dataBody(`QU${BS}u0020JD`),
      "unicode-escaped CR LF": dataBody(`QUJD${BS}u000d${BS}u000aQUJD`),
      "escaped slash": dataBody(`QUJ${BS}/`),
      "unicode-escaped letter": dataBody(`Q${BS}u0055JD`),
      "unicode-escaped padding": dataBody(`QQ${BS}u003d${BS}u003d`),
      "one extra = after a full group": dataBody("QUJD="),
      "two extra =": dataBody("QUJD=="),
      "four extra =": dataBody("QUJD===="),
      "one extra = after QUI=": dataBody("QUI=="),
      "one extra = after QQ==": dataBody("QQ==="),
      "padding then a space": dataBody("QQ== "),
      "padding split by a space": dataBody("QQ= ="),
      "padding then an escaped CRLF": dataBody(`QQ==${BS}r${BS}n`),
      "empty": dataBody(""),
      "only spaces": dataBody("   "),
      "only padding": dataBody("=="),
      "one byte order mark": Buffer.concat([BOM, dataBody("QUJD")]),
      "two byte order marks": Buffer.concat([BOM, BOM, dataBody("QUJD")]),
      "whitespace around every token": Buffer.from(' \r\n\t{ "size" : 3 ,\n "data" :\t"QUJD" }\n'),
      "pretty-printed with extra fields": Buffer.from(JSON.stringify({ attachmentId: `ANGjdJ${"x".repeat(200)}`, size: 3, data: "QUJD" }, null, 2)),
      "escaped key": Buffer.from(`{"d${BS}u0061ta":"QUJD"}`),
      "the text data inside another value": Buffer.from(`{"x":"${BS}"data${BS}":${BS}"REVG","data":"QUJD"}`),
      "similar keys, nested data": Buffer.from('{"Data":"REVG","data_":"REVG","dat":"REVG","n":{"data":"REVG"},"l":[{"data":"REVG"}],"data":"QUJD"}'),
      "envelope over 1 MiB (accepted before; bounded by the download limit)": Buffer.from(`{"x":"${"a".repeat(1024 * 1024 + 1)}","data":"QUJD"}`)
    };
    for (const [name, body] of Object.entries(accepted)) {
      const before = await previousOutcome(body);
      expect(before, name).not.toMatch(/^REJECTED/);
      expect([...newOutcomes(body)], name).toEqual([before]);
    }
  }, 60_000);

  it("M1b. line-wrapped base64 (escaped CRLF every 76 characters, or spaces every 64) through the real chain: stored byte-identical to the previous chain's output, downloaded once", async () => {
    const env = pipeline();
    const content = randomBytes(300 * 1024 + 2);
    const variants = {
      "crlf-wrapped": content.toString("base64").match(/.{1,76}/g)!.join(`${BS}r${BS}n`),
      "space-wrapped": content.toString("base64url").match(/.{1,64}/g)!.join(" ")
    };
    for (const [id, data] of Object.entries(variants)) {
      const body = Buffer.from(`{"size":${content.length},"data":"${data}"}`);
      expect((await previousChain(body)).equals(content), id).toBe(true);
      expect([...newOutcomes(body)], id).toEqual([content.toString("hex")]);
      plans.set(id, { body, chunk: 10_007 });
      await env.attach(id, content.length)();
      expect(stored(id)?.equals(content), id).toBe(true);
      expect(downloadsOf(id), id).toBe(1);
    }
  }, 30_000);

  it("M1c. deliberately rejected although the previous chain accepted them (its bytes could not be trusted: skipped characters, dropped last character, truncated at the padding, ambiguous repeated data), whatever the chunk cuts", async () => {
    const rejected: Record<string, Buffer> = {
      "invalid character !": dataBody("QU!JD"),
      "invalid characters . and *": dataBody("Q.U*JD"),
      "escaped backspace": dataBody(`QU${BS}bJD`),
      "escaped quote": dataBody(`QU${BS}"JD`),
      "escaped backslash": dataBody(`QU${BS}${BS}JD`),
      "no-break space": dataBody(`QU${BS}u00a0JD`),
      "character above Latin-1": dataBody(`QU${BS}u0100JD`),
      "non-ASCII UTF-8": Buffer.from(`{"data":"QU${String.fromCharCode(0xe9)}JD"}`, "utf8"),
      "single last character": dataBody("QUJDQ"),
      "single last character, padded": dataBody("QUJDQ==="),
      "single character, padded": dataBody("Q==="),
      "data after the padding": dataBody("QQ==QUJD"),
      "data after an extra =": dataBody("QUJD=QUJD"),
      "repeated data": Buffer.from('{"data":"QUJD","data":"REVG"}'),
      "repeated data, the first invalid": Buffer.from('{"data":"!!","data":"REVG"}')
    };
    for (const [name, body] of Object.entries(rejected)) {
      expect(await previousOutcome(body), name).not.toMatch(/^REJECTED/);
      expect([...newOutcomes(body)], name).toEqual(["MALFORMED"]);
    }
  });

  it("M1d. invalid before and now, whatever the chunk cuts: not JSON, not an object, no string data, truncated, bad escapes, raw control characters, misplaced or incomplete byte order marks", async () => {
    const rejected: Record<string, Buffer> = {
      "empty body": Buffer.alloc(0),
      "not JSON": Buffer.from("nope"),
      array: Buffer.from('[{"data":"QUJD"}]'),
      string: Buffer.from('"data"'),
      "no data": Buffer.from('{"size":3}'),
      "nested data only": Buffer.from('{"a":{"data":"QUJD"}}'),
      "data null": Buffer.from('{"data":null}'),
      "data number": Buffer.from('{"data":12}'),
      truncated: Buffer.from('{"data":"QUJD'),
      "truncated after the key": Buffer.from('{"data":'),
      "trailing garbage": Buffer.from('{"data":"QUJD"} x'),
      "bad envelope": Buffer.from('{"size":tru,"data":"QUJD"}'),
      "bad hex escape": dataBody(`QU${BS}u00zzJD`),
      "unknown escape": dataBody(`QU${BS}xJD`),
      "lone backslash at the end": Buffer.from(`{"data":"QUJD${BS}`),
      "raw control character": dataBody(`QU${String.fromCharCode(1)}JD`),
      "raw line feed": dataBody(`QU${String.fromCharCode(10)}JD`),
      "three byte order marks": Buffer.concat([BOM, BOM, BOM, dataBody("QUJD")]),
      "byte order mark after whitespace": Buffer.concat([Buffer.from(" "), BOM, dataBody("QUJD")]),
      "incomplete byte order mark": Buffer.concat([BOM.subarray(0, 2), dataBody("QUJD")]),
      "only a byte order mark": BOM,
      "UTF-16": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"data":"QUJD"}', "utf16le")])
    };
    for (const [name, body] of Object.entries(rejected)) {
      expect(await previousOutcome(body), name).toMatch(/^REJECTED/);
      expect([...newOutcomes(body)], name).toEqual(["MALFORMED"]);
    }
  });

  it("M1e. a 204 answer (no body): rejected as before (ZodError then, MalformedAttachmentError now); the content stays pending", async () => {
    expect(previousSchema.safeParse(null).success).toBe(false); // providerGet resolved a 204 to null
    const env = pipeline();
    plans.set("no-content", { body: Buffer.alloc(0), statuses: [204] });
    expect(await failure(() => env.gmail.downloadAttachment(env.context(), "msg-no-content", "no-content"))).toBeInstanceOf(MalformedAttachmentError);
    plans.set("no-content", { body: Buffer.alloc(0), statuses: [204] });
    expect(await failure(() => env.attach("no-content", 3)())).toBeInstanceOf(AttachmentsPendingError);
    expect(env.attachmentRow("no-content")?.storage_uploaded).not.toBe(true);
    expect(uploads).toHaveLength(0);
  });

  it("M1f. escapes cost linear time, even inside one large chunk (each search resumes where the previous one ended)", () => {
    const content = randomBytes(96 * 1024);
    const escaped = [...content.toString("base64")].map((character) => `${BS}u00${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    const body = Buffer.from(`{"data":"${escaped}"}`); // ~786 KB in one chunk, ~131 000 escapes
    const started = performance.now();
    const decoded = decodeGmailAttachmentChunks([body]);
    const ms = performance.now() - started;
    expect(Buffer.from(decoded).equals(content)).toBe(true);
    // searching to the end of the chunk after every escape (the audited version) takes many seconds here
    expect(ms).toBeLessThan(3_000);
    console.log("F5.7 (M1f):", JSON.stringify({ bodyBytes: body.length, ms: Math.round(ms) }));
  });
});

describe("F5.7: the replayed body and the other provider", () => {
  it("boundedDownloadFetch hands back the very chunks it read (no copy) and releases each one as soon as it is consumed, while the rest of the body is still pending", async () => {
    const refs: Array<WeakRef<Uint8Array>> = [];
    const source: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let n = 0; n < 8; n++) {
              const chunk = new Uint8Array(256 * 1024).fill(n);
              refs.push(new WeakRef(chunk));
              controller.enqueue(chunk);
            }
            controller.close();
          }
        })
      );
    const response = await boundedDownloadFetch(source, { idleMs: 1_000, totalMs: 5_000, maxBytes: 4 * 1024 * 1024 })("http://gmail.test/attachment");
    const reader = response.body!.getReader();
    const collect = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(0);
        gc();
      }
      return refs.map((ref) => ref.deref() !== undefined);
    };
    let read = 0;
    const readOne = async () => {
      const { done, value } = await reader.read();
      if (!done) expect(value === refs[read]!.deref(), `chunk ${read}`).toBe(true); // the same object: no copy
      if (!done) read++;
      return done;
    };
    for (let n = 0; n < 4; n++) await readOne();
    // half read, the stream still open: the 4 chunks consumed are gone, the 4 pending are still held for the reader
    expect(await collect()).toEqual([false, false, false, false, true, true, true, true]);
    while (!(await readOne()));
    expect(read).toBe(8);
    expect(await collect()).toEqual(Array(8).fill(false));
  });

  it("Microsoft Graph keeps its path over the replayed body: slow, irregular chunks stored byte-identical; invalid JSON is still a SyntaxError", async () => {
    const env = pipeline();
    const content = randomBytes(500 * 1024 + 1);
    plans.set("graph", { body: Buffer.from(JSON.stringify({ contentBytes: content.toString("base64") })), chunk: 9_973, delayMs: 1 });
    expect(Buffer.from(await env.microsoft.downloadAttachment(env.context(), "msg-graph", "graph")).equals(content)).toBe(true);
    plans.set("graph-invalid", { body: Buffer.from('{"contentBytes":"QUJD"'), chunk: 5 });
    expect(await failure(() => env.microsoft.downloadAttachment(env.context(), "msg-graph", "graph-invalid"))).toMatchObject({ name: "SyntaxError" });
    expect(downloadsOf("graph")).toBe(1);
  }, 20_000);
});
