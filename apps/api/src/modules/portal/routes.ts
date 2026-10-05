import { isIP } from "node:net";
import { normalizeAccessId, portalLoginSchema } from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../deps.js";
import type { LoginThrottle } from "../../infrastructure/login-throttle.js";
import { AccessIdHasher, generateSessionToken, hashSessionToken } from "../../lib/customer-access.js";
import { AppError } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import type { PortalLoginResult } from "../../repositories/types.js";
import { clearedSessionCookie, getPortal, portalOriginGuard, sessionCookie, sessionTokenOf } from "./session.js";

/*
 * Customer portal identity (EmailBot V2 phase 4). No Supabase Auth: the
 * customer exchanges an Access ID for an opaque server-side session.
 *
 *   POST /api/portal/session  login  (5/min/IP + lockout of 15 min after 10 failures)
 *   GET  /api/portal/me       minimal profile of the session's customer
 *   POST /api/portal/logout   revokes THIS session only
 *
 * Every login failure (unknown, revoked or expired Access ID, suspended
 * customer or organization, malformed input) gets the SAME response; the
 * category is only logged / audited. Neither the Access ID nor any token or
 * hash is ever logged, audited or returned.
 */

export const INVALID_CREDENTIALS_MESSAGE = "Las credenciales no son válidas.";
const invalidCredentials = () => new AppError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);

function clientIp(request: FastifyRequest): string | null {
  return isIP(request.ip) ? request.ip : null;
}

function userAgent(request: FastifyRequest): string | null {
  const value = request.headers["user-agent"];
  return typeof value === "string" && value.length > 0 ? value.slice(0, 512) : null;
}

export function portalRoutes(deps: AppDeps, throttle: LoginThrottle) {
  const hasher = new AccessIdHasher(deps.config.tokenEncryptionKey);
  const originGuard = portalOriginGuard(deps);

  return async (app: FastifyInstance) => {
    /** Organization audit (SYSTEM actor: customers are not users). Never awaited by the response path. */
    const audit = (request: FastifyRequest, organizationId: string, customerId: string, entry: { action: "LOGIN" | "LOGOUT" | "FAIL"; metadata: Record<string, unknown> }) =>
      void app.audit(request, { organizationId, action: entry.action, entityType: "customer", entityId: customerId, metadata: entry.metadata });

    app.post(
      "/portal/session",
      {
        config: { rateLimit: RATE_LIMITS.portalLogin },
        preHandler: [
          originGuard,
          async (request) => {
            if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
              throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
            }
          }
        ]
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const key = request.ip;

        const lockedFor = await throttle.lockedFor(key);
        if (lockedFor > 0) {
          reply.header("retry-after", String(Math.ceil(lockedFor / 1000)));
          throw new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later.");
        }

        const parsed = portalLoginSchema.safeParse(request.body ?? {});
        const secret = parsed.success ? normalizeAccessId(parsed.data.accessId) : null;
        const token = generateSessionToken();
        const result: PortalLoginResult = secret
          ? await deps.privileged.createPortalSession({
              secretHash: hasher.hash(secret),
              tokenHash: hashSessionToken(token),
              ip: clientIp(request),
              userAgent: userAgent(request)
            })
          : { outcome: "INVALID", organizationId: null, customerId: null };

        if (result.outcome !== "OK") {
          const lockedNow = await throttle.recordFailure(key);
          request.log.warn({ event: "portal.login.failed", reason: result.outcome, locked: lockedNow > 0 }, "portal login failed");
          // Unknown Access IDs cannot be attributed to an organization: logs only.
          if (result.organizationId && result.customerId) {
            audit(request, result.organizationId, result.customerId, { action: "FAIL", metadata: { event: "portal.login.failed", reason: result.outcome } });
          }
          throw invalidCredentials();
        }

        await throttle.recordSuccess(key);
        const maxAge = (Date.parse(result.absoluteExpiresAt) - Date.now()) / 1000;
        reply.header("set-cookie", sessionCookie(token, maxAge));
        audit(request, result.organizationId, result.customerId, {
          action: "LOGIN",
          metadata: { event: "portal.login.succeeded", sessionId: result.sessionId }
        });
        request.log.info({ event: "portal.login.succeeded", portalSessionId: result.sessionId }, "portal login");

        return {
          customer: { displayName: result.displayName },
          session: { idleExpiresAt: result.idleExpiresAt, absoluteExpiresAt: result.absoluteExpiresAt }
        };
      }
    );

    app.get("/portal/me", { preHandler: [app.requirePortalSession] }, async (request) => getPortal(request).profile);

    app.post("/portal/logout", { preHandler: [originGuard] }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("set-cookie", clearedSessionCookie());
      const token = sessionTokenOf(request);
      const ended = token ? await deps.privileged.endPortalSession(hashSessionToken(token)) : null;
      if (ended) {
        audit(request, ended.organizationId, ended.customerId, {
          action: "LOGOUT",
          metadata: { event: "customer.session.revoked", reason: "LOGOUT", sessionId: ended.sessionId }
        });
      }
      return reply.status(204).send();
    });
  };
}
