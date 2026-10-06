import { serializeError } from "@emailbot/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { evaluateSyncHealth, SYNC_HEALTH_CACHE_MS, SYNC_UNAVAILABLE, WATCH_EXPIRY_WARNING_MS, type SyncHealthResult } from "./sync-health.js";

/** Runs the readiness checks (Redis, ...); a failing check is logged, never thrown. */
async function runReadinessChecks(deps: AppDeps, log: FastifyBaseLogger): Promise<Record<string, "ok" | "error">> {
  const checks: Record<string, "ok" | "error"> = {};
  await Promise.all(
    deps.readinessChecks.map(async ({ name, check }) => {
      try {
        await check();
        checks[name] = "ok";
      } catch (error) {
        checks[name] = "error";
        log.warn({ check: name, err: serializeError(error) }, "readiness check failed");
      }
    })
  );
  return checks;
}

export function healthRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    /** Liveness: the process is up. No dependency checks, never cached. */
    app.get("/health", async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        status: "ok",
        service: "emailbot-api",
        timestamp: new Date().toISOString()
      };
    });

    /** Readiness: dependencies (Redis, ...) are reachable. */
    app.get("/health/ready", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const checks = await runReadinessChecks(deps, request.log);
      const ready = Object.values(checks).every((status) => status === "ok");
      return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
    });

    /*
     * Mail synchronization health (see sync-health.ts). Public and without
     * personal data, for an external uptime monitor. /health/* is exempt from
     * rate limiting, so the result (Redis check + 4 count queries) is cached
     * for SYNC_HEALTH_CACHE_MS and concurrent requests share one evaluation.
     */
    let cached: { at: number; result: Promise<SyncHealthResult> } | null = null;
    // Gmail push is on when the push endpoint can authenticate (same condition as POST /webhooks/gmail).
    const gmailPushEnabled = deps.config.gmailPubSubOidc !== null || deps.config.gmailPubSubVerificationToken !== null;

    const evaluate = async (now: number, log: FastifyBaseLogger): Promise<SyncHealthResult> => {
      const checks = await runReadinessChecks(deps, log);
      if (Object.values(checks).some((status) => status !== "ok")) return SYNC_UNAVAILABLE;
      try {
        const counts = await deps.privileged.syncHealthCounts({
          staleBefore: new Date(now - deps.config.syncHealthStaleMinutes * 60_000).toISOString(),
          watchExpiringBefore: gmailPushEnabled ? new Date(now + WATCH_EXPIRY_WARNING_MS).toISOString() : null
        });
        const result = evaluateSyncHealth(counts);
        if (result.statusCode !== 200 || result.body.status !== "ok") log.warn({ syncHealth: result.body, counts }, "mail synchronization is not healthy");
        return result;
      } catch (error) {
        log.warn({ err: serializeError(error) }, "sync health could not be read");
        return SYNC_UNAVAILABLE;
      }
    };

    app.get("/health/sync", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const now = Date.now();
      // `now < cached.at`: a clock moved backwards must not pin an old result.
      if (!cached || now < cached.at || now - cached.at >= SYNC_HEALTH_CACHE_MS) cached = { at: now, result: evaluate(now, request.log) };
      const { statusCode, body } = await cached.result;
      return reply.status(statusCode).send(body);
    });
  };
}
