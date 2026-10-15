import { AsyncLocalStorage } from "node:async_hooks";
import { ProviderTransientError } from "../types.js";

/*
 * IMAP A2: total deadlines of the worker's IMAP network operations.
 *
 * ImapFlow only has inactivity limits (IMAP_TIMEOUTS: 15 s connection, 10 s greeting, 60 s socket
 * inactivity): a server that trickles a byte every few seconds never trips them, so one operation could
 * hold a BullMQ slot (and a pooled connection) forever. Here every operation of the adapter
 * (withInbox: connection + EXAMINE + commands) runs under an OperationGuard:
 *
 *   - every ImapFlow client the operation opens (createImapConnector -> openImapClient, through
 *     `onClient`, i.e. also mid-connect) or reuses from the pool is tracked by the guard;
 *   - when the deadline expires the guard CLOSES those clients (socket destroyed: ImapFlow stops, its
 *     pending command fails) and the operation rejects with ImapDeadlineError, a ProviderTransientError:
 *     never an account ERROR, retried with the existing backoff, nothing half-processed is stored;
 *   - the guard is found through AsyncLocalStorage, so no signature of the shared transport changes.
 *
 * A synchronization run of an IMAP mailbox also has a budget (withImapRunBudget, set by syncAccount): after
 * the soft limit no new message is started; at the hard limit every IMAP operation still running is closed
 * (its deadline is the earlier of its own and the hard limit). Both stay well below the 15-minute sync lock.
 *
 * abortImapOperations() (worker shutdown) expires every running operation and refuses new ones, so
 * worker.close() never waits for a slow IMAP server.
 */

export const IMAP_OPERATION_DEADLINES = Object.freeze({
  /** A NEW connection: DNS (5 s) + TCP (15 s) + greeting (10 s) + STARTTLS + LOGIN, as one total. */
  connectMs: 45_000,
  /** One listing: EXAMINE + UID SEARCH + INTERNALDATE fetches (responses bounded by A1's sync profile). */
  listMs: 120_000,
  /** One message: EXAMINE + metadata + its source (<= 10 MiB; A1 caps one response at 14 MiB) or bounded parts. */
  fetchMs: 180_000,
  /** LOGOUT of a connection the pool disposes; the socket is closed anyway afterwards. */
  logoutMs: 5_000
});

/**
 * Budget of one IMAP synchronization run (SYNC_LOCK_TTL_MS is 15 minutes, never renewed). Soft: no message
 * is started after it. Hard: every IMAP operation of the run is closed at it. The 4 minutes left before the
 * lock can expire cover the database work of the messages already fetched and the lock release.
 */
export const IMAP_RUN_BUDGET = Object.freeze({ softMs: 8 * 60_000, hardMs: 11 * 60_000 });

export type ImapOperationKind = "connect" | "list" | "fetch";

/** Total deadline of an IMAP operation reached (or the run budget, or worker shutdown): transient, retried. */
export class ImapDeadlineError extends ProviderTransientError {
  readonly code = "IMAP_TIMEOUT";
  constructor(
    readonly kind: ImapOperationKind,
    readonly reason: "deadline" | "run_budget" | "shutdown"
  ) {
    super(`The IMAP ${kind} operation was stopped (${reason.replace("_", " ")})`, null);
    this.name = "ImapDeadlineError";
  }
}

interface Closeable {
  close(): void;
}

function closeQuietly(client: Closeable): void {
  try {
    client.close();
  } catch {
    // already closed
  }
}

class OperationGuard {
  expired: ImapDeadlineError | null = null;
  constructor(readonly kind: ImapOperationKind) {}
  readonly #clients = new Set<Closeable>();

  track(client: Closeable): void {
    if (this.expired) closeQuietly(client);
    else this.#clients.add(client);
  }

  expire(error: ImapDeadlineError): void {
    if (this.expired) return;
    this.expired = error;
    for (const client of this.#clients) closeQuietly(client);
    this.#clients.clear();
  }
}

interface RunBudget {
  softDeadlineAt: number;
  hardDeadlineAt: number;
}

const operations = new AsyncLocalStorage<OperationGuard>();
const runBudgets = new AsyncLocalStorage<RunBudget>();
const running = new Set<OperationGuard>();
let aborted = false;

/**
 * Runs `fn` (one IMAP operation) with a total deadline: `ms`, or less if the run budget's hard limit comes
 * first. On expiry every tracked client is closed and the returned promise rejects with ImapDeadlineError;
 * the operation's own late rejection (closed connection) is consumed, never left unhandled.
 */
export async function runImapOperation<T>(kind: ImapOperationKind, ms: number, fn: () => Promise<T>): Promise<T> {
  if (aborted) throw new ImapDeadlineError(kind, "shutdown");
  const now = Date.now();
  const hard = runBudgets.getStore()?.hardDeadlineAt ?? Number.POSITIVE_INFINITY;
  if (hard <= now) throw new ImapDeadlineError(kind, "run_budget");
  const byBudget = hard < now + ms;
  const guard = new OperationGuard(kind);
  running.add(guard);
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        const error = new ImapDeadlineError(kind, byBudget ? "run_budget" : "deadline");
        guard.expire(error);
        reject(error);
      },
      Math.max(0, Math.min(ms, hard - now))
    );
  });
  const work = operations.run(guard, fn);
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    // A shutdown expiry rejects the work first (closed socket): report it as what it is.
    throw guard.expired ?? error;
  } finally {
    clearTimeout(timer);
    running.delete(guard);
  }
}

/**
 * A phase of the current operation with its own, shorter total limit (a new connection): on expiry the
 * whole operation is stopped (its clients closed) with ImapDeadlineError(kind). Outside an operation `fn`
 * simply runs.
 */
export async function withinImapPhase<T>(kind: ImapOperationKind, ms: number, fn: () => Promise<T>): Promise<T> {
  const guard = operations.getStore();
  if (!guard) return fn();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ImapDeadlineError(kind, "deadline");
      guard.expire(error);
      reject(error);
    }, ms);
  });
  const work = fn();
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    throw guard.expired ?? error;
  } finally {
    clearTimeout(timer);
  }
}

/** Registers a client with the running operation (closed at once if that operation already expired). */
export function trackImapClient(client: Closeable): void {
  operations.getStore()?.track(client);
}

/** Throws the running operation's deadline error once it expired (before starting another command). */
export function assertImapOperationAlive(): void {
  const expired = operations.getStore()?.expired;
  if (expired) throw expired;
}

/** Runs one IMAP synchronization under the run budget (syncAccount). */
export function withImapRunBudget<T>(budget: { softMs: number; hardMs: number }, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  return runBudgets.run({ softDeadlineAt: start + budget.softMs, hardDeadlineAt: start + budget.hardMs }, fn);
}

/** True once the current run must not start another message (soft budget reached, or worker shutdown). */
export function imapRunBudgetExhausted(): boolean {
  if (aborted) return true;
  const budget = runBudgets.getStore();
  return budget !== undefined && Date.now() >= budget.softDeadlineAt;
}

/** Worker shutdown: closes every running IMAP operation and refuses new ones. */
export function abortImapOperations(): void {
  aborted = true;
  for (const guard of running) guard.expire(new ImapDeadlineError(guard.kind, "shutdown"));
}

/** Operations currently running (diagnostics and tests). */
export function runningImapOperations(): number {
  return running.size;
}

/** Tests only: undo abortImapOperations(). */
export function resetImapAbortForTests(): void {
  aborted = false;
}
