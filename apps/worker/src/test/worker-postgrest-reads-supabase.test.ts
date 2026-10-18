import { randomUUID } from "node:crypto";
import { fetchWithTimeout } from "@emailbot/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createWorkerSupabase } from "../infrastructure/supabase-client.js";
import { createAccountStore, createEmailStore } from "../infrastructure/supabase-stores.js";

/*
 * F5.3 against a REAL PostgREST / PostgreSQL: a THROWAWAY local Supabase stack only (opt-in). It runs only when
 * F53_SUPABASE_URL is exactly the disposable stack's API (http://127.0.0.1:56321; the development stack uses
 * 54321 and is refused) and F53_SERVICE_ROLE_KEY is that stack's key. The stack also holds two test-only objects,
 * created by the harness outside the repository: the view public.zz_f53_slow (SELECT pg_sleep(3)) and the function
 * public.zz_f53_sleeping() (how many queries on that view PostgreSQL is running now).
 */

const DISPOSABLE_API = "http://127.0.0.1:56321";
const URL_ = process.env.F53_SUPABASE_URL ?? "";
const KEY = process.env.F53_SERVICE_ROLE_KEY ?? "";
const enabled = URL_ !== "" || KEY !== "";
if (enabled && (URL_ !== DISPOSABLE_API || KEY === "")) throw new Error(`refusing to run: F53_SUPABASE_URL must be ${DISPOSABLE_API} (throwaway stack) with its service role key`);
const TIMEOUT_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function controlClient(): SupabaseClient {
  // As before F5.3: postgrest-js retries left on.
  return createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetchWithTimeout(globalThis.fetch, TIMEOUT_MS) } });
}

/** Reads the slow view with `client`; samples how many statements PostgreSQL runs on it meanwhile. */
async function slowRead(client: SupabaseClient) {
  const sampler = createWorkerSupabase(URL_, KEY, 10_000);
  const running = async () => {
    const { data, error } = await sampler.rpc("zz_f53_sleeping");
    if (error) throw new Error(`sampler failed: ${error.message}`);
    return Number(data);
  };
  await vi_waitIdle(running);
  const samples: number[] = [];
  let done = false;
  const sampling = (async () => {
    while (!done) {
      samples.push(await running());
      await sleep(150);
    }
  })();
  const started = Date.now();
  const result = await client.from("zz_f53_slow").select("slept");
  const ms = Date.now() - started;
  await vi_waitIdle(running); // the last statement ends on the server (3 s after it started)
  done = true;
  await sampling;
  return { failed: result.error !== null, ms, maxConcurrent: Math.max(0, ...samples), samples: samples.length };
}

async function vi_waitIdle(running: () => Promise<number>) {
  for (let n = 0; n < 100; n++) {
    if ((await running()) === 0) return;
    await sleep(100);
  }
  throw new Error("statements still running after 10 s");
}

describe.runIf(enabled)("F5.3: worker reads against a real (throwaway) PostgREST", () => {
  it("1. the worker's stores read and write normally (reads, RPCs, a write)", async () => {
    const client = createWorkerSupabase(URL_, KEY, 10_000);
    const accounts = createAccountStore(client);
    const emails = createEmailStore(client);
    const unknown = randomUUID();
    const run = {
      account: await accounts.getAccount(unknown),
      oauth: Array.isArray(await accounts.listActiveOAuthAccounts(5)),
      access: (await accounts.commercialAccess([unknown])).size,
      imap: await accounts.imapEntitled(unknown),
      settings: await emails.loadSettings(unknown),
      email: await emails.findEmail(unknown, "missing"),
      write: await emails.updateProcessingState(unknown, { status: "PROCESSING" }).then(() => "ok")
    };
    console.log("F5.3 (real 1):", JSON.stringify(run));
    expect(run).toEqual({
      account: null,
      oauth: true,
      access: 0,
      imap: false,
      settings: { autoProcessingEnabled: true, processAttachments: true, notificationsEnabled: true },
      email: null,
      write: "ok"
    });
  }, 60_000);

  it("2. a slow read (3 s statement, 1 s client timeout): the worker sends it ONCE and fails at the timeout; before F5.3 the same read ran several statements at once (retries while the first one still runs) and took about 4 x 1 s + 7 s", async () => {
    const worker = await slowRead(createWorkerSupabase(URL_, KEY, TIMEOUT_MS));
    const control = await slowRead(controlClient());
    console.log("F5.3 (real 2):", JSON.stringify({ worker, control }));
    expect(worker.failed).toBe(true);
    expect(worker.ms).toBeLessThan(TIMEOUT_MS + 500);
    expect(worker.maxConcurrent).toBe(1);
    expect(control.failed).toBe(true);
    expect(control.ms).toBeGreaterThan(4 * TIMEOUT_MS + 7_000 - 200);
    expect(control.maxConcurrent).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe.runIf(!enabled)("F5.3 real PostgREST (skipped)", () => {
  it.skip("runs only with F53_SUPABASE_URL / F53_SERVICE_ROLE_KEY of the throwaway stack (see the header)", () => undefined);
});
