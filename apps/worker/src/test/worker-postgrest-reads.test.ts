import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fetchWithTimeout } from "@emailbot/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountStore, createAttachmentStorage, createEmailStore } from "../infrastructure/supabase-stores.js";
import { createWorkerSupabase } from "../infrastructure/supabase-client.js";

/*
 * F5.3: PostgREST reads of the worker's Supabase client are not retried by the client. A scripted HTTP server on
 * 127.0.0.1 (no real Supabase) answers by path; the real supabase-js / postgrest-js / storage-js stack and the
 * worker's real fetchWithTimeout run against it. The control client is built as before F5.3 (retry left on).
 * The real PostgREST / PostgreSQL check is worker-postgrest-reads-supabase.test.ts (opt-in).
 */

const TIMEOUT_MS = 300;
const KEY = "service-role-test-key";
type Seen = { method: string; path: string; retry: string | null };
const seen: Seen[] = [];
const sockets = new Set<Socket>();
let server: Server;
let url = "";

function behave(request: IncomingMessage, response: ServerResponse) {
  const full = request.url ?? "";
  const path = full.split("?")[0] ?? "";
  seen.push({ method: request.method ?? "", path, retry: (request.headers["x-retry-count"] as string | undefined) ?? null });
  // The behaviour is chosen by a word anywhere in the URL (table, path or a filter value).
  if (full.includes("hang")) return; // never answers
  if (full.includes("reset")) return void request.socket.destroy();
  if (full.includes("unavailable")) {
    response.writeHead(503, { "content-type": "application/json" });
    return void response.end(JSON.stringify({ message: "schema cache not loaded" }));
  }
  if (request.method === "HEAD") return void response.writeHead(200).end();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(path.startsWith("/rest/v1/rpc/") ? "1" : "[]");
}

/** The client as it was before F5.3 (postgrest-js retries left on). */
function controlClient(): SupabaseClient {
  return createClient(url, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchWithTimeout(globalThis.fetch, TIMEOUT_MS) }
  });
}
const workerClient = () => createWorkerSupabase(url, KEY, TIMEOUT_MS);
const requests = (fragment: string) => seen.filter((entry) => entry.path.includes(fragment));
async function timed<T>(work: () => PromiseLike<T>) {
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
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
});

describe("F5.3: PostgREST reads are not retried by the worker's client", () => {
  it("1. a read that never answers: ONE request, fails at the HTTP timeout (before F5.3: 4 requests, X-Retry-Count 1-3, about 4 x timeout + 7 s)", async () => {
    const worker = await timed(() => workerClient().from("hang").select("id"));
    expect(worker.value?.error).toBeTruthy(); // postgrest-js returns the failure as { error }
    expect(worker.ms).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(worker.ms).toBeLessThan(TIMEOUT_MS + 500);
    expect(requests("hang")).toEqual([{ method: "GET", path: "/rest/v1/hang", retry: null }]);

    seen.length = 0;
    const control = await timed(() => controlClient().from("hang").select("id"));
    expect(control.value?.error).toBeTruthy();
    expect(requests("hang").map((entry) => entry.retry)).toEqual([null, "1", "2", "3"]);
    expect(control.ms).toBeGreaterThanOrEqual(4 * TIMEOUT_MS + 7_000 - 100);
    console.log("F5.3 (1):", JSON.stringify({ workerMs: worker.ms, workerRequests: 1, controlMs: control.ms, controlRequests: 4 }));
  }, 20_000);

  it("2. 503 (schema cache) and a dropped connection: ONE request each; the store turns it into an error, so the job fails and BullMQ retries it", async () => {
    const accounts = createAccountStore(workerClient());
    const unavailable = await timed(() => accounts.getAccount("unavailable"));
    const emails = createEmailStore(workerClient());
    const settings = await timed(() => emails.loadSettings("unavailable"));
    const reset = await timed(() => workerClient().from("reset").select("id"));
    expect(unavailable.error).toBeInstanceOf(Error);
    expect(String(unavailable.error)).toMatch(/getAccount failed/);
    expect(String(settings.error)).toMatch(/failed/);
    expect(reset.value?.error).toBeTruthy();
    const lines = seen.map(({ method, path, retry }) => `${method} ${path} ${retry ?? "-"}`);
    expect(lines[0]).toBe("GET /rest/v1/email_accounts -");
    expect(lines.at(-1)).toBe("GET /rest/v1/reset -");
    expect(seen.every((entry) => entry.retry === null)).toBe(true);
    expect(lines.filter((line) => line.startsWith("GET /rest/v1/email_accounts")).length).toBe(1);
  }, 20_000);

  it("3. a successful read is unchanged (one request, data returned)", async () => {
    const result = await workerClient().from("email_accounts").select("id");
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(requests("email_accounts")).toHaveLength(1);
  });

  it("4. writes and RPCs are unchanged: one request each, as before F5.3 (postgrest-js never retried them)", async () => {
    for (const client of [workerClient(), controlClient()]) {
      await client.from("unavailable").update({ status: "x" }).eq("id", "1");
      await client.from("unavailable").insert({ id: "1" });
      await client.from("unavailable").delete().eq("id", "1");
      await client.rpc("unavailable");
      await client.from("hang").update({ status: "x" }).eq("id", "1");
    }
    const methods = seen.map(({ method, retry }) => `${method}${retry ? `#${retry}` : ""}`);
    expect(methods).toEqual(["PATCH", "POST", "DELETE", "POST", "PATCH", "PATCH", "POST", "DELETE", "POST", "PATCH"]);
  }, 20_000);

  it("5. other schemas inherit the policy (schema('portal') client)", async () => {
    await workerClient().schema("portal").from("unavailable").select("id");
    expect(requests("unavailable")).toHaveLength(1);
  });

  it("6. Storage is not affected: same requests with the worker's client as with the client before F5.3", async () => {
    const count = async (client: SupabaseClient) => {
      seen.length = 0;
      const storage = createAttachmentStorage(client);
      await storage.exists("bucket", "unavailable/file").catch(() => undefined);
      await storage.upload("bucket", "unavailable/file", new Uint8Array([1]), "application/pdf").catch(() => undefined);
      await storage.exists("bucket", "ok/file").catch(() => undefined);
      return seen.map(({ method, path }) => `${method} ${path}`);
    };
    const worker = await count(workerClient());
    const control = await count(controlClient());
    expect(worker).toEqual(control);
    expect(worker.length).toBeGreaterThan(0);
  }, 20_000);
});
