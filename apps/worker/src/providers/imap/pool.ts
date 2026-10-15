import { ProviderTransientError } from "../types.js";
import { IMAP_OPERATION_DEADLINES } from "./deadline.js";

/*
 * IMAP connections of one worker process.
 *
 *   - at most `maxPerKey` (2) connections per mailbox key and `maxTotal` (10)
 *     in the process; a caller over the limit waits (bounded by
 *     `acquireTimeoutMs`, then a transient error = BullMQ retry);
 *   - one operation at a time per connection (lease); a connection is reused
 *     only by the same key (mailbox + server + login: changed credentials never
 *     reuse an old session);
 *   - idle connections are logged out after `idleMs` (30 s): nothing stays
 *     open between polling runs;
 *   - a connection whose operation failed is discarded (never reused in an
 *     unknown state); closeAll() at shutdown logs everything out;
 *   - A2: a LOGOUT gets `logoutTimeoutMs` (5 s); after it (or any failure) the
 *     socket is closed anyway, so disposing never waits for a slow server.
 * No IDLE: the worker polls.
 */

export interface PoolableClient {
  /** False once the connection is closed or broken. */
  readonly usable: boolean;
  logout(): Promise<void>;
  close(): void;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface ImapConnectionPoolOptions {
  maxPerKey?: number;
  maxTotal?: number;
  idleMs?: number;
  acquireTimeoutMs?: number;
  logoutTimeoutMs?: number;
}

interface Entry<C extends PoolableClient> {
  key: string;
  client: C;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
  lastUsed: number;
}

interface Waiter {
  wake(): void;
}

export const IMAP_POOL_DEFAULTS = { maxPerKey: 2, maxTotal: 10, idleMs: 30_000, acquireTimeoutMs: 60_000 } as const;

export class ImapConnectionPool<C extends PoolableClient = PoolableClient> {
  readonly #maxPerKey: number;
  readonly #maxTotal: number;
  readonly #idleMs: number;
  readonly #acquireTimeoutMs: number;
  readonly #logoutTimeoutMs: number;
  readonly #entries = new Set<Entry<C>>();
  /** Slots reserved by connections being opened (counted against the limits). */
  readonly #opening = new Map<string, number>();
  readonly #waiters: Waiter[] = [];
  #closed = false;

  constructor(options: ImapConnectionPoolOptions = {}) {
    this.#maxPerKey = options.maxPerKey ?? IMAP_POOL_DEFAULTS.maxPerKey;
    this.#maxTotal = options.maxTotal ?? IMAP_POOL_DEFAULTS.maxTotal;
    this.#idleMs = options.idleMs ?? IMAP_POOL_DEFAULTS.idleMs;
    this.#acquireTimeoutMs = options.acquireTimeoutMs ?? IMAP_POOL_DEFAULTS.acquireTimeoutMs;
    this.#logoutTimeoutMs = options.logoutTimeoutMs ?? IMAP_OPERATION_DEADLINES.logoutMs;
  }

  /** Open connections (busy + idle) and connections being opened. */
  stats(): { open: number; busy: number; opening: number; byKey: Record<string, number> } {
    const byKey: Record<string, number> = {};
    for (const entry of this.#entries) byKey[entry.key] = (byKey[entry.key] ?? 0) + 1;
    let opening = 0;
    for (const [key, count] of this.#opening) {
      byKey[key] = (byKey[key] ?? 0) + count;
      opening += count;
    }
    return { open: this.#entries.size, busy: [...this.#entries].filter((entry) => entry.busy).length, opening, byKey };
  }

  /** Runs `fn` with a connection of `key` (reused or opened with `open`), then returns it to the pool. */
  async use<T>(key: string, open: () => Promise<C>, fn: (client: C) => Promise<T>): Promise<T> {
    const entry = await this.#acquire(key, open);
    let ok = false;
    try {
      const result = await fn(entry.client);
      ok = true;
      return result;
    } finally {
      this.#release(entry, ok);
    }
  }

  /** Logs out every connection and refuses new work (worker shutdown). */
  async closeAll(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.wake();
    const entries = [...this.#entries];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => this.#dispose(entry)));
  }

  #countFor(key: string): number {
    let count = this.#opening.get(key) ?? 0;
    for (const entry of this.#entries) if (entry.key === key) count += 1;
    return count;
  }

  #total(): number {
    let opening = 0;
    for (const count of this.#opening.values()) opening += count;
    return this.#entries.size + opening;
  }

  async #acquire(key: string, open: () => Promise<C>): Promise<Entry<C>> {
    const deadline = Date.now() + this.#acquireTimeoutMs;
    for (;;) {
      if (this.#closed) throw new ProviderTransientError("The IMAP connection pool is closed", null);

      const idle = [...this.#entries].find((entry) => entry.key === key && !entry.busy && entry.client.usable);
      if (idle) {
        this.#clearIdle(idle);
        idle.busy = true;
        return idle;
      }

      if (this.#countFor(key) < this.#maxPerKey) {
        if (this.#total() >= this.#maxTotal) this.#evictOneIdle();
        if (this.#total() < this.#maxTotal) return this.#open(key, open);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ProviderTransientError("Too many IMAP connections in use; retry later", null);
      await this.#wait(remaining);
    }
  }

  async #open(key: string, open: () => Promise<C>): Promise<Entry<C>> {
    this.#opening.set(key, (this.#opening.get(key) ?? 0) + 1);
    try {
      const client = await open();
      const entry: Entry<C> = { key, client, busy: true, idleTimer: null, lastUsed: Date.now() };
      client.on("close", () => this.#forget(entry));
      client.on("error", () => this.#forget(entry));
      if (this.#closed) {
        await this.#dispose(entry);
        throw new ProviderTransientError("The IMAP connection pool is closed", null);
      }
      this.#entries.add(entry);
      return entry;
    } finally {
      const left = (this.#opening.get(key) ?? 1) - 1;
      if (left > 0) this.#opening.set(key, left);
      else this.#opening.delete(key);
      this.#wakeAll();
    }
  }

  #release(entry: Entry<C>, ok: boolean): void {
    entry.busy = false;
    entry.lastUsed = Date.now();
    if (!ok || this.#closed || !entry.client.usable || !this.#entries.has(entry)) {
      this.#entries.delete(entry);
      void this.#dispose(entry);
    } else {
      entry.idleTimer = setTimeout(() => {
        this.#entries.delete(entry);
        void this.#dispose(entry);
      }, this.#idleMs);
      entry.idleTimer.unref?.();
    }
    this.#wakeAll();
  }

  #evictOneIdle(): void {
    const idle = [...this.#entries].filter((entry) => !entry.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) return;
    this.#entries.delete(idle);
    void this.#dispose(idle);
  }

  #forget(entry: Entry<C>): void {
    if (!this.#entries.has(entry)) return;
    if (entry.busy) return; // the running operation fails and #release disposes it
    this.#entries.delete(entry);
    this.#clearIdle(entry);
    this.#wakeAll();
  }

  #clearIdle(entry: Entry<C>): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  async #dispose(entry: Entry<C>): Promise<void> {
    this.#clearIdle(entry);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (entry.client.usable) {
        const logout = entry.client.logout();
        logout.catch(() => undefined);
        await Promise.race([
          logout,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.#logoutTimeoutMs);
          })
        ]);
      }
    } catch {
      // ignored: closed below
    } finally {
      clearTimeout(timer);
      try {
        entry.client.close();
      } catch {
        // already closed
      }
    }
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve();
      }, ms);
      const waiter: Waiter = {
        wake: () => {
          clearTimeout(timer);
          resolve();
        }
      };
      this.#waiters.push(waiter);
    });
  }

  /** Every waiter re-checks the limits (a freed slot may suit any of them). */
  #wakeAll(): void {
    for (const waiter of this.#waiters.splice(0)) waiter.wake();
  }
}
