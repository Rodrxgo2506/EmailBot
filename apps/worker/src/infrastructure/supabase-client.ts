import { fetchWithTimeout } from "@emailbot/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/*
 * F5.3: the worker's SERVICE ROLE client (it processes every tenant and scopes all writes with ids read from the
 * database).
 *
 * PostgREST reads are not retried by the client (db.retry false). @supabase/postgrest-js 2.117.2 otherwise retries
 * GET / HEAD up to 3 times (1, 2 and 4 s apart) when the fetch rejects - our per-request timeout included, since
 * it is not an AbortError - or the server answers 503 / 520: a hung read then lasted 4 x the HTTP timeout + 7 s
 * (about 247 s with 60 s) and the same slow statement could run up to 3 times at once in PostgreSQL (the timed-out
 * one keeps running there). Now a read fails after one attempt and the job fails; BullMQ retries the job (its
 * attempts and backoff), which is the one retry layer. Writes (POST / PATCH / DELETE, RPCs included) were never
 * retried by the client: unchanged. Only PostgREST is concerned: Storage and Auth do not use this option.
 */
export function createWorkerSupabase(url: string, serviceRoleKey: string, httpTimeoutMs: number, fetchImpl: typeof fetch = globalThis.fetch): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { retry: false },
    global: { fetch: fetchWithTimeout(fetchImpl, httpTimeoutMs) }
  });
}
