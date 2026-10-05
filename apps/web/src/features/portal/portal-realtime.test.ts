import { PORTAL_INBOX_CHANGED, PORTAL_REALTIME_REVOKED } from "@emailbot/types";
import { describe, expect, it, vi } from "vitest";
import { createPortalRealtime, PORTAL_SOCKET_OPTIONS, type PortalSocket } from "./portal-realtime";

function fakeSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return socket;
    }),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    fire: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((listener) => listener(...args))
  };
  return socket;
}

function open() {
  const socket = fakeSocket();
  const factory = vi.fn((_url: string, _options: object) => socket as unknown as PortalSocket);
  const handlers = { onInboxChanged: vi.fn(), onRevoked: vi.fn() };
  const stop = createPortalRealtime("https://api.example/", factory)(handlers);
  return { socket, factory, handlers, stop };
}

describe("createPortalRealtime", () => {
  it("connects to the /portal namespace over WebSocket only, with the cookie (no token, no ids)", () => {
    const { factory } = open();
    expect(factory).toHaveBeenCalledWith("https://api.example/portal", PORTAL_SOCKET_OPTIONS);
    expect(PORTAL_SOCKET_OPTIONS).toMatchObject({ path: "/realtime", transports: ["websocket"], withCredentials: true });
    expect(JSON.stringify(PORTAL_SOCKET_OPTIONS)).not.toMatch(/auth|token|customer|organization/i);
  });

  it("an inbox signal and a reconnection (signals may have been lost) refresh the inbox; the first connection does not", () => {
    const { socket, handlers } = open();
    socket.fire("connect");
    expect(handlers.onInboxChanged).not.toHaveBeenCalled();
    socket.fire(PORTAL_INBOX_CHANGED);
    socket.fire("connect");
    expect(handlers.onInboxChanged).toHaveBeenCalledTimes(2);
  });

  it("a revoked session stops the socket and is reported", () => {
    const { socket, handlers } = open();
    socket.fire(PORTAL_REALTIME_REVOKED);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(handlers.onRevoked).toHaveBeenCalledTimes(1);
  });

  it("stops on final handshake errors and keeps retrying transient ones", () => {
    const { socket } = open();
    socket.fire("connect_error", new Error("websocket error"));
    expect(socket.disconnect).not.toHaveBeenCalled();
    socket.fire("connect_error", new Error("unauthorized"));
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    socket.fire("connect_error", new Error("forbidden_origin"));
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it("the returned function closes everything", () => {
    const { socket, stop } = open();
    stop();
    expect(socket.removeAllListeners).toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
