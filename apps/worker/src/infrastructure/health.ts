import { createServer, type Server } from "node:http";

/*
 * Minimal health endpoint for hosting platforms. The worker has no public
 * API: this server answers two GET/HEAD paths and nothing else.
 *
 *   GET /livez   200 while the process runs (liveness).
 *   GET /readyz  200 once the worker finished initializing (queues, job
 *                schedulers, BullMQ workers) AND Redis answers PING;
 *                503 otherwise (readiness).
 *
 * It never touches BullMQ itself: initialization is reported by the caller
 * and Redis is probed with a bounded PING.
 */

export interface WorkerHealthState {
  /** Queues, schedulers and BullMQ workers are running. */
  initialized: boolean;
  /** Initialization failed (process is about to exit). */
  failed: boolean;
  /** Shutdown in progress. */
  stopping: boolean;
}

export interface WorkerHealthOptions {
  state: WorkerHealthState;
  /** PING Redis; must resolve true when it answered. */
  pingRedis(): Promise<boolean>;
  redisTimeoutMs?: number;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: { initialized: boolean; redis: boolean };
}

export async function readiness(options: WorkerHealthOptions): Promise<ReadinessReport> {
  const timeoutMs = options.redisTimeoutMs ?? 1000;
  let timer: NodeJS.Timeout | undefined;
  const redis = await Promise.race([
    options.pingRedis().catch(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));

  const initialized = options.state.initialized && !options.state.failed && !options.state.stopping;
  return { status: initialized && redis ? "ready" : "not_ready", checks: { initialized, redis } };
}

export function createHealthServer(options: WorkerHealthOptions): Server {
  return createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(body));
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return send(405, { status: "method_not_allowed" });
    }

    const path = (request.url ?? "/").split("?")[0];
    if (path === "/livez") return send(200, { status: "alive" });
    if (path === "/readyz") {
      void readiness(options).then(
        (report) => send(report.status === "ready" ? 200 : 503, report),
        () => send(503, { status: "not_ready" })
      );
      return;
    }
    return send(404, { status: "not_found" });
  });
}

/** Starts listening; resolves once bound (rejects if the port is unavailable). */
export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
