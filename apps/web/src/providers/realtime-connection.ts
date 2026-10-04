import {
  REALTIME_AUTH_REFRESH,
  REALTIME_REVOKED,
  type RealtimeAuthRefreshAck,
  type RealtimeRevokedReason
} from "@emailbot/types";

export type RealtimeStatus = "connecting" | "connected" | "disconnected";

/** The subset of socket.io-client's Socket used here (fakes in tests). */
export interface RealtimeSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  connect(): unknown;
  disconnect(): unknown;
  removeAllListeners(): unknown;
}

export type HandshakeAuth = (callback: (auth: { token: string; organizationId: string }) => void) => void;

export interface RealtimeConnectionOptions {
  organizationId: string;
  createSocket(auth: HandshakeAuth): RealtimeSocket;
  /** Current access token (supabase.auth.getSession). */
  getAccessToken(): Promise<string | null>;
  /** Forces a session refresh; null when the user is signed out. */
  refreshAccessToken(): Promise<string | null>;
  /** Calls `listener` with every renewed access token; returns an unsubscribe function. */
  onTokenRefreshed(listener: (token: string) => void): () => void;
  onStatus(status: RealtimeStatus): void;
  maxReconnectAttempts?: number;
  /** Delay before reconnect attempt n (1-based). */
  reconnectDelayMs?: (attempt: number) => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

export interface RealtimeConnection {
  readonly socket: RealtimeSocket;
  close(): void;
}

const defaultSchedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * One realtime socket for one (user, organization):
 *  - the handshake always reads the CURRENT access token;
 *  - renewed tokens are pushed to the server (`auth:refresh`) so its periodic
 *    revalidation never relies on the expired handshake token;
 *  - when the server closes the socket for an invalid session, the client
 *    refreshes the session and reconnects (socket.io does not reconnect by
 *    itself after a server-side disconnect or a middleware rejection);
 *  - when access to the organization was removed ("forbidden" /
 *    `realtime:revoked` membership) it stays disconnected;
 *  - close() (logout, organization switch, unmount) stops everything.
 */
export function connectRealtime(options: RealtimeConnectionOptions): RealtimeConnection {
  const maxAttempts = options.maxReconnectAttempts ?? 5;
  const delay = options.reconnectDelayMs ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1)));
  const schedule = options.schedule ?? defaultSchedule;

  let closed = false;
  let attempts = 0;
  let revokedReason: RealtimeRevokedReason | null = null;
  let cancelPending: (() => void) | null = null;

  const auth: HandshakeAuth = (callback) => {
    void options.getAccessToken().then((token) => callback({ token: token ?? "", organizationId: options.organizationId }));
  };
  const socket = options.createSocket(auth);

  const stop = () => {
    cancelPending?.();
    cancelPending = null;
    options.onStatus("disconnected");
  };

  /** Refresh the session, then reconnect with backoff (bounded). */
  const reconnect = () => {
    if (closed || cancelPending) return;
    if (attempts >= maxAttempts) return stop();
    attempts += 1;
    options.onStatus("connecting");
    cancelPending = schedule(() => {
      cancelPending = null;
      if (closed) return;
      void options.refreshAccessToken().then((token) => {
        if (closed) return;
        if (!token) return stop(); // signed out
        socket.connect();
      });
    }, delay(attempts));
  };

  socket.on("connect", () => {
    attempts = 0;
    revokedReason = null;
    options.onStatus("connected");
  });

  socket.on(REALTIME_REVOKED, (payload: { reason?: RealtimeRevokedReason } | undefined) => {
    revokedReason = payload?.reason ?? "token";
  });

  socket.on("disconnect", (reason: string) => {
    if (closed) return;
    options.onStatus("disconnected");
    // Network-level drops are retried by socket.io itself.
    if (reason !== "io server disconnect") return;
    if (revokedReason === "membership") return stop();
    reconnect();
  });

  socket.on("connect_error", (error: Error) => {
    if (closed) return;
    options.onStatus("disconnected");
    if (error.message === "forbidden") return stop(); // not a member of this organization (anymore)
    if (error.message === "unauthorized") reconnect(); // expired/invalid token: refresh and retry
    // Other errors (network) are retried by socket.io itself.
  });

  const unsubscribe = options.onTokenRefreshed((token) => {
    if (closed || !socket.connected) return;
    socket.emit(REALTIME_AUTH_REFRESH, { token }, (_ack: RealtimeAuthRefreshAck) => undefined);
  });

  options.onStatus("connecting");

  return {
    socket,
    close() {
      if (closed) return;
      closed = true;
      cancelPending?.();
      cancelPending = null;
      unsubscribe();
      socket.removeAllListeners();
      socket.disconnect();
    }
  };
}
