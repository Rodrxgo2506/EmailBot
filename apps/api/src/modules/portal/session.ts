import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../../deps.js";
import { hashSessionToken, isSessionToken } from "../../lib/customer-access.js";
import { AppError, forbidden } from "../../lib/errors.js";
import type { PortalSessionContext } from "../../repositories/types.js";

/*
 * Customer portal session (EmailBot V2 phase 4).
 *
 * The session token lives only in a `__Host-` cookie: httpOnly (never visible
 * to JavaScript), Secure, SameSite=Strict, Path=/, no Domain. The browser
 * never receives the token in a body, and nothing is kept in localStorage /
 * sessionStorage / IndexedDB. The database stores SHA-256(token) only.
 *
 * requirePortalSession is the ONLY source of authority for portal routes:
 * organization, customer and permissions come from the validated session,
 * never from the client (no customerId / organizationId / role input).
 */

export const PORTAL_SESSION_COOKIE = "__Host-emailbot_portal";

const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

declare module "fastify" {
  interface FastifyRequest {
    portal: PortalSessionContext | null;
  }
  interface FastifyInstance {
    requirePortalSession(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/** Value of a cookie in the Cookie header (first occurrence), or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${PORTAL_SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedSessionCookie(): string {
  return `${PORTAL_SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

export function sessionTokenOf(request: FastifyRequest): string | undefined {
  const token = readCookie(request.headers.cookie, PORTAL_SESSION_COOKIE);
  return isSessionToken(token) ? token : undefined;
}

export const invalidSession = () => new AppError(401, "UNAUTHORIZED", "La sesión no es válida.");

/**
 * State-changing portal requests from a browser must come from an allowed
 * origin (defence in depth on top of SameSite=Strict and CORS).
 */
export function portalOriginGuard(deps: AppDeps) {
  return async (request: FastifyRequest) => {
    const origin = request.headers.origin;
    const allowed = deps.config.corsOrigins;
    if (origin === undefined || allowed === true) return;
    if (!allowed.includes(origin)) throw forbidden("Origin not allowed", "FORBIDDEN_ORIGIN");
  };
}

export function registerPortalSession(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest("portal", null);

  app.decorate("requirePortalSession", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    const token = sessionTokenOf(request);
    const context = token ? await deps.privileged.validatePortalSession(hashSessionToken(token)) : null;
    if (!context) {
      if (request.headers.cookie?.includes(PORTAL_SESSION_COOKIE)) reply.header("set-cookie", clearedSessionCookie());
      throw invalidSession();
    }
    request.portal = context;
    request.log = request.log.child({ portalSessionId: context.sessionId, organizationId: context.organizationId });
  });
}

export function getPortal(request: FastifyRequest): PortalSessionContext {
  if (!request.portal) throw invalidSession();
  return request.portal;
}
