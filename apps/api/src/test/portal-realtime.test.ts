import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PORTAL_INBOX_CHANGED, PORTAL_REALTIME_REVOKED, REALTIME_REDIS_CHANNEL, type RealtimeEvent } from "@emailbot/types";
import type { Redis } from "ioredis";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "../lib/customer-access.js";
import {
  authenticatePortalHandshake,
  relayPortalEvent,
  revalidatePortalSockets,
  type PortalRevalidatableSocket
} from "../infrastructure/portal-realtime.js";
import { attachRealtime } from "../infrastructure/realtime.js";
import { PORTAL_SESSION_COOKIE } from "../modules/portal/session.js";
import { createTestApp, ORG_A, ORG_B } from "./helpers.js";

/*
 * EmailBot V2 phase 7: customer portal realtime. A /portal Socket.IO
 * namespace authenticated by the session cookie + Origin, one room per
 * customer, bare PORTAL_INBOX_CHANGED signals and periodic revalidation.
 */

const ORIGIN = "http://localhost:5173";
const CUSTOMER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CUSTOMER_A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CUSTOMER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const token = () => randomBytes(32).toString("base64url");
const cookie = (value: string) => `${PORTAL_SESSION_COOKIE}=${value}`;

interface Session {
  token: string;
  organizationId: string;
  customerId: string;
  sessionId: string;
}
const session = (organizationId: string, customerId: string): Session => ({ token: token(), organizationId, customerId, sessionId: `s-${customerId}` });

function sessionStore(sessions: Session[]) {
  const valid = new Map(sessions.map((entry) => [hashSessionToken(entry.token), entry]));
  return {
    valid,
    validate: vi.fn(async (tokenHash: string) => {
      const entry = valid.get(tokenHash);
      return entry ? { sessionId: entry.sessionId, organizationId: entry.organizationId, customerId: entry.customerId, profile: {} } : null;
    })
  };
}

describe("authenticatePortalHandshake", () => {
  const a = session(ORG_A, CUSTOMER_A);
  const store = sessionStore([a]);
  const deps = (corsOrigins: string[] | true = [ORIGIN]) =>
    ({ config: { corsOrigins }, privileged: { validatePortalSession: store.validate } }) as never;

  it("accepts an allowed origin with a valid session cookie and returns the session's own scope", async () => {
    expect(await authenticatePortalHandshake({ origin: ORIGIN, cookie: `other=1; ${cookie(a.token)}` }, deps())).toEqual({
      ok: true,
      data: { tokenHash: hashSessionToken(a.token), sessionId: a.sessionId, organizationId: ORG_A, customerId: CUSTOMER_A }
    });
  });

  it.each([
    ["foreign origin (cross-site WebSocket hijacking)", { origin: "https://evil.example", cookie: cookie(a.token) }, "forbidden_origin"],
    ["no origin", { cookie: cookie(a.token) }, "forbidden_origin"],
    ["no cookie", { origin: ORIGIN }, "unauthorized"],
    ["malformed token", { origin: ORIGIN, cookie: cookie("not-a-token") }, "unauthorized"],
    ["unknown / revoked session", { origin: ORIGIN, cookie: cookie(token()) }, "unauthorized"]
  ])("rejects %s", async (_label, headers, error) => {
    expect(await authenticatePortalHandshake(headers, deps())).toEqual({ ok: false, error });
  });

  it("development (reflected origins) does not require a listed origin", async () => {
    expect((await authenticatePortalHandshake({ cookie: cookie(a.token) }, deps(true))).ok).toBe(true);
  });
});

describe("revalidatePortalSockets", () => {
  const socket = (data: PortalRevalidatableSocket["data"]) => ({ data, emit: vi.fn(), disconnect: vi.fn() });

  it("drops sockets whose session is no longer valid (or now belongs to another session) and keeps the rest", async () => {
    const a = session(ORG_A, CUSTOMER_A);
    const store = sessionStore([a]);
    const ok = socket({ tokenHash: hashSessionToken(a.token), sessionId: a.sessionId });
    const revoked = socket({ tokenHash: hashSessionToken(token()), sessionId: "s-x" });
    const swapped = socket({ tokenHash: hashSessionToken(a.token), sessionId: "s-old" });
    const dropped = await revalidatePortalSockets([ok, revoked, swapped], { config: {}, privileged: { validatePortalSession: store.validate } } as never);
    expect(dropped).toBe(2);
    expect(ok.disconnect).not.toHaveBeenCalled();
    for (const gone of [revoked, swapped]) {
      expect(gone.emit).toHaveBeenCalledWith(PORTAL_REALTIME_REVOKED);
      expect(gone.disconnect).toHaveBeenCalledWith(true);
    }
  });

  it("keeps sockets when the database is unavailable (they carry no data)", async () => {
    const kept = socket({ tokenHash: "x", sessionId: "s" });
    const failing = { config: {}, privileged: { validatePortalSession: vi.fn(async () => Promise.reject(new Error("down"))) } };
    expect(await revalidatePortalSockets([kept], failing as never)).toBe(0);
    expect(kept.disconnect).not.toHaveBeenCalled();
  });
});

describe("relayPortalEvent", () => {
  it("emits a bare signal once per valid, distinct customer room", () => {
    const emit = vi.fn();
    const to = vi.fn((_room: string) => ({ emit }));
    const relayed = relayPortalEvent({ to } as never, { type: "portal.deliveries", organizationId: ORG_A, customerIds: [CUSTOMER_A, CUSTOMER_A, CUSTOMER_A2, "nope"] });
    expect(relayed).toBe(2);
    expect(to.mock.calls.map(([room]) => room)).toEqual([`customer:${ORG_A}:${CUSTOMER_A}`, `customer:${ORG_A}:${CUSTOMER_A2}`]);
    expect(emit.mock.calls).toEqual([[PORTAL_INBOX_CHANGED], [PORTAL_INBOX_CHANGED]]);
  });

  it("ignores an invalid organization id", () => {
    const to = vi.fn();
    expect(relayPortalEvent({ to } as never, { type: "portal.deliveries", organizationId: "x", customerIds: [CUSTOMER_A] })).toBe(0);
    expect(to).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ real Socket.IO server and clients */

describe("portal namespace over a real WebSocket", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function serve(sessions: Session[]) {
    const { app, deps, privileged } = await createTestApp();
    const store = sessionStore(sessions);
    privileged.validatePortalSession.mockImplementation(store.validate);
    const subscriber = Object.assign(new EventEmitter(), { subscribe: vi.fn(async () => 1) });
    attachRealtime(app, deps, subscriber as unknown as Redis, { portalRevalidateMs: 100 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as { port: number };
    cleanup.push(() => app.close());
    const publish = (event: RealtimeEvent) => subscriber.emit("message", REALTIME_REDIS_CHANNEL, JSON.stringify(event));
    return { port, store, publish };
  }

  function client(port: number, headers: Record<string, string>, namespace = "/portal"): Socket {
    const socket = connect(`http://127.0.0.1:${port}${namespace}`, { path: "/realtime", transports: ["websocket"], extraHeaders: headers, reconnection: false, forceNew: true });
    cleanup.push(() => {
      socket.disconnect();
    });
    return socket;
  }

  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (error) => reject(error));
    });
  const rejected = (socket: Socket) =>
    new Promise<string>((resolve) => {
      socket.once("connect", () => resolve("connected"));
      socket.once("connect_error", (error) => resolve(error.message));
    });
  const received = (socket: Socket, event: string) => {
    const calls: unknown[][] = [];
    socket.on(event, (...args: unknown[]) => calls.push(args));
    return calls;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it("each customer only receives the signal for its own inbox, without any payload", async () => {
    const a = session(ORG_A, CUSTOMER_A);
    const a2 = session(ORG_A, CUSTOMER_A2);
    const b = session(ORG_B, CUSTOMER_B);
    const { port, publish } = await serve([a, a2, b]);
    const sockets = [a, a2, b].map((entry) => client(port, { origin: ORIGIN, cookie: cookie(entry.token) }));
    await Promise.all(sockets.map(connected));
    const [signalsA, signalsA2, signalsB] = sockets.map((socket) => received(socket, PORTAL_INBOX_CHANGED));

    publish({ type: "portal.deliveries", organizationId: ORG_A, customerIds: [CUSTOMER_A] });
    // A customer id under the wrong organization reaches nobody.
    publish({ type: "portal.deliveries", organizationId: ORG_A, customerIds: [CUSTOMER_B] });
    // Organization events never reach the portal.
    publish({ type: "email.processed", organizationId: ORG_A, emailId: "e", emailAccountId: "a", categoryId: null, matchedRuleId: null, botId: null, subject: "secreto", important: false });
    await settle();

    expect(signalsA).toEqual([[]]);
    expect(signalsA2).toEqual([]);
    expect(signalsB).toEqual([]);
  });

  it.each([
    ["a foreign Origin", (t: string) => ({ origin: "https://evil.example", cookie: cookie(t) }), "forbidden_origin"],
    ["no session cookie", () => ({ origin: ORIGIN }), "unauthorized"],
    ["an unknown session", () => ({ origin: ORIGIN, cookie: cookie(token()) }), "unauthorized"]
  ])("rejects a handshake with %s", async (_label, headers, error) => {
    const a = session(ORG_A, CUSTOMER_A);
    const { port } = await serve([a]);
    expect(await rejected(client(port, headers(a.token)))).toBe(error);
  });

  it("the portal cookie gives no access to the organization namespace", async () => {
    const a = session(ORG_A, CUSTOMER_A);
    const { port } = await serve([a]);
    expect(await rejected(client(port, { origin: ORIGIN, cookie: cookie(a.token) }, "/"))).toBe("unauthorized");
  });

  it("a session revoked while connected is told and disconnected at the next revalidation", async () => {
    const a = session(ORG_A, CUSTOMER_A);
    const { port, store } = await serve([a]);
    const socket = client(port, { origin: ORIGIN, cookie: cookie(a.token) });
    await connected(socket);
    const revoked = received(socket, PORTAL_REALTIME_REVOKED);
    const disconnected = new Promise<string>((resolve) => socket.once("disconnect", (reason) => resolve(reason)));
    store.valid.clear();
    expect(await disconnected).toBe("io server disconnect");
    expect(revoked).toHaveLength(1);
  });
});
