import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../deps.js";
import { forbidden } from "../lib/errors.js";
import { getAuth } from "./auth.js";

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler for /api/admin/*: run after `authenticate`. */
    requirePlatformAdmin(request: FastifyRequest): Promise<void>;
  }
}

/**
 * Platform administration guard (EmailBot V2 phase 6).
 *
 * The only authority is a row in public.platform_admins for the user of the
 * verified Supabase JWT, read from the database on every request (never from
 * the client, JWT metadata or an organization role). Every non-admin gets
 * the same 403 before any administrative data is read, so no resource
 * existence leaks. The admin.* functions check the actor again in the
 * database (defense in depth).
 */
export function registerPlatformAdmin(app: FastifyInstance, deps: AppDeps): void {
  app.decorate("requirePlatformAdmin", async (request: FastifyRequest) => {
    const auth = getAuth(request);
    if (!(await deps.admin.isPlatformAdmin(auth.user.id))) {
      request.log.warn({ event: "platform_admin.denied" }, "platform administration denied");
      throw forbidden("Platform administrator access required", "PLATFORM_ADMIN_REQUIRED");
    }
    request.log = request.log.child({ platformAdmin: true });
  });
}
