import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { LOG_REDACT_PATHS, sanitizeUrl, serializeError } from "@emailbot/shared";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { AppDeps } from "./deps.js";
import { createResilientRateLimitStore } from "./infrastructure/rate-limit-store.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { registerAuditRecorder } from "./modules/audit/recorder.js";
import { botRoutes } from "./modules/bots/routes.js";
import { customerRoutes } from "./modules/customers/routes.js";
import { categoryRoutes } from "./modules/categories/routes.js";
import { emailAccountRoutes } from "./modules/email-accounts/routes.js";
import { emailRoutes } from "./modules/emails/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { meRoutes } from "./modules/me/routes.js";
import { memberRoutes } from "./modules/members/routes.js";
import { organizationRoutes } from "./modules/organizations/routes.js";
import { ruleRoutes } from "./modules/rules/routes.js";
import { webhookRoutes } from "./modules/webhooks/routes.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { ORGANIZATION_HEADER, registerOrganizationContext } from "./plugins/organization.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export interface BuildAppOptions {
  /** `false` disables logging (tests). A stream redirects output (log tests). */
  logger?: false | { stream?: { write(line: string): void }; level?: string };
}

function loggerOptions(deps: AppDeps, options: BuildAppOptions): NonNullable<FastifyServerOptions["logger"]> {
  if (options.logger === false) return false;
  return {
    level: options.logger?.level ?? deps.config.logLevel,
    redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
    serializers: {
      // Never log headers, and strip OAuth codes / webhook tokens from URLs.
      req(request) {
        return { method: request.method, url: sanitizeUrl(request.url), remoteAddress: request.ip };
      }
    },
    ...(options.logger?.stream ? { stream: options.logger.stream } : {})
  };
}

export async function buildApp(deps: AppDeps, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: loggerOptions(deps, options),
    bodyLimit: 1024 * 1024,
    trustProxy: deps.config.trustProxy,
    genReqId(request) {
      const header = request.headers["x-request-id"];
      return typeof header === "string" && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    }
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(helmet);

  await app.register(cors, {
    // Development: reflect the origin. Production: explicit allow-list only (env validation).
    origin: deps.config.corsOrigins,
    // The API uses bearer tokens, never cookies.
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", ORGANIZATION_HEADER, "x-request-id"],
    exposedHeaders: ["x-request-id"],
    maxAge: 600
  });

  await app.register(sensible);

  // Per-IP rate limiting. Shared through Redis so limits hold across API
  // instances; if Redis fails, requests are counted per instance instead of
  // going unlimited (see infrastructure/rate-limit-store.ts).
  let lastFallbackLog = 0;
  await app.register(rateLimit, {
    global: true,
    max: deps.config.rateLimitMax,
    timeWindow: "1 minute",
    skipOnError: false,
    store: createResilientRateLimitStore(deps.rateLimitRedis, {
      prefix: "emailbot-rl:",
      onFallback(error) {
        const now = Date.now();
        if (now - lastFallbackLog < 60_000) return;
        lastFallbackLog = now;
        app.log.warn({ err: serializeError(error) }, "rate limit store unavailable; using per-instance limits");
      }
    }),
    allowList: (request) => request.url === "/health" || request.url.startsWith("/health/"),
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      code: "RATE_LIMITED",
      message: `Too many requests. Retry in ${context.after}.`
    })
  });

  registerErrorHandler(app);
  registerAuth(app, deps);
  registerOrganizationContext(app);
  registerAuditRecorder(app, deps);

  await app.register(healthRoutes(deps));
  await app.register(webhookRoutes(deps));

  await app.register(
    async (api) => {
      await api.register(meRoutes);
      await api.register(organizationRoutes);
      await api.register(memberRoutes(deps));
      await api.register(emailAccountRoutes(deps));
      await api.register(categoryRoutes);
      await api.register(botRoutes);
      await api.register(customerRoutes);
      await api.register(ruleRoutes);
      await api.register(emailRoutes(deps));
      await api.register(auditRoutes);
    },
    { prefix: "/api" }
  );

  return app;
}
