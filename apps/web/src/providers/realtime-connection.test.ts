import { REALTIME_AUTH_REFRESH, REALTIME_REVOKED } from "@emailbot/types";
import { describe, expect, it, vi } from "vitest";
import { connectRealtime, type HandshakeAuth, type RealtimeConnectionOptions, type RealtimeStatus } from "./realtime-connection";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Minimal socket.io-client stand-in: records emits, lets tests fire events. */
class FakeSocket {
  connected = false;
  readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  connects = 0;
  disconnected = false;

  constructor(readonly auth: HandshakeAuth) {}
  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
    return this;
  }
  connect() {
    this.connects += 1;
    return this;
  }
  disconnect() {
    this.disconnected = true;
    this.connected = false;
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    if (event === "connect") this.connected = true;
    if (event === "disconnect") this.connected = false;
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  async handshake() {
    return new Promise<{ token: string; organizationId: string }>((resolve) => this.auth(resolve));
  }
}

function setup(overrides: Partial<RealtimeConnectionOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: RealtimeStatus[] = [];
  const tokenListeners = new Set<(token: string) => void>();
  const scheduled: Array<() => void> = [];
  let session: string | null = "token-1";

  const options: RealtimeConnectionOptions = {
    organizationId: ORG,
    createSocket: (auth) => {
      const socket = new FakeSocket(auth);
      sockets.push(socket);
      return socket;
    },
    getAccessToken: vi.fn(async () => session),
    refreshAccessToken: vi.fn(async () => {
      if (session) session = `${session}-refreshed`;
      return session;
    }),
    onTokenRefreshed: (listener) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
    onStatus: (status) => statuses.push(status),
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {
        const index = scheduled.indexOf(callback);
        if (index !== -1) scheduled.splice(index, 1);
      };
    },
    ...overrides
  };
  const connection = connectRealtime(options);
  const flush = async () => {
    while (scheduled.length > 0) scheduled.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    connection,
    socket: sockets[0] as FakeSocket,
    sockets,
    statuses,
    tokenListeners,
    options,
    flush,
    signOut: () => {
      session = null;
    },
    renew: (token: string) => {
      session = token;
      for (const listener of tokenListeners) listener(token);
    }
  };
}

describe("realtime connection", () => {
  it("initial connection sends the current token and organization", async () => {
    const { socket, statuses } = setup();
    expect(await socket.handshake()).toEqual({ token: "token-1", organizationId: ORG });
    socket.fire("connect");
    expect(statuses.at(-1)).toBe("connected");
  });

  it("pushes a renewed token to the server while connected", () => {
    const { socket, renew } = setup();
    socket.fire("connect");
    renew("token-2");
    expect(socket.emitted).toEqual([{ event: REALTIME_AUTH_REFRESH, args: [{ token: "token-2" }, expect.any(Function)] }]);
  });

  it("does not push tokens while disconnected", () => {
    const { socket, renew } = setup();
    renew("token-2");
    expect(socket.emitted).toHaveLength(0);
  });

  it("server revocation for an invalid session: refreshes the session and reconnects", async () => {
    const { socket, flush, options, statuses } = setup();
    socket.fire("connect");
    socket.fire(REALTIME_REVOKED, { reason: "token" });
    socket.fire("disconnect", "io server disconnect");
    await flush();
    expect(options.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(1);
    expect(await socket.handshake()).toEqual({ token: "token-1-refreshed", organizationId: ORG });
    socket.fire("connect");
    expect(statuses.at(-1)).toBe("connected");
  });

  it("lost membership: does not reconnect", async () => {
    const { socket, flush, statuses } = setup();
    socket.fire("connect");
    socket.fire(REALTIME_REVOKED, { reason: "membership" });
    socket.fire("disconnect", "io server disconnect");
    await flush();
    expect(socket.connects).toBe(0);
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("handshake rejected as forbidden (other organization): stops", async () => {
    const { socket, flush } = setup();
    socket.fire("connect_error", new Error("forbidden"));
    await flush();
    expect(socket.connects).toBe(0);
  });

  it("handshake rejected as unauthorized (token about to expire / expired): refreshes and retries, bounded", async () => {
    const { socket, flush, options } = setup({ maxReconnectAttempts: 3 });
    for (let attempt = 0; attempt < 5; attempt++) {
      socket.fire("connect_error", new Error("unauthorized"));
      await flush();
    }
    expect(options.refreshAccessToken).toHaveBeenCalledTimes(3);
    expect(socket.connects).toBe(3);
  });

  it("a successful reconnection resets the retry budget", async () => {
    const { socket, flush } = setup({ maxReconnectAttempts: 1 });
    socket.fire("connect_error", new Error("unauthorized"));
    await flush();
    socket.fire("connect");
    socket.fire("connect_error", new Error("unauthorized"));
    await flush();
    expect(socket.connects).toBe(2);
  });

  it("signed out while reconnecting: stops", async () => {
    const { socket, flush, signOut } = setup();
    signOut();
    socket.fire("disconnect", "io server disconnect");
    await flush();
    expect(socket.connects).toBe(0);
  });

  it("network drops are left to socket.io's own reconnection", async () => {
    const { socket, flush, options } = setup();
    socket.fire("connect");
    socket.fire("disconnect", "transport close");
    await flush();
    expect(options.refreshAccessToken).not.toHaveBeenCalled();
    expect(socket.connects).toBe(0);
  });

  it("logout / organization switch: close() disconnects, unsubscribes and cancels pending reconnects", async () => {
    const { connection, socket, tokenListeners, flush } = setup();
    socket.fire("connect");
    socket.fire("disconnect", "io server disconnect"); // reconnect scheduled
    connection.close();
    await flush();
    expect(socket.disconnected).toBe(true);
    expect(socket.connects).toBe(0);
    expect(tokenListeners.size).toBe(0);
    expect(socket.listeners.size).toBe(0);
  });

  it("one connection per (user, organization): switching creates exactly one new socket", () => {
    const first = setup();
    first.socket.fire("connect");
    first.connection.close();
    const second = setup({ organizationId: "22222222-2222-4222-8222-222222222222" });
    expect(first.sockets).toHaveLength(1);
    expect(second.sockets).toHaveLength(1);
    expect(first.socket.disconnected).toBe(true);
    expect(second.socket.disconnected).toBe(false);
    first.connection.close(); // idempotent
  });
});
