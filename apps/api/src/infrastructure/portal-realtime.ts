import { serializeError } from "@emailbot/shared";
import {
  PORTAL_INBOX_CHANGED,
  PORTAL_REALTIME_NAMESPACE,
  PORTAL_REALTIME_REVOKED,
  portalCustomerRoom,
  type RealtimeEvent
} from "@emailbot/types";
import { idSchema } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import type { Namespace, Server } from "socket.io";
import type { AppDeps } from "../deps.js";
import { hashSessionToken, isSessionToken } from "../lib/customer-access.js";
import { PORTAL_SESSION_COOKIE, readCookie } from "../modules/portal/session.js";

/*
 * Customer portal realtime (EmailBot V2 phase 7).
 *
 * A separate Socket.IO namespace (/portal on the same /realtime endpoint)
 * whose only authority is the portal session cookie (httpOnly, never seen by
 * JavaScript; the browser sends it with the WebSocket handshake):
 *   - the handshake Origin must be an allowed origin (CORS_ORIGINS): a
 *     WebSocket is not covered by CORS, so this blocks cross-site WebSocket
 *     hijacking with the customer's cookie;
 *   - the session is validated exactly like a portal request
 *     (portal.validate_session: credential, customer, organization ACTIVE,
 *     idle / absolute expiry) and the socket joins ONLY its own customer's
 *     room - the client never names a room or an id;
 *   - every PORTAL_REVALIDATE_MS the sessions are validated again; a revoked,
 *     expired or suspended session is told (PORTAL_REALTIME_REVOKED) and
 *     disconnected.
 * The server only ever emits a bare PORTAL_INBOX_CHANGED signal (no ids, no
 * content): the portal refetches through its authenticated API.
 */

export const PORTAL_REVALIDATE_MS = 60 * 1000;

export interface PortalSocketData {
  tokenHash?: string;
  sessionId?: string;
  organizationId?: string;
  customerId?: string;
}

export interface PortalRevalidatableSocket {
  data: PortalSocketData;
  disconnect(close?: boolean): unknown;
  emit?(event: string, ...args: unknown[]): unknown;
}

type PortalDeps = Pick<AppDeps, "config" | "privileged">;

export type PortalHandshakeResult =
  | { ok: true; data: Required<PortalSocketData> }
  | { ok: false; error: "forbidden_origin" | "unauthorized" };

/** Origin + session cookie of the WebSocket handshake. */
export async function authenticatePortalHandshake(
  headers: { origin?: string | undefined; cookie?: string | undefined },
  deps: PortalDeps
): Promise<PortalHandshakeResult> {
  const allowed = deps.config.corsOrigins;
  if (allowed !== true && (typeof headers.origin !== "string" || !allowed.includes(headers.origin))) {
    return { ok: false, error: "forbidden_origin" };
  }
  const token = readCookie(headers.cookie, PORTAL_SESSION_COOKIE);
  if (!isSessionToken(token)) return { ok: false, error: "unauthorized" };

  const tokenHash = hashSessionToken(token);
  const context = await deps.privileged.validatePortalSession(tokenHash);
  if (!context) return { ok: false, error: "unauthorized" };
  return { ok: true, data: { tokenHash, sessionId: context.sessionId, organizationId: context.organizationId, customerId: context.customerId } };
}

/** Disconnects portal sockets whose session is no longer valid. Returns how many were dropped. */
export async function revalidatePortalSockets(sockets: Iterable<PortalRevalidatableSocket>, deps: PortalDeps): Promise<number> {
  let dropped = 0;
  for (const socket of sockets) {
    let valid = false;
    try {
      const { tokenHash, sessionId } = socket.data;
      const context = tokenHash ? await deps.privileged.validatePortalSession(tokenHash) : null;
      valid = context !== null && context.sessionId === sessionId;
    } catch {
      // Database unavailable: keep the socket; the next round decides (it carries no data anyway).
      valid = true;
    }
    if (!valid) {
      socket.emit?.(PORTAL_REALTIME_REVOKED);
      socket.disconnect(true);
      dropped += 1;
    }
  }
  return dropped;
}

/** portal.deliveries -> a bare signal to each customer's room (invalid ids are ignored). */
export function relayPortalEvent(namespace: Pick<Namespace, "to">, event: Extract<RealtimeEvent, { type: "portal.deliveries" }>): number {
  if (!idSchema.safeParse(event.organizationId).success || !Array.isArray(event.customerIds)) return 0;
  let relayed = 0;
  for (const customerId of new Set(event.customerIds)) {
    if (!idSchema.safeParse(customerId).success) continue;
    namespace.to(portalCustomerRoom(event.organizationId, customerId)).emit(PORTAL_INBOX_CHANGED);
    relayed += 1;
  }
  return relayed;
}

export function attachPortalNamespace(io: Server, app: FastifyInstance, deps: PortalDeps, options: { revalidateMs?: number | undefined } = {}): Namespace {
  const namespace = io.of(PORTAL_REALTIME_NAMESPACE);

  namespace.use(async (socket, next) => {
    try {
      const result = await authenticatePortalHandshake(
        { origin: socket.handshake.headers.origin, cookie: socket.handshake.headers.cookie },
        deps
      );
      if (!result.ok) {
        app.log.info({ event: "portal.realtime.rejected", reason: result.error }, "portal realtime handshake rejected");
        return next(new Error(result.error));
      }
      Object.assign(socket.data, result.data);
      await socket.join(portalCustomerRoom(result.data.organizationId, result.data.customerId));
      return next();
    } catch (error) {
      app.log.warn({ err: serializeError(error) }, "portal realtime handshake failed");
      return next(new Error("unauthorized"));
    }
  });

  // Clients send nothing on this namespace: any incoming event is ignored.
  const timer = setInterval(() => {
    revalidatePortalSockets(namespace.sockets.values() as Iterable<PortalRevalidatableSocket>, deps)
      .then((dropped) => {
        if (dropped > 0) app.log.info({ dropped }, "portal realtime sockets disconnected after revalidation");
      })
      .catch((error: unknown) => app.log.warn({ err: serializeError(error) }, "portal realtime revalidation failed"));
  }, options.revalidateMs ?? PORTAL_REVALIDATE_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  return namespace;
}
