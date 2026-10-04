import { serializeError } from "@emailbot/shared";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";

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
      const checks: Record<string, "ok" | "error"> = {};

      await Promise.all(
        deps.readinessChecks.map(async ({ name, check }) => {
          try {
            await check();
            checks[name] = "ok";
          } catch (error) {
            checks[name] = "error";
            request.log.warn({ check: name, err: serializeError(error) }, "readiness check failed");
          }
        })
      );

      const ready = Object.values(checks).every((status) => status === "ok");
      return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
    });
  };
}
