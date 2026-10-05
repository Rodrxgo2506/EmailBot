import { serializeError } from "@emailbot/shared";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { getAuth } from "../../plugins/auth.js";

export function meRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    /**
     * Current user, the organizations they belong to (with role) and whether
     * they are a platform administrator (EmailBot V2 phase 6). The flag only
     * adapts the web UI; /api/admin/* checks it again on every request. A
     * failed lookup reports false instead of breaking the panel.
     */
    app.get("/me", { preHandler: [app.authenticate] }, async (request) => {
      const auth = getAuth(request);
      const [memberships, isPlatformAdmin] = await Promise.all([
        auth.repos.memberships.listForUser(auth.user.id),
        deps.admin.isPlatformAdmin(auth.user.id).catch((error: unknown) => {
          request.log.warn({ err: serializeError(error) }, "platform admin lookup failed; reported as false");
          return false;
        })
      ]);
      return { user: auth.user, memberships, isPlatformAdmin };
    });

    /**
     * Called by the web app right after a successful sign-in so the login is
     * recorded in the active organization's audit trail. Sign-in itself is
     * handled by Supabase Auth in the browser.
     */
    app.post(
      "/me/login-event",
      { preHandler: [app.authenticate, app.requireOrganization], config: { rateLimit: RATE_LIMITS.loginEvent } },
      async (request, reply) => {
        await app.audit(request, { action: "LOGIN", entityType: "user", entityId: getAuth(request).user.id });
        return reply.status(204).send();
      }
    );
  };
}
