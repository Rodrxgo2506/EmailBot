import { auditListQuerySchema } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";

export async function auditRoutes(app: FastifyInstance) {
  app.get(
    "/audit-logs",
    { preHandler: [app.authenticate, app.requireOrganization, requirePermission("audit:read")] },
    async (request) => {
      const query = parseWith(auditListQuerySchema, request.query, "query");
      return getAuth(request).repos.audit.list(getOrganization(request).id, query);
    }
  );
}
