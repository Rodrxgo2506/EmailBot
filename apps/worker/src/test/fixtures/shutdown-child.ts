// F5.1 test fixture (not a test file): a minimal worker PROCESS with a real BullMQ Worker, the real shutdown
// orchestrator and the real process.exit, driven by its parent over IPC (worker-shutdown-bullmq.test.ts). On
// Windows a parent cannot deliver POSIX signals to a child, so "signal" messages call the same handler that
// process.on("SIGTERM" / "SIGINT") calls. A2_BULLMQ_URL must pass the throwaway-Valkey guard.
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createJobTracker, createShutdown, shutdownLimits } from "../../infrastructure/shutdown.js";

const guard = (await import(new URL("../../../../api/src/test/valkey-target.ts", import.meta.url).href)) as { assertLocalValkeyUrl(raw: string): string };
const TARGET = guard.assertLocalValkeyUrl(process.env.A2_BULLMQ_URL ?? "");
const QUEUE = process.env.F51_QUEUE ?? "f51-child";
const send = (message: Record<string, unknown>) => process.send?.(message);
const started = { at: 0 };

const connection = new Redis(TARGET, { maxRetriesPerRequest: null });
const publisher = new Redis(TARGET, { maxRetriesPerRequest: null });
connection.on("error", () => undefined);
publisher.on("error", () => undefined);
const queue = new Queue(QUEUE, { connection });
const tracker = createJobTracker();
let finish: () => void = () => undefined;
const worker = new Worker(
  QUEUE,
  tracker.wrap(async () => {
    send({ event: "active" });
    await new Promise<void>((resolve) => (finish = resolve));
    return "done";
  }),
  { connection, concurrency: 1 }
);
worker.on("error", () => undefined);
const log = (level: string) => (fields: unknown, message?: string) => send({ event: "log", level, fields, message, elapsedMs: started.at ? Date.now() - started.at : 0 });
const shutdown = createShutdown(
  {
    logger: { debug: () => undefined, info: log("info"), warn: log("warn"), error: log("error") },
    workers: [worker],
    tracker,
    markStopping: () => undefined,
    abortImap: () => undefined,
    interruptBlockedClients: () => publisher.disconnect(),
    release: [{ name: "queue", run: () => queue.close() }],
    disconnect: () => {
      connection.disconnect();
      publisher.disconnect();
    },
    flush: async () => undefined,
    exit: (code) => process.exit(code)
  },
  shutdownLimits(Number(process.env.F51_TOTAL_MS ?? 15_000))
);
const onSignal = (signal: string) => {
  if (!started.at) started.at = Date.now();
  shutdown.onSignal(signal);
};
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("message", (message: { signal?: string; finish?: boolean }) => {
  if (message.signal) onSignal(message.signal);
  if (message.finish) finish();
});
await worker.waitUntilReady();
send({ event: "ready" });
