import type { FastifyInstance } from "fastify";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { getAuth } from "../../plugins/auth.js";

export async function meRoutes(app: FastifyInstance) {
  /** Current user and the organizations they belong to (with role). */
  app.get("/me", { preHandler: [app.authenticate] }, async (request) => {
    const auth = getAuth(request);
    const memberships = await auth.repos.memberships.listForUser(auth.user.id);
    return { user: auth.user, memberships };
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
}
