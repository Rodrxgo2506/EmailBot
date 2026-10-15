import { Redis, type RedisOptions } from "ioredis";

/*
 * F5.2: bounded Redis clients for the APPLICATION's own commands (sync lock, health PING, realtime publisher).
 * BullMQ's connection (workers and queues) is NOT one of them: it keeps `maxRetriesPerRequest: null` (required by
 * the blocking workers) and its offline queue; queue producers are bounded by withRedisDeadline instead (see
 * queues.ts), because a BullMQ Queue initializes its connection once (INFO) and stays unusable if that fails.
 *
 * ioredis 5.11.1 facts this relies on:
 *   - commandTimeout rejects the command's promise ("Command timed out"), also while it waits in the offline queue,
 *     but does NOT remove it: an offline command is still sent when the connection comes back, and a written but
 *     unanswered one is re-sent after a reconnection (autoResendUnfulfilledCommands). Both are turned off here:
 *     enableOfflineQueue false (a command is rejected at once while the client is not ready: never sent later)
 *     and autoResendUnfulfilledCommands false (never re-sent);
 *   - maxRetriesPerRequest 0: commands pending when a connection drops are rejected at once (no reconnect wait).
 *     The client itself keeps reconnecting (default retryStrategy, at most 2 s apart).
 * A command already written may still be executed by Redis after its timeout (a slow or paused server): its
 * result is UNKNOWN, never a success. Callers treat it as a failure (the job is retried) and only retry
 * operations that are idempotent (see docs/render.md, "Redis de aplicación").
 */

export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 5_000;
export const MIN_REDIS_COMMAND_TIMEOUT_MS = 500;
export const MAX_REDIS_COMMAND_TIMEOUT_MS = 30_000;

export function appRedisOptions(commandTimeoutMs: number): RedisOptions {
  return { commandTimeout: commandTimeoutMs, enableOfflineQueue: false, autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0 };
}

/** not_sent: never reached Redis; rejected: Redis answered with an error; unknown: may have been executed. */
export type RedisOutcome = "not_sent" | "rejected" | "unknown";

export class AppRedisError extends Error {
  constructor(
    readonly operation: string,
    readonly outcome: RedisOutcome,
    cause: unknown
  ) {
    super(`Redis ${operation} failed (result ${outcome})`, { cause });
    this.name = "AppRedisError";
  }
}

export function redisOutcome(error: unknown): RedisOutcome {
  if (error instanceof AppRedisError) return error.outcome;
  if (error instanceof Error && error.name === "ReplyError") return "rejected";
  if (error instanceof Error && error.message.startsWith("Stream isn't writeable")) return "not_sent";
  return "unknown";
}

export interface AppRedis {
  readonly client: Redis;
  /**
   * Runs one application command: waits for the connection (at most the command timeout; not sent otherwise),
   * then the command itself is bounded by commandTimeout. Every failure is an AppRedisError with its outcome.
   */
  run<T>(operation: string, command: (redis: Redis) => Promise<T>): Promise<T>;
}

export function createAppRedis(url: string, commandTimeoutMs: number): AppRedis {
  const client = new Redis(url, appRedisOptions(commandTimeoutMs));
  const whenReady = readiness(client);
  return {
    client,
    async run(operation, command) {
      try {
        await whenReady(commandTimeoutMs);
      } catch (error) {
        throw new AppRedisError(operation, "not_sent", error);
      }
      try {
        return await command(client);
      } catch (error) {
        throw new AppRedisError(operation, redisOutcome(error), error);
      }
    }
  };
}

/**
 * Waits until the client is ready, at most `timeoutMs` per call. Every caller shares ONE pair of ready / end
 * listeners (the worker runs up to 20 jobs at once: one pair per caller would exceed Node's listener limit).
 */
function readiness(client: Redis): (timeoutMs: number) => Promise<void> {
  let shared: Promise<void> | null = null;
  const event = () => {
    if (shared) return shared;
    const wait = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.off("end", onEnd);
        shared = null;
        resolve();
      };
      const onEnd = () => {
        client.off("ready", onReady);
        shared = null;
        reject(new Error("Connection is closed."));
      };
      client.once("ready", onReady);
      client.once("end", onEnd);
    });
    wait.catch(() => undefined); // an "end" after every caller already gave up is not an unhandled rejection
    shared = wait;
    return wait;
  };
  return async (timeoutMs) => {
    if (client.status === "ready") return;
    if (client.status === "end") throw new Error("Connection is closed.");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        event(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Redis not ready within ${timeoutMs} ms`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Bounds an operation on a client that cannot carry a command timeout (BullMQ's): after `ms` the caller gets an
 * AppRedisError "unknown" and stops waiting; the commands themselves stay queued and may still run later, so the
 * operation must be idempotent. Other failures are passed through unchanged.
 */
export async function withRedisDeadline<T>(operation: string, ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppRedisError(operation, "unknown", new Error(`no answer within ${ms} ms`))), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
