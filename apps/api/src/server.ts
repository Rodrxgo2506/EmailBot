import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { encryptionKeyFingerprint, fetchWithTimeout, SecretBox, sentryRelease, serializeError } from "@emailbot/shared";
import { REALTIME_REDIS_CHANNEL } from "@emailbot/types";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import type { AppDeps } from "./deps.js";
import { createRedisNonceStore } from "./infrastructure/nonces.js";
import { createBullJobQueue, createRedisConnection } from "./infrastructure/queue.js";
import { attachRealtime } from "./infrastructure/realtime.js";
import { flushSentry, initSentry } from "./lib/sentry.js";
import { adminOperations, createSupabaseClients, createSupabaseRepositories, privilegedOperations } from "./repositories/supabase/index.js";

// Local .env first, then the monorepo root .env (both optional).
loadDotenv({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")], quiet: true });

const config = loadConfig();
initSentry(config.sentryDsn, config.env, sentryRelease(process.env));

const supabase = createSupabaseClients(config.supabase, fetchWithTimeout(globalThis.fetch, config.supabaseHttpTimeoutMs));
const producerConnection = createRedisConnection(config.redisUrl, { forProducer: true });
const subscriberConnection = createRedisConnection(config.redisUrl, { forProducer: false });
const queue = createBullJobQueue(producerConnection);

for (const connection of [producerConnection, subscriberConnection]) {
  // Avoid crashing on transient Redis errors; readiness reports them.
  connection.on("error", () => undefined);
}

const deps: AppDeps = {
  config,
  identity: {
    async verifyAccessToken(accessToken) {
      const { data, error } = await supabase.anon.auth.getUser(accessToken);
      if (error || !data.user) return null;
      return { id: data.user.id, email: data.user.email ?? null };
    }
  },
  repositories: (accessToken) => createSupabaseRepositories(supabase.forUser(accessToken)),
  privileged: privilegedOperations(supabase.service),
  admin: adminOperations(supabase.service),
  queue,
  secretBox: SecretBox.fromBase64(config.tokenEncryptionKey),
  // OAuth token exchange and mailbox identity (Google / Microsoft).
  fetch: fetchWithTimeout(globalThis.fetch, config.providerHttpTimeoutMs),
  oauthNonces: createRedisNonceStore(producerConnection),
  rateLimitRedis: producerConnection,
  realtimePublisher: {
    async publish(event) {
      await producerConnection.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(event));
    }
  },
  readinessChecks: [
    {
      name: "redis",
      async check() {
        if ((await producerConnection.ping()) !== "PONG") throw new Error("unexpected PING reply");
      }
    }
  ]
};

const app = await buildApp(deps);
attachRealtime(app, deps, subscriberConnection);

app.addHook("onClose", async () => {
  await queue.close();
  producerConnection.disconnect();
  subscriberConnection.disconnect();
  await flushSentry();
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: serializeError(error) }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      port: config.port,
      // Effective CORS allow-list (public values): a stale CORS_ORIGINS is visible at startup.
      corsOrigins: config.corsOrigins === true ? "reflect-any (development)" : config.corsOrigins,
      // One-way identifier (not part of the key): must match the worker's.
      tokenEncryptionKeyFingerprint: encryptionKeyFingerprint(config.tokenEncryptionKey)
    },
    `EmailBot API running on http://${config.host}:${config.port}`
  );
} catch (error) {
  app.log.error({ err: serializeError(error) }, "failed to start");
  process.exit(1);
}
