import { serializeError } from "@emailbot/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../deps.js";
import type { AuditEntry } from "../../repositories/types.js";

export type AuditInput = Omit<AuditEntry, "organizationId" | "actorUserId" | "requestId"> & {
  organizationId?: string;
};

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Records an immutable audit event for the current user/organization.
     * Writes go through the service role (authenticated has no INSERT on
     * audit_logs). A failure is logged and reported but does not undo the
     * already-committed business operation.
     */
    audit(request: FastifyRequest, entry: AuditInput): Promise<void>;
  }
}

export function registerAuditRecorder(app: FastifyInstance, deps: AppDeps): void {
  app.decorate("audit", async (request: FastifyRequest, entry: AuditInput) => {
    const organizationId = entry.organizationId ?? request.organization?.id;
    if (!organizationId) return;

    try {
      await deps.privileged.insertAuditLog({
        ...entry,
        organizationId,
        actorUserId: request.auth?.user.id ?? null,
        requestId: request.id
      });
    } catch (error) {
      request.log.error(
        { err: serializeError(error), action: entry.action, entityType: entry.entityType },
        "failed to write audit log"
      );
    }
  });
}
