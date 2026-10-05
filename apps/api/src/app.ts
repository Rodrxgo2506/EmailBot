import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { LOG_REDACT_PATHS, sanitizeUrl, serializeError } from "@emailbot/shared";
import Fastify, { type FastifyRequest, type FastifyServerOptions } from "fastify";
import type { AppDeps } from "./deps.js";
import { createLoginThrottle } from "./infrastructure/login-throttle.js";
import { createResilientRateLimitStore } from "./infrastructure/rate-limit-store.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { registerAuditRecorder } from "./modules/audit/recorder.js";
import { botRoutes } from "./modules/bots/routes.js";
import { customerAccessRoutes } from "./modules/customer-access/routes.js";
import { customerRoutes } from "./modules/customers/routes.js";
import { deliveryRoutes } from "./modules/deliveries/routes.js";
import { categoryRoutes } from "./modules/categories/routes.js";
import { emailAccountRoutes } from "./modules/email-accounts/routes.js";
import { emailRoutes } from "./modules/emails/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { meRoutes } from "./modules/me/routes.js";
import { memberRoutes } from "./modules/members/routes.js";
import { organizationRoutes } from "./modules/organizations/routes.js";
import { portalDataRoutes } from "./modules/portal/data-routes.js";
import { portalRoutes } from "./modules/portal/routes.js";
import { portalSyncRoutes, type SyncLimiter } from "./modules/portal/sync-routes.js";
import { registerPortalSession } from "./modules/portal/session.js";
import { ruleRoutes } from "./modules/rules/routes.js";
import { webhookRoutes } from "./modules/webhooks/routes.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { ORGANIZATION_HEADER, registerOrganizationContext } from "./plugins/organization.js";
import { registerPlatformAdmin } from "./plugins/platform-admin.js";

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

  const corsOptions = {
    // Development: reflect the origin. Production: explicit allow-list only (env validation).
    origin: deps.config.corsOrigins,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", ORGANIZATION_HEADER, "x-request-id"],
    exposedHeaders: ["x-request-id"],
    maxAge: 600
  };
  await app.register(cors, {
    // The panel API uses bearer tokens, never cookies. Only the customer portal
    // (/api/portal/*) sends its httpOnly session cookie, so only it allows credentials.
    delegator: async (request: FastifyRequest) => ({ ...corsOptions, credentials: request.url.startsWith("/api/portal/") })
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
  registerPlatformAdmin(app, deps);
  registerAuditRecorder(app, deps);
  registerPortalSession(app, deps);

  // Per-customer manual sync limit on the existing resilient rate-limit store (Redis, local fallback).
  const PortalSyncStore = createResilientRateLimitStore(deps.rateLimitRedis, {
    prefix: "emailbot-portal-sync:",
    onFallback(error) {
      app.log.warn({ err: serializeError(error) }, "portal sync limiter using per-instance counters");
    }
  });
  const portalSyncStore = new PortalSyncStore();
  const portalSyncLimiter: SyncLimiter = {
    hit: (key, windowMs) =>
      new Promise((resolve, reject) =>
        portalSyncStore.incr(key, (error, result) => (error || !result ? reject(error ?? new Error("rate limit store")) : resolve(result)), windowMs)
      )
  };

  let lastLockoutFallbackLog = 0;
  const portalLoginThrottle = createLoginThrottle(deps.rateLimitRedis, {
    onFallback(error) {
      const now = Date.now();
      if (now - lastLockoutFallbackLog < 60_000) return;
      lastLockoutFallbackLog = now;
      app.log.warn({ err: serializeError(error) }, "login lockout store unavailable; using per-instance counters");
    }
  });

  await app.register(healthRoutes(deps));
  await app.register(webhookRoutes(deps));

  await app.register(
    async (api) => {
      await api.register(meRoutes(deps));
      await api.register(organizationRoutes);
      await api.register(memberRoutes(deps));
      await api.register(emailAccountRoutes(deps));
      await api.register(categoryRoutes);
      await api.register(botRoutes);
      await api.register(customerRoutes);
      await api.register(customerAccessRoutes(deps));
      await api.register(portalRoutes(deps, portalLoginThrottle));
      await api.register(portalDataRoutes(deps));
      await api.register(portalSyncRoutes(deps, portalSyncLimiter));
      await api.register(deliveryRoutes);
      await api.register(ruleRoutes);
      await api.register(emailRoutes(deps));
      await api.register(auditRoutes);
      await api.register(adminRoutes(deps));
    },
    { prefix: "/api" }
  );

  return app;
}
