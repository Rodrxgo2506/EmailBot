import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { fetchWithTimeout, SecretBox, type EmailEventJob } from "@emailbot/shared";
import { UnrecoverableError, type Job } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderContext } from "../credentials/token-manager.js";
import { cancellableFetch, createRequestCancellation, RequestCancelledError } from "../infrastructure/http-cancellation.js";
import { createJobProcessors } from "../infrastructure/job-processors.js";
import { createJobTracker, createShutdown } from "../infrastructure/shutdown.js";
import { handleAccountFailure } from "../pipeline/failures.js";
import { syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { createGmailAdapter } from "../providers/gmail/adapter.js";
import { providerGet, ProviderHttpError } from "../providers/http.js";
import { createMicrosoftAdapter } from "../providers/microsoft/adapter.js";
import { ProviderCancelledError, ProviderTransientError, type ProviderAdapter, type WorkerAccount } from "../providers/types.js";
import { refusedPort } from "./fake-resp-server.js";
import { makeAccount, makeAccountStore, makeAudit, makeProducer, makeRealtime, makeRegistry, MemoryEmailStore, silentLogger } from "./fakes.js";

/*
 * F5.4: limits and shutdown cancellation of the worker's provider HTTP requests. A throwaway HTTP server on
 * 127.0.0.1 plays Gmail, Microsoft Graph and the OAuth token endpoints; the requests go through the worker's real
 * chain (undici fetch -> fetchWithTimeout -> cancellableFetch), the provider hosts being rewritten to it.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHILD = fileURLToPath(new URL("./fixtures/http-cancel-child.ts", import.meta.url));
type Seen = { path: string; closedAfterMs: number | null };
const seen: Seen[] = [];
const sockets = new Set<Socket>();
let server: Server;
let base = "";

function behave(request: IncomingMessage, response: ServerResponse) {
  const path = (request.url ?? "").split("?")[0] ?? "";
  const entry: Seen = { path, closedAfterMs: null };
  seen.push(entry);
  const started = Date.now();
  request.socket.once("close", () => (entry.closedAfterMs = Date.now() - started));
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (path.includes("hang")) return; // never answers
  if (path.includes("slow-body")) return void response.writeHead(200, { "content-type": "application/json" }).write("{"); // body never ends
  if (path.endsWith("/500")) return json(500, {});
  if (path.endsWith("/404")) return json(404, {});
  if (path.endsWith("/history")) return json(200, { history: [{ id: "110", messagesAdded: [{ message: { id: "g-1" } }] }], historyId: "120" });
  if (path.endsWith("/delta")) return json(200, { value: [{ id: "m-1" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=t2" });
  return json(200, { ok: true });
}

/** Sends every request to the local server (same path and query), through the real undici fetch. */
function toLocal(hang: { on: boolean }): typeof fetch {
  return (input, init) => {
    const original = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = hang.on ? "/hang" + original.pathname : original.pathname;
    return globalThis.fetch(new URL(path + original.search, base), init);
  };
}

/** The worker's provider fetch (index.ts), with a short limit. */
function chain(timeoutMs: number, options: { hang?: { on: boolean } } = {}) {
  const cancellation = createRequestCancellation();
  const fetchImpl = cancellableFetch(fetchWithTimeout(toLocal(options.hang ?? { on: false }), timeoutMs), cancellation.signal);
  return { cancellation, fetchImpl };
}
const context = (account: WorkerAccount = makeAccount()) => ({ account, getAccessToken: vi.fn(async () => "access-token") });
async function timed<T>(work: () => Promise<T>) {
  const started = Date.now();
  try {
    return { value: await work(), error: null as unknown, ms: Date.now() - started };
  } catch (error) {
    return { value: null, error, ms: Date.now() - started };
  }
}

beforeAll(async () => {
  server = createServer(behave);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
});

describe("F5.4: provider HTTP requests - limits and shutdown cancellation", () => {
  it("1. a normal answer is returned as before (one request, nothing cancelled)", async () => {
    const { fetchImpl } = chain(2_000);
    expect(await providerGet(context(), "https://gmail.googleapis.com/gmail/v1/users/me/ok", fetchImpl)).toEqual({ ok: true });
    expect(seen.map((entry) => entry.path)).toEqual(["/gmail/v1/users/me/ok"]);
  });

  it("2. a server slower than the limit (no answer, or a body that never ends): TIMEOUT (transient, not a cancellation); the socket is really closed", async () => {
    const { fetchImpl } = chain(300);
    const noAnswer = await timed(() => providerGet(context(), "https://graph.microsoft.com/hang/x", fetchImpl));
    const slowBody = await timed(() => providerGet(context(), "https://graph.microsoft.com/slow-body/x", fetchImpl));
    for (const result of [noAnswer, slowBody]) {
      expect(result.error).toBeInstanceOf(ProviderTransientError);
      expect(result.error).not.toBeInstanceOf(ProviderCancelledError);
      expect(String(result.error)).toMatch(/Timed out calling graph\.microsoft\.com/);
      expect(result.ms).toBeGreaterThanOrEqual(280);
      expect(result.ms).toBeLessThan(800);
    }
    await vi.waitFor(() => expect(seen.map((entry) => entry.closedAfterMs !== null)).toEqual([true, true]));
    expect(Math.max(...seen.map((entry) => entry.closedAfterMs!))).toBeLessThan(800);
  });

  it("3. the shutdown signal cancels a request in flight (CANCELLED, transient: the job is retried), the socket is closed, and later requests are refused without reaching the provider", async () => {
    const { cancellation, fetchImpl } = chain(10_000);
    setTimeout(() => cancellation.abort(), 150);
    const inFlight = await timed(() => providerGet(context(), "https://gmail.googleapis.com/hang/messages", fetchImpl));
    expect(inFlight.error).toBeInstanceOf(ProviderCancelledError);
    expect(inFlight.error).toBeInstanceOf(ProviderTransientError);
    expect(String(inFlight.error)).toMatch(/Cancelled by the worker shutdown calling gmail\.googleapis\.com/);
    expect(inFlight.ms).toBeGreaterThanOrEqual(140);
    expect(inFlight.ms).toBeLessThan(600);
    await vi.waitFor(() => expect(seen[0]?.closedAfterMs).not.toBeNull());
    expect(seen[0]!.closedAfterMs!).toBeLessThan(600);
    const after = await timed(() => providerGet(context(), "https://gmail.googleapis.com/gmail/v1/users/me/ok", fetchImpl));
    expect(after.error).toBeInstanceOf(ProviderCancelledError);
    expect(after.ms).toBeLessThan(50);
    expect(seen).toHaveLength(1); // the refused request never reached the server
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
  });

  it("4. errors keep their classification: 500 transient, 404 HTTP error, refused connection network error - none is a cancellation; a caller's own abort stays an abort", async () => {
    const { fetchImpl } = chain(2_000);
    const status500 = await timed(() => providerGet(context(), "https://graph.microsoft.com/v1.0/500", fetchImpl));
    const status404 = await timed(() => providerGet(context(), "https://graph.microsoft.com/v1.0/404", fetchImpl));
    expect(status500.error).toBeInstanceOf(ProviderTransientError);
    expect(status500.error).toMatchObject({ status: 500 });
    expect(status404.error).toBeInstanceOf(ProviderHttpError);
    const refused = cancellableFetch(fetchWithTimeout(globalThis.fetch, 2_000), createRequestCancellation().signal);
    const port = await refusedPort();
    const network = await timed(() => providerGet(context(), `http://127.0.0.1:${port}/x`, refused));
    expect(network.error).toBeInstanceOf(ProviderTransientError);
    expect(String(network.error)).toMatch(/Network error/);
    for (const result of [status500, status404, network]) expect(result.error).not.toBeInstanceOf(ProviderCancelledError);
    const own = new AbortController();
    setTimeout(() => own.abort(), 50);
    const callerAbort = await fetchImpl(`${base}/hang/own`, { signal: own.signal }).catch((error: unknown) => error);
    expect(callerAbort).not.toBeInstanceOf(RequestCancelledError);
    expect((callerAbort as Error).name).toBe("AbortError");
  });

  it("5. the job's failure handling: a cancellation is rethrown as is (retried by BullMQ), logged as a shutdown event, never an account error; a timeout keeps the generic path", async () => {
    const account = makeAccount();
    const accounts = makeAccountStore([account]);
    const logs: Array<{ level: string; event: unknown }> = [];
    const logger = { ...silentLogger, info: (fields: Record<string, unknown>) => void logs.push({ level: "info", event: fields.event }), error: (fields: Record<string, unknown>) => void logs.push({ level: "error", event: fields.event ?? "job failed" }) };
    const cancelled = new ProviderCancelledError("Cancelled by the worker shutdown calling gmail.googleapis.com");
    await expect(handleAccountFailure(cancelled, account, { accounts, realtime: makeRealtime(), logger })).rejects.toBe(cancelled);
    const refresh = new RequestCancelledError("oauth2.googleapis.com");
    await expect(handleAccountFailure(refresh, account, { accounts, realtime: makeRealtime(), logger })).rejects.toBe(refresh);
    const timeout = new ProviderTransientError("Timed out calling gmail.googleapis.com", null);
    await expect(handleAccountFailure(timeout, account, { accounts, realtime: makeRealtime(), logger })).rejects.toBe(timeout);
    expect(logs).toEqual([
      { level: "info", event: "worker.shutdown.request_cancelled" },
      { level: "info", event: "worker.shutdown.request_cancelled" },
      { level: "error", event: "job failed" }
    ]);
    expect(accounts.markError).not.toHaveBeenCalled();
  });

  it("5b. a token refresh cancelled by the shutdown: the job fails as transient, nothing is saved, the account is not marked", async () => {
    const box = new SecretBox(randomBytes(32));
    const account = makeAccount({ accessTokenEncrypted: box.encrypt("old"), refreshTokenEncrypted: box.encrypt("refresh"), tokenExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    const accounts = makeAccountStore([account]);
    const { cancellation, fetchImpl } = chain(10_000, { hang: { on: true } });
    const providerContext = createProviderContext(account, { secretBox: box, accounts, oauth: { GMAIL: { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" }, MICROSOFT: null }, fetch: fetchImpl });
    setTimeout(() => cancellation.abort(), 150);
    const result = await timed(() => providerGet(providerContext, "https://gmail.googleapis.com/gmail/v1/users/me/ok", fetchImpl));
    expect(result.error).toBeInstanceOf(RequestCancelledError);
    expect(result.ms).toBeLessThan(600);
    expect(seen.map((entry) => entry.path)).toEqual(["/hang/token"]); // only the token endpoint was called
    expect(accounts.saveTokens).not.toHaveBeenCalled();
    await expect(handleAccountFailure(result.error, account, { accounts, realtime: makeRealtime(), logger: silentLogger })).rejects.toBe(result.error);
    expect(accounts.markError).not.toHaveBeenCalled();
  });

  it("6. Gmail / Microsoft through the real chain: normal listing works; a cancelled sync fails as transient, the cursor does not move, the lock is released, and the job runner rethrows it for a BullMQ retry (not unrecoverable)", async () => {
    const hang = { on: false };
    const { cancellation, fetchImpl } = chain(10_000, { hang });
    const gmail = createGmailAdapter(fetchImpl);
    const microsoft = createMicrosoftAdapter(fetchImpl);
    expect(await gmail.listNewMessageIds(context(makeAccount({ syncCursor: "100" })))).toMatchObject({ messageIds: ["g-1"], nextCursor: "120" });
    expect(await microsoft.listNewMessageIds(context(makeAccount({ provider: "MICROSOFT", syncCursor: null })))).toMatchObject({ messageIds: ["m-1"] });

    hang.on = true;
    const account = makeAccount({ syncCursor: "100" });
    const accounts = makeAccountStore([account]);
    const held = new Map<string, string>();
    const lock = { acquire: vi.fn(async (id: string) => (held.has(id) ? null : (held.set(id, "t"), "t"))), release: vi.fn(async (id: string) => void held.delete(id)) };
    const eventDeps: Omit<HandleEventDeps, "logger"> = {
      accounts, emails: new MemoryEmailStore(), producer: makeProducer(), providers: makeRegistry(gmail as ProviderAdapter),
      createContext: (worker) => ({ account: worker, getAccessToken: async () => "access-token" }),
      enqueueSync: vi.fn(async () => undefined), processMessage: vi.fn(), lock, audit: makeAudit()
    };
    setTimeout(() => cancellation.abort(), 150);
    const sync = await timed(() => syncAccount(account, { ...eventDeps, logger: silentLogger }, "POLL"));
    expect(sync.error).toBeInstanceOf(ProviderCancelledError);
    expect(accounts.advanceSyncCursor).not.toHaveBeenCalled();
    expect(held.size).toBe(0);

    const processors = createJobProcessors({ eventDeps, processDeps: {} as never, accounts, realtime: makeRealtime(), logger: { ...silentLogger, child: () => silentLogger } as never, reportJobFailure: vi.fn(), jobType: () => "SYNC_ACCOUNT" });
    const job = { id: "j1", name: "SYNC_ACCOUNT", queueName: "email-events", attemptsMade: 0, opts: { attempts: 5 }, data: { type: "SYNC_ACCOUNT", emailAccountId: account.id, organizationId: account.organizationId, requestedBy: null, reason: "POLL" } } as unknown as Job<EmailEventJob>;
    const run = await processors.events(job).catch((error: unknown) => error);
    expect(run).toBeInstanceOf(ProviderCancelledError); // refused at once (already cancelled), not UnrecoverableError
    expect(run).not.toBeInstanceOf(UnrecoverableError);
    expect(accounts.markError).not.toHaveBeenCalled();
  });

  it("7. F5.1: a job hung on a provider request is cancelled in the shutdown's cancel phase, ends within the cancel window (close not forced), and is retried", async () => {
    const { cancellation, fetchImpl } = chain(20_000);
    const tracker = createJobTracker();
    const steps: string[] = [];
    const exits: number[] = [];
    const closes: boolean[] = [];
    const shutdown = createShutdown(
      {
        logger: { ...silentLogger, info: (fields: Record<string, unknown>) => void steps.push(String(fields.phase ?? "")) },
        workers: [{ name: "events", pause: async () => undefined, close: async (force?: boolean) => void closes.push(force === true) }],
        tracker,
        markStopping: () => undefined,
        abortImap: () => undefined,
        interruptBlockedClients: () => cancellation.abort(),
        release: [],
        disconnect: () => undefined,
        flush: async () => undefined,
        exit: (code) => exits.push(code)
      },
      { totalMs: 5_000, graceMs: 300, cancelMs: 1_000, closeMs: 300, releaseMs: 300, flushMs: 100 }
    );
    const job = tracker.wrap(() => providerGet(context(), "https://graph.microsoft.com/hang/v1.0/me/messages", fetchImpl))().catch((error: unknown) => error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const started = Date.now();
    shutdown.onSignal("SIGTERM");
    expect(await shutdown.running).toBe(1); // something had to be interrupted
    const ms = Date.now() - started;
    expect(await job).toBeInstanceOf(ProviderCancelledError);
    expect(steps).toEqual(["stop", "grace", "cancel", "close", "release", "exit"]);
    expect(closes).toEqual([false]); // the job ended in the cancel window: nothing forced
    expect(ms).toBeLessThan(300 + 400);
    await vi.waitFor(() => expect(seen[0]?.closedAfterMs).not.toBeNull());
  });

  it("8. no socket, listener or timer of a cancelled request keeps a process alive (real child process, 30 s limit, cancelled after 200 ms, no process.exit)", async () => {
    const proc = fork(CHILD, [], { execArgv: ["--import", "tsx"], env: { ...process.env, F54_HANG_URL: `${base}/hang/child` }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let report: { error: string | null; ms: number; resources: string[]; at: number } | null = null;
    proc.on("message", (message: { error: string | null; ms: number; resources: string[] }) => (report = { ...message, at: Date.now() }));
    const exited = await Promise.race([new Promise<{ code: number | null; at: number }>((resolve) => proc.on("exit", (code) => resolve({ code, at: Date.now() }))), sleep(15_000).then(() => null)]);
    if (!exited) proc.kill();
    const run = { report, exitCode: exited?.code ?? "still running", endedAfterReportMs: exited && report ? exited.at - (report as { at: number }).at : null };
    console.log("F5.4 (8):", JSON.stringify(run));
    expect(run.report).toMatchObject({ error: "RequestCancelledError" });
    expect(run.exitCode).toBe(0);
    expect(run.endedAfterReportMs!).toBeLessThan(2_000);
    await vi.waitFor(() => expect(seen.find((entry) => entry.path === "/hang/child")?.closedAfterMs).not.toBeNull());
  }, 30_000);
});
