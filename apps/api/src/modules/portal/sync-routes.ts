import { serializeError } from "@emailbot/shared";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { AppError } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { getPortal, portalOriginGuard, portalTokenHash } from "./session.js";

/*
 * Customer portal manual sync (EmailBot V2 phase 5.6).
 *
 *   POST /api/portal/sync   request a sync now (fast: only queues jobs)
 *   GET  /api/portal/sync   { running, lastSyncAt } for the "Actualizar" button
 *
 * Scope comes ONLY from the session: session -> customer -> organization ->
 * active assignments -> the organization's ACTIVE mailboxes
 * (portal.sync_scope). Nothing in the body / query / headers is read: no
 * customerId, organizationId, botId or emailAccountId can widen it, and the
 * account ids never leave the server. Jobs are coalesced per account (at
 * most one waiting + one follow-up), so repeated clicks never pile up work.
 * One request per customer every 30 s (the existing resilient rate-limit
 * store: Redis, per-instance counters if Redis fails).
 */

export interface SyncLimiter {
  /** Counts a request for `key` in a fixed window; returns the count and the window's remaining ms. */
  hit(key: string, windowMs: number): Promise<{ current: number; ttl: number }>;
}

export function portalSyncRoutes(deps: AppDeps, limiter: SyncLimiter) {
  const originGuard = portalOriginGuard(deps);

  return async (app: FastifyInstance) => {
    const scopeOf = async (tokenHash: string) => {
      const accounts = await deps.privileged.portalSyncScope(tokenHash);
      const lastSyncAt = accounts.reduce<string | null>(
        (latest, account) => (account.lastSyncedAt && (!latest || account.lastSyncedAt > latest) ? account.lastSyncedAt : latest),
        null
      );
      return { accounts, lastSyncAt };
    };

    app.post(
      "/portal/sync",
      { preHandler: [originGuard, app.requirePortalSession], config: { rateLimit: RATE_LIMITS.portalRead } },
      async (request, reply) => {
        const portal = getPortal(request);
        const window = await limiter.hit(`customer:${portal.customerId}`, RATE_LIMITS.portalManualSync.windowMs);
        if (window.current > 1) {
          request.log.info({ event: "gmail.manual_sync.rate_limited" }, "portal manual sync rate limited");
          reply.header("retry-after", String(Math.max(1, Math.ceil(window.ttl / 1000))));
          throw new AppError(429, "RATE_LIMITED", "Too many sync requests. Try again later.");
        }

        const { accounts, lastSyncAt } = await scopeOf(portalTokenHash(request));
        if (accounts.length === 0) return reply.status(200).send({ status: "NOTHING_TO_SYNC", lastSyncAt });

        let queued = 0;
        for (const account of accounts) {
          const outcome = await deps.queue.requestAccountSync({ id: account.emailAccountId, organizationId: account.organizationId }, "PORTAL");
          if (outcome === "QUEUED") queued += 1;
        }
        const status = queued > 0 ? "QUEUED" : "ALREADY_RUNNING";
        request.log.info({ event: "gmail.manual_sync.requested", accounts: accounts.length, queued, status }, "portal manual sync requested");
        void app
          .audit(request, {
            organizationId: portal.organizationId,
            action: "PROCESS",
            entityType: "customer",
            entityId: portal.customerId,
            metadata: { event: "gmail.manual_sync.requested", accounts: accounts.length, queued, status }
          })
          .catch((error: unknown) => request.log.warn({ err: serializeError(error) }, "could not record the manual sync"));
        return reply.status(202).send({ status, lastSyncAt });
      }
    );

    app.get("/portal/sync", { preHandler: [app.requirePortalSession], config: { rateLimit: RATE_LIMITS.portalRead } }, async (request) => {
      const { accounts, lastSyncAt } = await scopeOf(portalTokenHash(request));
      let running = false;
      for (const account of accounts) {
        if (await deps.queue.isAccountSyncPending(account.emailAccountId)) {
          running = true;
          break;
        }
      }
      return { running, lastSyncAt };
    });
  };
}
