import { serializeError } from "@emailbot/shared";
import {
  organizationRoom,
  REALTIME_AUTH_REFRESH,
  REALTIME_REDIS_CHANNEL,
  REALTIME_REVOKED,
  type RealtimeAuthRefreshAck,
  type RealtimeEvent,
  type RealtimeRevokedReason
} from "@emailbot/types";
import { idSchema } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import type { AppDeps } from "../deps.js";

/*
 * Real-time delivery: worker --(Redis pub/sub)--> API --(Socket.IO room per
 * organization)--> browsers.
 *
 * A socket is admitted to a room only after its access token is validated
 * with Supabase Auth and its membership is read through RLS. Clients never
 * choose rooms themselves.
 *
 * Because a WebSocket outlives the handshake (and the access token, ~1 h):
 *  - the browser sends its renewed token (`auth:refresh`); the server
 *    verifies it belongs to the same user and keeps it for revalidation;
 *  - every REALTIME_REVALIDATE_MS the server re-checks the CURRENT token and
 *    the membership. A socket that fails is told why (`realtime:revoked`)
 *    and closed: "token" -> the browser refreshes and reconnects,
 *    "membership" -> the browser stays disconnected.
 */

export const REALTIME_REVALIDATE_MS = 5 * 60 * 1000;
/** Minimum interval between two accepted `auth:refresh` messages of one socket. */
export const REALTIME_REFRESH_MIN_INTERVAL_MS = 10 * 1000;
const MAX_TOKEN_LENGTH = 8192;

export interface RealtimeSocketData {
  userId?: string;
  token?: string;
  organizationId?: string;
  lastRefreshAt?: number;
}

export interface RevalidatableSocket {
  data: RealtimeSocketData;
  disconnect(close?: boolean): unknown;
  emit?(event: string, ...args: unknown[]): unknown;
}

type AuthDeps = Pick<AppDeps, "identity" | "repositories">;

export type HandshakeResult =
  | { ok: true; data: Required<Pick<RealtimeSocketData, "userId" | "token" | "organizationId">> }
  | { ok: false; error: "unauthorized" | "forbidden" };

/** Validates the handshake payload `{ token, organizationId }`. */
export async function authenticateHandshake(auth: unknown, deps: AuthDeps): Promise<HandshakeResult> {
  const { token, organizationId } = (auth ?? {}) as { token?: unknown; organizationId?: unknown };
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: "unauthorized" };
  }
  const org = idSchema.safeParse(organizationId);
  if (!org.success) return { ok: false, error: "unauthorized" };

  const user = await deps.identity.verifyAccessToken(token);
  if (!user) return { ok: false, error: "unauthorized" };

  const role = await deps.repositories(token).memberships.findRole(user.id, org.data);
  if (!role) return { ok: false, error: "forbidden" };

  return { ok: true, data: { userId: user.id, token, organizationId: org.data } };
}

/**
 * Accepts a renewed access token for an open socket. The token must belong to
 * the same user and the membership must still exist; otherwise the socket is
 * revoked. Too frequent refreshes are ignored (they would only cost Auth calls).
 */
export async function refreshSocketToken(
  socket: RevalidatableSocket,
  payload: unknown,
  deps: AuthDeps,
  now: number = Date.now()
): Promise<RealtimeAuthRefreshAck> {
  const token = (payload as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false };

  const { userId, organizationId, lastRefreshAt } = socket.data;
  if (!userId || !organizationId) return { ok: false };
  if (lastRefreshAt !== undefined && now - lastRefreshAt < REALTIME_REFRESH_MIN_INTERVAL_MS) return { ok: false };
  socket.data.lastRefreshAt = now;

  let reason: RealtimeRevokedReason | null = null;
  try {
    const user = await deps.identity.verifyAccessToken(token);
    if (!user || user.id !== userId) reason = "token";
    else if ((await deps.repositories(token).memberships.findRole(user.id, organizationId)) === null) reason = "membership";
  } catch {
    // Auth unavailable: keep the current token; the periodic revalidation decides later.
    return { ok: false };
  }

  if (reason) {
    revoke(socket, reason);
    return { ok: false };
  }
  socket.data.token = token;
  return { ok: true };
}

function revoke(socket: RevalidatableSocket, reason: RealtimeRevokedReason): void {
  socket.emit?.(REALTIME_REVOKED, { reason });
  socket.disconnect(true);
}

/** Disconnects sockets whose current token or membership is no longer valid. Returns how many were dropped. */
export async function revalidateSockets(sockets: Iterable<RevalidatableSocket>, deps: AuthDeps): Promise<number> {
  let dropped = 0;
  for (const socket of sockets) {
    const { token, organizationId, userId } = socket.data;
    let reason: RealtimeRevokedReason | null = "token";
    try {
      if (token && organizationId && userId) {
        const user = await deps.identity.verifyAccessToken(token);
        if (user?.id === userId) {
          reason = (await deps.repositories(token).memberships.findRole(user.id, organizationId)) === null ? "membership" : null;
        }
      }
    } catch {
      // Treat verification failures as an invalid session: the client refreshes and reconnects.
      reason = "token";
    }
    if (reason) {
      revoke(socket, reason);
      dropped += 1;
    }
  }
  return dropped;
}

export function attachRealtime(
  app: FastifyInstance,
  deps: AppDeps,
  subscriber: Redis,
  options: { revalidateMs?: number } = {}
): Server {
  const io = new Server(app.server, {
    path: "/realtime",
    serveClient: false,
    // Clients only send `auth:refresh`; keep frames small.
    maxHttpBufferSize: 16 * 1024,
    cors: { origin: deps.config.corsOrigins, credentials: false }
  });

  io.use(async (socket, next) => {
    try {
      const result = await authenticateHandshake(socket.handshake.auth, deps);
      if (!result.ok) return next(new Error(result.error));
      Object.assign(socket.data, result.data);
      await socket.join(organizationRoom(result.data.organizationId));
      return next();
    } catch (error) {
      app.log.warn({ err: serializeError(error) }, "realtime handshake failed");
      return next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.on(REALTIME_AUTH_REFRESH, (payload: unknown, ack?: unknown) => {
      void refreshSocketToken(socket as unknown as RevalidatableSocket, payload, deps)
        .then((result) => {
          if (typeof ack === "function") ack(result);
        })
        .catch((error: unknown) => app.log.warn({ err: serializeError(error) }, "realtime token refresh failed"));
    });
  });

  const timer = setInterval(() => {
    revalidateSockets(io.of("/").sockets.values() as Iterable<RevalidatableSocket>, deps)
      .then((dropped) => {
        if (dropped > 0) app.log.info({ dropped }, "realtime sockets disconnected after revalidation");
      })
      .catch((error: unknown) => app.log.warn({ err: serializeError(error) }, "realtime revalidation failed"));
  }, options.revalidateMs ?? REALTIME_REVALIDATE_MS);
  timer.unref();

  subscriber.subscribe(REALTIME_REDIS_CHANNEL).catch((error: unknown) => {
    app.log.error({ err: serializeError(error) }, "failed to subscribe to realtime channel");
  });

  subscriber.on("message", (_channel, message) => {
    try {
      const event = JSON.parse(message) as RealtimeEvent;
      if (!idSchema.safeParse(event.organizationId).success) return;
      io.to(organizationRoom(event.organizationId)).emit(event.type, event);
    } catch {
      app.log.warn("ignored malformed realtime message");
    }
  });

  app.addHook("onClose", async () => {
    clearInterval(timer);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  return io;
}
