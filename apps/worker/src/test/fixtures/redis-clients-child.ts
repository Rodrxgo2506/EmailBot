// F5.2 test fixture (not a test file): the Redis wiring of index.ts (BullMQ connection, bounded application client,
// bounded publisher, queues with bounded producers, a BullMQ Worker) and the F5.1 shutdown WITHOUT process.exit:
// once the shutdown finished, the process must end by itself - proof that no connection, socket or timer is left.
// Driven over IPC by worker-redis-limits-valkey.test.ts. A2_BULLMQ_URL must pass the throwaway-Valkey guard.
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createAppRedis } from "../../infrastructure/app-redis.js";
import { createWorkerQueues } from "../../infrastructure/queues.js";
import { createJobTracker, createShutdown, shutdownLimits } from "../../infrastructure/shutdown.js";
import { createAppRealtimePublisher } from "../../infrastructure/supabase-stores.js";
import { createAppRedisSyncLock } from "../../infrastructure/sync-lock.js";

const guard = (await import(new URL("../../../../api/src/test/valkey-target.ts", import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string };
const TARGET = guard.assertLocalValkeyUrl(process.env.A2_BULLMQ_URL ?? "");
const QUEUE = process.env.F52_QUEUE ?? "f52-child";
const send = (message: Record<string, unknown>) => process.send?.(message);

const connection = new Redis(TARGET, { maxRetriesPerRequest: null });
const appRedis = createAppRedis(TARGET, 2_000);
const publisherRedis = createAppRedis(TARGET, 2_000);
for (const client of [connection, appRedis.client, publisherRedis.client]) client.on("error", () => undefined);
const queues = createWorkerQueues(connection, { producerTimeoutMs: 2_000 });
const jobs = new Queue(QUEUE, { connection });
const lock = createAppRedisSyncLock(appRedis);
const realtime = createAppRealtimePublisher(publisherRedis);
const tracker = createJobTracker();
const worker = new Worker(
  QUEUE,
  tracker.wrap(async () => {
    const token = await lock.acquire("f52-child-account", 60_000);
    await realtime.publish({ type: "notification", organizationId: "o", emailId: "e", title: "t", body: "b" });
    if (token) await lock.release("f52-child-account", token);
    return "done";
  }),
  { connection, concurrency: 1 }
);
worker.on("error", () => undefined);
worker.on("completed", () => send({ event: "completed" }));

const shutdown = createShutdown(
  {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    workers: [worker],
    tracker,
    markStopping: () => undefined,
    abortImap: () => undefined,
    interruptBlockedClients: () => publisherRedis.client.disconnect(),
    release: [
      { name: "queues", run: () => queues.close() },
      { name: "jobs", run: () => jobs.close() }
    ],
    disconnect: () => {
      connection.disconnect();
      appRedis.client.disconnect();
      publisherRedis.client.disconnect();
    },
    flush: async () => undefined,
    // No process.exit: the process has to end on its own.
    exit: (code) => {
      const resources = process.getActiveResourcesInfo();
      send({ event: "shutdown", code, resources });
      process.disconnect?.(); // the IPC channel itself would keep the process alive
    }
  },
  shutdownLimits(15_000)
);

process.on("message", async (message: { signal?: string; enqueue?: boolean }) => {
  if (message.signal) shutdown.onSignal(message.signal);
  if (message.enqueue) {
    await jobs.add("f52", {});
    send({ event: "enqueued" });
  }
});
await worker.waitUntilReady();
await Promise.all([appRedis.run("ping", (redis) => redis.ping()), publisherRedis.run("ping", (redis) => redis.ping())]);
send({ event: "ready" });
