import { PORTAL_INBOX_CHANGED, PORTAL_REALTIME_NAMESPACE, PORTAL_REALTIME_REVOKED } from "@emailbot/types";
import { io, type ManagerOptions, type SocketOptions } from "socket.io-client";

/*
 * Customer portal realtime (EmailBot V2 phase 7). One WebSocket to the API's
 * /portal namespace, authenticated by the httpOnly session cookie the browser
 * sends by itself (the page never reads it; nothing is stored). The server
 * only says "your inbox changed" (no ids, no content) or "your session is no
 * longer valid"; the portal then refetches through its API, so data access
 * keeps the exact same authorization as without realtime.
 */

export interface PortalRealtimeHandlers {
  /** New or removed deliveries (or a reconnection that may have missed signals). */
  onInboxChanged(): void;
  /** The session was revoked / expired / suspended while connected. */
  onRevoked(): void;
}

/** Opens the connection; returns a function that closes it. */
export type PortalRealtime = (handlers: PortalRealtimeHandlers) => () => void;

/** The subset of socket.io-client's Socket used here (fakes in tests). */
export interface PortalSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  disconnect(): unknown;
  removeAllListeners(): unknown;
}

export type PortalSocketFactory = (url: string, options: Partial<ManagerOptions & SocketOptions>) => PortalSocket;

/** Handshake rejections that will not change by retrying. */
const FINAL_ERRORS = new Set(["unauthorized", "forbidden_origin"]);

export const PORTAL_SOCKET_OPTIONS: Partial<ManagerOptions & SocketOptions> = {
  path: "/realtime",
  // WebSocket only: no long-polling requests (and no CORS credentials on them).
  transports: ["websocket"],
  withCredentials: true,
  reconnectionAttempts: 10
};

export function createPortalRealtime(apiUrl: string, createSocket: PortalSocketFactory = (url, options) => io(url, options)): PortalRealtime {
  return (handlers) => {
    const socket = createSocket(`${apiUrl.replace(/\/+$/, "")}${PORTAL_REALTIME_NAMESPACE}`, PORTAL_SOCKET_OPTIONS);
    let connectedBefore = false;

    socket.on("connect", () => {
      // After a reconnection, signals sent while offline were lost: refresh once.
      if (connectedBefore) handlers.onInboxChanged();
      connectedBefore = true;
    });
    socket.on(PORTAL_INBOX_CHANGED, () => handlers.onInboxChanged());
    socket.on(PORTAL_REALTIME_REVOKED, () => {
      socket.disconnect();
      handlers.onRevoked();
    });
    socket.on("connect_error", (error: Error) => {
      // No session / foreign origin: stop; the manual "Actualizar" keeps working.
      if (FINAL_ERRORS.has(error.message)) socket.disconnect();
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  };
}
