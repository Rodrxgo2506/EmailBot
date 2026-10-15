import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithTimeout, type EmailProcessingJob } from "@emailbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config/env.js";
import { boundedDownloadFetch, encodedAttachmentLimit } from "../infrastructure/attachment-transfer.js";
import {
  ContentSlotCancelledError,
  createAttachmentContents,
  createAttachmentTransfers,
  TransferSlotCancelledError,
  type AttachmentTransfers
} from "../infrastructure/attachment-transfers.js";
import { cancellableFetch, createRequestCancellation, RequestCancelledError } from "../infrastructure/http-cancellation.js";
import { createJobTracker, createShutdown } from "../infrastructure/shutdown.js";
import { createWorkerSupabase, createWorkerUploadClient } from "../infrastructure/supabase-client.js";
import { createAttachmentStorage } from "../infrastructure/supabase-stores.js";
import { AttachmentsPendingError, processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { createGmailAdapter } from "../providers/gmail/adapter.js";
import { ProviderCancelledError, type WorkerAccount } from "../providers/types.js";
import { makeAccount, makeAccountStore, makeAudit, makeEmail, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";

/*
 * F5.6: the per-process limits of attachment transfers (k) and of retained decoded contents (m)
 * (infrastructure/attachment-transfers.ts) - the limiters alone, then through the real pipeline (processEmail -> storeContent, the Gmail adapter's real download,
 * storage-js uploads) against two throwaway HTTP servers on 127.0.0.1 (a "provider" and a "Storage"), the F5.1
 * shutdown orchestrator, and the real worker entry point with an invalid setting. No Redis, Supabase or remote.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX = 2 * 1024 * 1024;
const KEY = "service-role-test-key";
const WORKER_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

// ---------- throwaway servers: transfers in flight are counted at the servers ----------
type Mode = "fast" | "slow" | "error" | "huge" | "stall";
const plans = new Map<string, { content: Buffer; mode: Mode; declared?: number }>(); // declared: size the provider reports
const events: string[] = []; // "dl:<id>" / "up:<id>:<status>" in arrival order
const objects = new Map<string, Buffer>();
let inFlight = 0;
let maxInFlight = 0;
let uploadFailures = new Map<string, number>(); // attachment id -> uploads to answer 500
const sockets = new Set<Socket>();
let provider: Server;
let storage: Server;
let providerBase = "";
let storageBase = "";

const enter = () => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
};
function serveAttachment(request: IncomingMessage, response: ServerResponse) {
  const id = decodeURIComponent((request.url ?? "").split("?")[0]?.split("/").at(-1) ?? "");
  const plan = plans.get(id);
  if (!plan) return void response.writeHead(404).end();
  events.push(`dl:${id}`);
  enter();
  let left = false;
  const leave = () => {
    if (!left) (left = true), (inFlight -= 1);
  };
  response.on("close", leave);
  if (plan.mode === "error") return void response.writeHead(500, { "content-type": "application/json" }).end("{}");
  const body = Buffer.from(JSON.stringify({ size: plan.content.length, data: plan.content.toString("base64url") }));
  response.writeHead(200, { "content-type": "application/json" });
  if (plan.mode === "fast") return void response.end(body);
  void (async () => {
    for (let offset = 0; offset < body.length && !left; offset += 32 * 1024) {
      if (plan.mode === "stall" && offset > body.length / 2) return; // stops sending
      response.write(body.subarray(offset, offset + 32 * 1024));
      await sleep(plan.mode === "huge" ? 2 : 15);
    }
    if (!left) response.end();
  })();
}
function serveStorage(request: IncomingMessage, response: ServerResponse) {
  const path = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(/^\/storage\/v1\/object\//, "");
  if (request.method === "HEAD") return void response.writeHead(objects.has(path) ? 200 : 404).end();
  const id = path.split("/").at(-1)?.replace(/\.bin$/, "") ?? "";
  enter();
  response.on("close", () => (inFlight -= 1));
  const parts: Buffer[] = [];
  request.on("data", (part: Buffer) => parts.push(part));
  request.on("end", () => {
    const failures = uploadFailures.get(id) ?? 0;
    if (failures > 0) {
      uploadFailures.set(id, failures - 1);
      events.push(`up:${id}:500`);
      return void response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ statusCode: "500", error: "boom", message: "boom" }));
    }
    objects.set(path, Buffer.concat(parts));
    events.push(`up:${id}:200`);
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
const toProvider: typeof fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return globalThis.fetch(new URL(url.pathname + url.search, providerBase), init);
};

/** The index.ts wiring (F5.4 / F5.5 / F5.6) with test limits; `limit` undefined = no transfer limiter (before F5.6). */
function pipeline(options: { limit?: number | undefined; contents?: number | null; idleMs?: number; retryDelayMs?: number } = {}) {
  const cancellation = createRequestCancellation();
  const idleMs = options.idleMs ?? 2_000;
  const providerFetch = cancellableFetch(fetchWithTimeout(toProvider, idleMs), cancellation.signal);
  const attachmentFetch = cancellableFetch(boundedDownloadFetch(toProvider, { idleMs, totalMs: 10_000, maxBytes: encodedAttachmentLimit(MAX) }), cancellation.signal);
  const transfers = options.limit === undefined ? undefined : createAttachmentTransfers(options.limit, cancellation.signal);
  // contents: undefined = k + 1 (the production default), null = no content limiter.
  const contentLimit = options.contents === null ? undefined : (options.contents ?? (options.limit === undefined ? undefined : options.limit + 1));
  const contents = contentLimit === undefined ? undefined : createAttachmentContents(contentLimit, cancellation.signal);
  // Instrumentation (tests only): decoded contents alive = attachments whose download returned and whose email has
  // not finished processing yet - an upper bound of the contents the worker holds (an email holds its content only
  // until storeContent returns, a little before processEmail ends). It counts objects, not bytes or RSS.
  let alive = 0;
  let maxAlive = 0;
  const downloadsPerAttachment = new Map<string, number>();
  const store = createAttachmentStorage(createWorkerSupabase(storageBase, KEY, 2_000), createWorkerUploadClient(storageBase, KEY, 10_000, cancellation.signal));
  const account: WorkerAccount = makeAccount({ id: "gmail-1", provider: "GMAIL" });
  const real = createGmailAdapter(providerFetch, attachmentFetch);
  const gmail = {
    ...real,
    async downloadAttachment(...args: Parameters<typeof real.downloadAttachment>) {
      const content = await real.downloadAttachment(...args);
      alive += 1;
      maxAlive = Math.max(maxAlive, alive);
      downloadsPerAttachment.set(args[2], (downloadsPerAttachment.get(args[2]) ?? 0) + 1);
      return content;
    }
  };
  const emails = new MemoryEmailStore();
  emails.rules = [makeRuleRow({ conditions: { conditions: [{ field: "sender", operator: "contains", value: "streaming.example" }] } })];
  /** Processes one email carrying the given attachment ids (none = an email without attachments). */
  const run = (messageId: string, attachmentIds: string[]) => {
    const adapter = {
      ...gmail,
      fetchMessage: vi.fn(async () =>
        makeEmail({
          providerMessageId: messageId,
          attachments: attachmentIds.map((id) => ({ providerAttachmentId: id, filename: `${id}.bin`, contentType: "application/octet-stream", size: plans.get(id)?.declared ?? plans.get(id)?.content.length ?? 1, contentId: null, isInline: false }))
        })
      )
    };
    const deps: ProcessEmailDeps = {
      accounts: makeAccountStore([account]), emails, routing: new MemoryRoutingStore(emails), audit: makeAudit(), storage: store,
      realtime: makeRealtime(), producer: makeProducer(), providers: { GMAIL: adapter, MICROSOFT: adapter, IMAP: adapter } as never,
      createContext: (worker: WorkerAccount) => ({ account: worker, getAccessToken: async () => "access-token" }),
      attachmentsBucket: "email-attachments", maxAttachmentBytes: MAX, storageRetryDelayMs: options.retryDelayMs ?? 0, logger: silentLogger,
      ...(transfers ? { attachmentTransfers: transfers } : {}),
      ...(contents ? { attachmentContents: contents } : {})
    };
    const job: EmailProcessingJob = { organizationId: account.organizationId, emailAccountId: account.id, provider: "GMAIL", providerMessageId: messageId };
    const downloadsBefore = () => attachmentIds.reduce((sum, id) => sum + (downloadsPerAttachment.get(id) ?? 0), 0);
    const before = downloadsBefore();
    return processEmail(job, deps, { attempt: 1 }).finally(() => (alive -= downloadsBefore() - before));
  };
  const status = (messageId: string) => emails.rows.find((row) => row.provider_message_id === messageId)?.processing_status;
  return { cancellation, transfers, contents, emails, run, status, maxAlive: () => maxAlive, alive: () => alive, downloadsPerAttachment };
}
const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));

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
  events.length = 0;
  objects.clear();
  inFlight = 0;
  maxInFlight = 0;
  uploadFailures = new Map();
});

// ---------- the limiter alone ----------
describe("F5.6: attachment transfer limiter", () => {
  /** A task as storeContent uses the limiter: acquire, work, release in finally. */
  const task = async (transfers: AttachmentTransfers, work: () => Promise<void>) => {
    const permit = await transfers.acquire();
    try {
      await work();
    } finally {
      permit.release();
    }
  };

  it("1 + 2 + 3. k = 1: never more than one active; the next one waits for the end of the current one; permits are granted in FIFO order; waiting tasks are not active", async () => {
    const transfers = createAttachmentTransfers(1);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const work = (name: string) => async () => {
      order.push(`start ${name}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active -= 1;
      order.push(`end ${name}`);
    };
    const all = ["a", "b", "c", "d"].map((name) => task(transfers, work(name)));
    await sleep(5);
    expect({ active: transfers.active(), waiting: transfers.waiting() }).toEqual({ active: 1, waiting: 3 });
    await Promise.all(all);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c", "start d", "end d"]);
    expect({ active: transfers.active(), waiting: transfers.waiting() }).toEqual({ active: 0, waiting: 0 });
  });

  it("11. k = 2: never more than two at once, all served", async () => {
    const transfers = createAttachmentTransfers(2);
    let active = 0;
    let maxActive = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        task(transfers, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          expect(transfers.active()).toBeLessThanOrEqual(2);
          await sleep(5 + ((n * 7) % 20));
          active -= 1;
          done.push(n);
        })
      )
    );
    expect(maxActive).toBe(2);
    expect(done.sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, n) => n));
  });

  it("4. a transfer that throws releases its permit (the next one starts); release is idempotent", async () => {
    const transfers = createAttachmentTransfers(1);
    const failing = task(transfers, async () => {
      await sleep(10);
      throw new Error("network error");
    });
    const next = task(transfers, async () => undefined);
    await expect(failing).rejects.toThrow("network error");
    await next;
    const permit = await transfers.acquire();
    permit.release();
    permit.release(); // a second release changes nothing
    expect(transfers.active()).toBe(0);
    const [x, y] = [await transfers.acquire(), transfers.acquire()];
    expect(transfers.active()).toBe(1); // the double release did not open a second slot
    x.release();
    (await y).release();
  });

  it("5 + 6. the shutdown: waiting tasks are rejected at once (TransferSlotCancelledError, a RequestCancelledError) and never get a permit later; the holder keeps its permit until it releases it; one listener for the whole process", async () => {
    const shutdown = new AbortController();
    const transfers = createAttachmentTransfers(1, shutdown.signal);
    for (let n = 0; n < 50; n++) (await transfers.acquire()).release();
    expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(1);
    const holder = await transfers.acquire();
    const granted: string[] = [];
    const waiters = ["w1", "w2"].map((name) => settle(transfers.acquire().then((permit) => (granted.push(name), permit))));
    await sleep(5);
    expect(transfers.waiting()).toBe(2);
    shutdown.abort();
    for (const waiter of await Promise.all(waiters)) {
      expect(waiter.error).toBeInstanceOf(TransferSlotCancelledError);
      expect(waiter.error).toBeInstanceOf(RequestCancelledError);
    }
    expect({ active: transfers.active(), waiting: transfers.waiting() }).toEqual({ active: 1, waiting: 0 });
    holder.release();
    await sleep(5);
    expect(granted).toEqual([]); // nobody got the permit afterwards
    expect(transfers.active()).toBe(0);
    await expect(transfers.acquire()).rejects.toBeInstanceOf(TransferSlotCancelledError);
  });

  it("C1 + C6. content limiter: never more than m held, FIFO; the shutdown rejects its waiting tasks (ContentSlotCancelledError, a RequestCancelledError) and grants nothing afterwards", async () => {
    const shutdown = new AbortController();
    const contents = createAttachmentContents(2, shutdown.signal);
    let held = 0;
    let maxHeld = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, n) => {
        const permit = await contents.acquire();
        order.push(n);
        held += 1;
        maxHeld = Math.max(maxHeld, held);
        await sleep(10);
        held -= 1;
        permit.release();
      })
    );
    expect(maxHeld).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(1); // one per limiter, none per waiting task
    const a = await contents.acquire();
    const b = await contents.acquire();
    const granted: number[] = [];
    const waiting = [settle(contents.acquire().then((p) => (granted.push(1), p))), settle(contents.acquire().then((p) => (granted.push(2), p)))];
    shutdown.abort();
    for (const result of await Promise.all(waiting)) {
      expect(result.error).toBeInstanceOf(ContentSlotCancelledError);
      expect(result.error).toBeInstanceOf(RequestCancelledError);
    }
    a.release();
    b.release();
    await sleep(5);
    expect(granted).toEqual([]);
    expect({ active: contents.active(), waiting: contents.waiting() }).toEqual({ active: 0, waiting: 0 });
  });

  it("C2. no deadlock with m contents and k transfers (m >= k), tasks pausing between retries: all finish; transfers <= k, contents <= m, and every transfer holder also holds a content permit", async () => {
    for (const [k, m] of [[1, 1], [1, 2], [1, 3], [2, 2], [2, 3], [2, 5]] as const) {
      const transfers = createAttachmentTransfers(k);
      const contents = createAttachmentContents(m);
      let transferring = 0;
      let holdingContent = 0;
      let violations = 0;
      const check = () => {
        if (transferring > k || holdingContent > m || transferring > holdingContent) violations += 1;
      };
      const task = async (n: number) => {
        const content = await contents.acquire();
        holdingContent += 1;
        check();
        try {
          for (let attempt = 0; attempt < 1 + (n % 3); attempt++) {
            const transfer = await transfers.acquire();
            transferring += 1;
            check();
            await sleep(1 + (n % 4));
            transferring -= 1;
            transfer.release(); // a retry wait without the transfer permit, keeping the content permit
            await sleep(n % 2);
          }
        } finally {
          holdingContent -= 1;
          content.release();
        }
      };
      const done = await Promise.race([Promise.all(Array.from({ length: 20 }, (_, n) => task(n))).then(() => "done"), sleep(10_000).then(() => "deadlock")]);
      expect(done, `k=${k} m=${m}`).toBe("done");
      expect(violations, `k=${k} m=${m}`).toBe(0);
      expect([transfers.active(), contents.active(), transfers.waiting(), contents.waiting()]).toEqual([0, 0, 0, 0]);
    }
  }, 20_000);

  it("12. invalid limits: the limiter refuses them; the worker configuration rejects them; the worker does not start", async () => {
    for (const bad of [0, -1, 1.5, 17, Number.NaN]) expect(() => createAttachmentTransfers(bad)).toThrow(RangeError);
    const base = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SUPABASE_URL: "http://127.0.0.1:54321" };
    expect(loadWorkerConfig(base).attachmentTransferConcurrency).toBe(1);
    expect(loadWorkerConfig({ ...base, WORKER_ATTACHMENT_TRANSFER_CONCURRENCY: "2" }).attachmentTransferConcurrency).toBe(2);
    expect(loadWorkerConfig({ ...base, WORKER_ATTACHMENT_TRANSFER_CONCURRENCY: "16" }).attachmentTransferConcurrency).toBe(16);
    for (const bad of ["0", "-1", "1.5", "17", "abc", ""]) {
      expect(() => loadWorkerConfig({ ...base, WORKER_ATTACHMENT_TRANSFER_CONCURRENCY: bad }), bad).toThrow(/WORKER_ATTACHMENT_TRANSFER_CONCURRENCY/);
    }
    // content limit: unset = transfers + 1; at least the transfer limit; 1..32
    expect(loadWorkerConfig(base).attachmentContentConcurrency).toBe(2);
    expect(loadWorkerConfig({ ...base, WORKER_ATTACHMENT_TRANSFER_CONCURRENCY: "3" }).attachmentContentConcurrency).toBe(4);
    expect(loadWorkerConfig({ ...base, WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "5" }).attachmentContentConcurrency).toBe(5);
    expect(loadWorkerConfig({ ...base, WORKER_ATTACHMENT_TRANSFER_CONCURRENCY: "2", WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "2" }).attachmentContentConcurrency).toBe(2);
    for (const bad of [{ WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "0" }, { WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "33" }, { WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "1.5" }, { WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "abc" }, { WORKER_ATTACHMENT_TRANSFER_CONCURRENCY: "3", WORKER_ATTACHMENT_CONTENT_CONCURRENCY: "2" }]) {
      expect(() => loadWorkerConfig({ ...base, ...bad }), JSON.stringify(bad)).toThrow(/WORKER_ATTACHMENT_CONTENT_CONCURRENCY/);
    }
    for (const bad of [0, 33, 2.5]) expect(() => createAttachmentContents(bad)).toThrow(RangeError);
    expect(loadWorkerConfig(base).imapSyncEnabled).toBe(false);
  });

  it("12b. the real worker entry point with an invalid WORKER_ATTACHMENT_TRANSFER_CONCURRENCY or WORKER_ATTACHMENT_CONTENT_CONCURRENCY exits at once with a clear error (before opening any connection)", async () => {
    for (const [name, value] of [["WORKER_ATTACHMENT_TRANSFER_CONCURRENCY", "0"], ["WORKER_ATTACHMENT_CONTENT_CONCURRENCY", "0"]] as const) {
    const empty = mkdtempSync(join(tmpdir(), "f56-start-")); // no .env there
    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        NODE_ENV: "development",
        SUPABASE_URL: "http://127.0.0.1:9",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        REDIS_URL: "redis://127.0.0.1:9",
        [name]: value
      };
      const tsx = import.meta.resolve("tsx");
      const proc = spawn(process.execPath, ["--import", tsx, WORKER_ENTRY], { cwd: empty, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      proc.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      proc.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const started = Date.now();
      const code = await Promise.race([new Promise<number | null>((resolve) => proc.on("exit", resolve)), sleep(30_000).then(() => "timeout" as const)]);
      if (code === "timeout") proc.kill();
      console.log("F5.6 (12b):", JSON.stringify({ variable: name, code, ms: Date.now() - started, mentionsVariable: output.includes(name) }));
      expect(code).not.toBe(0);
      expect(code).not.toBe("timeout");
      expect(output).toContain(name);
      expect(output).not.toMatch(/service-role-test-key/); // no secret in the error
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    }
  }, 80_000);
});

// ---------- through the real pipeline ----------
describe("F5.6: attachment transfer limit in the attachment pipeline", () => {
  const attachments = (prefix: string, count: number, mode: Mode = "slow", size = 300 * 1024) =>
    Array.from({ length: count }, (_, n) => {
      const id = `${prefix}-${n}`;
      plans.set(id, { content: randomBytes(size), mode });
      return id;
    });

  it("1 + 11. four emails processed at once: transfers in flight never exceed k (1, then 2); without the limiter they overlap (4); everything is stored", async () => {
    const runs: Record<string, number> = {};
    for (const limit of [1, 2, undefined]) {
      events.length = 0;
      maxInFlight = 0;
      const ids = attachments(`k${limit ?? "none"}`, 4);
      const env = pipeline({ limit });
      await Promise.all(ids.map((id) => env.run(`msg-${id}`, [id])));
      runs[`k=${limit ?? "none"}`] = maxInFlight;
      for (const id of ids) expect(env.status(`msg-${id}`)).toBe("PROCESSED");
    }
    console.log("F5.6 (1, 11):", JSON.stringify(runs));
    expect(runs).toEqual({ "k=1": 1, "k=2": 2, "k=none": 4 });
    expect(objects.size).toBe(12);
  }, 30_000);

  it("2 + 3. k = 1: the second transfer starts only after the first one's upload; transfers start in arrival order (FIFO)", async () => {
    const ids = attachments("fifo", 3);
    const env = pipeline({ limit: 1 });
    const running: Array<Promise<unknown>> = [];
    for (const id of ids) {
      running.push(env.run(`msg-${id}`, [id]));
      await sleep(20); // arrival order
    }
    await Promise.all(running);
    expect(events).toEqual(["dl:fifo-0", "up:fifo-0:200", "dl:fifo-1", "up:fifo-1:200", "dl:fifo-2", "up:fifo-2:200"]);
  }, 20_000);

  it("4 + 9. errors and the F5.5 limits keep working under the limiter and release the slot: provider 500 (pending), body over the size limit (cut, not stored), stalled download (inactivity limit, pending)", async () => {
    plans.set("err", { content: randomBytes(1024), mode: "error" });
    plans.set("huge", { content: randomBytes(3 * 1024 * 1024), mode: "huge", declared: 1_000 }); // larger than it says
    plans.set("stall", { content: randomBytes(300 * 1024), mode: "stall" });
    const [ok] = attachments("after", 1, "fast");
    const env = pipeline({ limit: 1, idleMs: 300 });
    // Counted on the worker side: an aborted download's socket closes a moment later at the server, which may
    // overlap the next transfer there (the aborted one holds no memory any more).
    let maxActive = 0;
    const sampler = setInterval(() => (maxActive = Math.max(maxActive, env.transfers!.active())), 1);
    const [error, huge, stall, after] = await Promise.all([
      settle(env.run("msg-err", ["err"])),
      settle(env.run("msg-huge", ["huge"])),
      settle(env.run("msg-stall", ["stall"])),
      settle(env.run("msg-after", [ok!]))
    ]);
    expect(error.error).toBeInstanceOf(AttachmentsPendingError);
    expect(huge.error).toBeNull(); // over the limit: not stored, email processed (F5.5)
    expect(stall.error).toBeInstanceOf(AttachmentsPendingError);
    expect(after.error).toBeNull();
    expect(env.status("msg-after")).toBe("PROCESSED");
    clearInterval(sampler);
    expect([...objects.keys()].some((key) => key.includes("huge"))).toBe(false);
    expect(maxActive).toBe(1);
    // each downloaded once (they arrive at the limiter in whatever order the load gives; FIFO itself: test 2 + 3)
    expect(events.filter((event) => event.startsWith("dl:")).sort()).toEqual(["dl:err", "dl:huge", "dl:stall", `dl:${ok}`].sort());
    expect({ active: env.transfers!.active(), waiting: env.transfers!.waiting() }).toEqual({ active: 0, waiting: 0 });
    expect({ active: env.contents!.active(), waiting: env.contents!.waiting() }).toEqual({ active: 0, waiting: 0 });
    expect(env.maxAlive()).toBeLessThanOrEqual(2);
  }, 30_000);

  it("8. an email without attachments is never blocked by the limiter (processed while another email holds the only slot)", async () => {
    const [slowId] = attachments("holder", 1, "slow", 600 * 1024);
    const env = pipeline({ limit: 1 });
    const holding = env.run("msg-holder", [slowId!]);
    await vi.waitFor(() => expect(env.transfers!.active()).toBe(1));
    const started = Date.now();
    await env.run("msg-plain", []);
    const plainMs = Date.now() - started;
    expect(env.status("msg-plain")).toBe("PROCESSED");
    expect(env.transfers!.active()).toBe(1); // the other one was still transferring
    await holding;
    expect(plainMs).toBeLessThan(200);
  }, 20_000);

  it("10 + C3 + C4. k = 1, m = 2: an in-job upload retry gives the transfer slot back during its wait (keeping its content permit): another email's transfer runs in between", async () => {
    const [first] = attachments("retry", 1, "fast");
    const [second] = attachments("other", 1, "slow"); // still transferring when it is observed
    uploadFailures.set(first!, 1); // the first upload answers 500 once
    const env = pipeline({ limit: 1, contents: 2, retryDelayMs: 400 });
    const a = env.run(`msg-${first}`, [first!]);
    await vi.waitFor(() => expect(events).toContain(`up:${first}:500`));
    // A waits for its retry: it keeps its content permit, holds no transfer permit.
    await vi.waitFor(() => expect({ contents: env.contents!.active(), transfers: env.transfers!.active() }).toEqual({ contents: 1, transfers: 0 }));
    const b = env.run(`msg-${second}`, [second!]);
    await vi.waitFor(() => expect(events).toContain(`dl:${second}`));
    expect(env.contents!.active()).toBe(2); // A (waiting) and B (transferring)
    await Promise.all([a, b]);
    expect(events).toEqual([`dl:${first}`, `up:${first}:500`, `dl:${second}`, `up:${second}:200`, `up:${first}:200`]);
    expect(maxInFlight).toBe(1);
    expect([env.status(`msg-${first}`), env.status(`msg-${second}`)]).toEqual(["PROCESSED", "PROCESSED"]);
    expect([env.transfers!.active(), env.contents!.active(), env.transfers!.waiting(), env.contents!.waiting()]).toEqual([0, 0, 0, 0]);
    expect([...env.downloadsPerAttachment.values()]).toEqual([1, 1]); // no repeated download
  }, 20_000);

  it("5 + 6 + 7. F5.1 shutdown with k = 1, m = 2: one email transferring, one holding a content and waiting for the transfer slot, two waiting for a content: the cancel phase cancels the transfer (F5.4) and every wait; nobody else downloads; not forced, within budget", async () => {
    const ids = attachments("shut", 4, "slow", 1024 * 1024);
    const env = pipeline({ limit: 1, contents: 2 });
    const tracker = createJobTracker();
    const steps: string[] = [];
    const closes: boolean[] = [];
    const exits: number[] = [];
    const limits = { totalMs: 5_000, graceMs: 300, cancelMs: 1_000, closeMs: 300, releaseMs: 300, flushMs: 100 };
    const shutdown = createShutdown(
      {
        logger: { ...silentLogger, info: (fields: Record<string, unknown>) => void steps.push(String(fields.phase ?? "")) },
        workers: [{ name: "processing", pause: async () => undefined, close: async (force?: boolean) => void closes.push(force === true) }],
        tracker,
        markStopping: () => undefined,
        abortImap: () => undefined,
        interruptBlockedClients: () => env.cancellation.abort(),
        release: [],
        disconnect: () => undefined,
        flush: async () => undefined,
        exit: (code) => exits.push(code)
      },
      limits
    );
    const jobs = ids.map((id) => settle(tracker.wrap(() => env.run(`msg-${id}`, [id]))()));
    await vi.waitFor(() =>
      expect({ transfers: env.transfers!.active(), transferWaiting: env.transfers!.waiting(), contents: env.contents!.active(), contentWaiting: env.contents!.waiting() }).toEqual({
        transfers: 1,
        transferWaiting: 1,
        contents: 2,
        contentWaiting: 2
      })
    );
    const started = Date.now();
    shutdown.onSignal("SIGTERM");
    const code = await shutdown.running;
    const ms = Date.now() - started;
    const results = (await Promise.all(jobs)).map((result) => (result.error as Error | null)?.name ?? "completed");
    console.log("F5.6 (5-7):", JSON.stringify({ code, ms, results, downloads: events.filter((event) => event.startsWith("dl:")).length, steps, closes }));
    // Whichever job reached the limiter first transfers (arrival order at acquire, not job creation order).
    expect([...results].sort()).toEqual(["ContentSlotCancelledError", "ContentSlotCancelledError", "ProviderCancelledError", "TransferSlotCancelledError"]);
    expect(events.filter((event) => event.startsWith("dl:"))).toHaveLength(1);
    expect(steps).toEqual(["stop", "grace", "cancel", "close", "release", "exit"]);
    expect(closes).toEqual([false]); // every job ended in the cancel window: nothing forced
    expect(code).toBe(1);
    expect(ms).toBeLessThan(limits.graceMs + limits.cancelMs);
    expect([env.transfers!.active(), env.contents!.active(), env.transfers!.waiting(), env.contents!.waiting()]).toEqual([0, 0, 0, 0]);
    for (const id of ids) expect(env.status(`msg-${id}`)).toBe("PROCESSING"); // not completed; retried later
    void ProviderCancelledError;
  }, 20_000);

  it("C12 + C8. Storage outage (every upload answers 500) with 6 emails carrying large attachments, k = 1: decoded contents alive never exceed m = 2 (instrumented); without the content limit they pile up; each attachment is downloaded once; every permit is released", async () => {
    const runs: Record<string, unknown> = {};
    for (const contents of [2, null] as const) {
      events.length = 0;
      maxInFlight = 0;
      const ids = attachments(`outage-${contents ?? "none"}`, 6, "fast", 1024 * 1024);
      for (const id of ids) uploadFailures.set(id, 99);
      const env = pipeline({ limit: 1, contents, retryDelayMs: 50 });
      let maxTransferring = 0;
      const sampler = setInterval(() => (maxTransferring = Math.max(maxTransferring, env.transfers!.active())), 1);
      const results = await Promise.all(ids.map((id) => settle(env.run(`msg-${id}`, [id]))));
      clearInterval(sampler);
      runs[`m=${contents ?? "none"}`] = {
        maxAlive: env.maxAlive(),
        maxTransferring,
        downloadsPerAttachment: [...new Set(env.downloadsPerAttachment.values())],
        uploadsPerAttachment: [...new Set(ids.map((id) => events.filter((event) => event === `up:${id}:500`).length))],
        pending: results.filter((result) => result.error instanceof AttachmentsPendingError).length
      };
      if (contents) expect([env.transfers!.active(), env.contents!.active(), env.transfers!.waiting(), env.contents!.waiting()]).toEqual([0, 0, 0, 0]);
    }
    console.log("F5.6 (C12):", JSON.stringify(runs));
    expect(runs["m=2"]).toEqual({ maxAlive: 2, maxTransferring: 1, downloadsPerAttachment: [1], uploadsPerAttachment: [3], pending: 6 });
    expect((runs["m=none"] as { maxAlive: number }).maxAlive).toBeGreaterThan(2);
  }, 60_000);
});
