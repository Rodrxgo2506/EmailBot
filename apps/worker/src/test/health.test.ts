import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { SecretBox } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeServer, createHealthServer, listen, readiness, type WorkerHealthState } from "../infrastructure/health.js";
import { handleAccountFailure, NonRetryableError } from "../pipeline/failures.js";
import { makeAccountStore, makeAccount, silentLogger } from "./fakes.js";

const servers: Array<ReturnType<typeof createHealthServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

async function start(state: WorkerHealthState, pingRedis: () => Promise<boolean>) {
  const server = createHealthServer({ state, pingRedis, redisTimeoutMs: 100 });
  servers.push(server);
  await listen(server, 0, "127.0.0.1");
  const { port } = server.address() as AddressInfo;
  return { server, url: (path: string) => `http://127.0.0.1:${port}${path}` };
}

const fresh = (): WorkerHealthState => ({ initialized: false, failed: false, stopping: false });

describe("worker health endpoint", () => {
  it("/livez answers while the process runs, even before initialization", async () => {
    const { url } = await start(fresh(), async () => false);
    const response = await fetch(url("/livez"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "alive" });
  });

  it("/readyz is 503 until queues, schedulers and workers are initialized", async () => {
    const state = fresh();
    const { url } = await start(state, async () => true);
    const before = await fetch(url("/readyz"));
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ status: "not_ready", checks: { initialized: false, redis: true } });

    state.initialized = true;
    const after = await fetch(url("/readyz"));
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ status: "ready", checks: { initialized: true, redis: true } });
  });

  it("/readyz reports Redis down, failing and hanging PINGs (bounded) as 503", async () => {
    const state = { ...fresh(), initialized: true };
    for (const ping of [async () => false, async () => Promise.reject(new Error("ECONNREFUSED")), () => new Promise<boolean>(() => undefined)]) {
      const report = await readiness({ state, pingRedis: ping, redisTimeoutMs: 50 });
      expect(report).toEqual({ status: "not_ready", checks: { initialized: true, redis: false } });
    }
  });

  it("an initialization failure or a shutdown in progress is not ready", async () => {
    expect((await readiness({ state: { initialized: true, failed: true, stopping: false }, pingRedis: async () => true })).status).toBe("not_ready");
    expect((await readiness({ state: { initialized: true, failed: false, stopping: true }, pingRedis: async () => true })).status).toBe("not_ready");
  });

  it("exposes nothing else: unknown paths 404, other methods 405, HEAD has no body", async () => {
    const { url } = await start({ ...fresh(), initialized: true }, async () => true);
    expect((await fetch(url("/"))).status).toBe(404);
    expect((await fetch(url("/api/emails"))).status).toBe(404);
    const post = await fetch(url("/livez"), { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const head = await fetch(url("/readyz"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(url("/livez?probe=1"))).status).toBe(200);
  });

  it("closes cleanly (SIGTERM path) and stops accepting connections", async () => {
    const { server, url } = await start(fresh(), async () => true);
    await closeServer(server);
    servers.splice(servers.indexOf(server), 1);
    await expect(fetch(url("/livez"))).rejects.toThrow();
  });

  it("fails to start when the port is taken (startup error is reported, not swallowed)", async () => {
    const { server } = await start(fresh(), async () => true);
    const { port } = server.address() as AddressInfo;
    const second = createHealthServer({ state: fresh(), pingRedis: async () => true });
    await expect(listen(second, port, "127.0.0.1")).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("credentials encrypted with another TOKEN_ENCRYPTION_KEY", () => {
  it("are reported on the account and not retried", async () => {
    const apiBox = SecretBox.fromBase64(randomBytes(32).toString("base64"));
    const workerBox = SecretBox.fromBase64(randomBytes(32).toString("base64"));
    let error: unknown;
    try {
      workerBox.decrypt(apiBox.encrypt("refresh-token"));
    } catch (caught) {
      error = caught;
    }
    const accounts = makeAccountStore([makeAccount()]);
    await expect(
      handleAccountFailure(error, { id: "account-1", organizationId: "org" }, { accounts, realtime: { publish: vi.fn() }, logger: silentLogger })
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(accounts.markError).toHaveBeenCalledWith("account-1", {
      code: "CREDENTIALS_UNREADABLE",
      message: "Stored credentials cannot be decrypted with the worker's TOKEN_ENCRYPTION_KEY."
    });
  });
});
