import { idParamsSchema, memberAddSchema, memberUpdateSchema } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { forbidden, notFound, unprocessable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";

/*
 * Membership rules (enforced here AND by RLS / triggers in the database):
 *  - OWNER is never assigned, changed or removed through these endpoints;
 *    ownership moves only through /organizations/current/transfer-ownership.
 *  - OWNER/ADMIN manage non-owner members.
 *  - Nobody changes their own role (prevents accidental self-lockout).
 */
export function memberRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const manage = {
      preHandler: [app.authenticate, app.requireOrganization, requirePermission("members:manage")]
    };

    const addGuards = { ...manage, config: { rateLimit: RATE_LIMITS.memberAdd } };

    app.get(
      "/organizations/current/members",
      { preHandler: [app.authenticate, app.requireOrganization, requirePermission("members:read")] },
      async (request) => {
        const members = await getAuth(request).repos.members.list(getOrganization(request).id);
        return { items: members };
      }
    );

    /**
     * Adds an existing EmailBot user by email. Email invitations for people
     * without an account are not implemented yet.
     */
    app.post("/organizations/current/members", addGuards, async (request, reply) => {
      const auth = getAuth(request);
      const organization = getOrganization(request);
      const input = parseWith(memberAddSchema, request.body);

      const userId = await deps.privileged.findProfileIdByEmail(input.email);
      if (!userId) {
        throw notFound("User with this email (they must sign up before being added)");
      }

      const member = await auth.repos.members.add(organization.id, userId, input.role);
      await app.audit(request, {
        action: "CREATE",
        entityType: "organization_member",
        entityId: member.id,
        metadata: { userId, role: input.role }
      });

      return reply.status(201).send({ member });
    });

    app.patch("/organizations/current/members/:id", manage, async (request) => {
      const auth = getAuth(request);
      const organization = getOrganization(request);
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const { role } = parseWith(memberUpdateSchema, request.body);

      const target = await auth.repos.members.get(organization.id, id);
      if (!target) throw notFound("Member");
      if (target.role === "OWNER") {
        throw forbidden("The OWNER role can only change through an ownership transfer", "CANNOT_MODIFY_OWNER");
      }
      if (target.userId === auth.user.id) {
        throw unprocessable("You cannot change your own role", "CANNOT_CHANGE_OWN_ROLE");
      }
      if (target.role === role) return { member: target };

      const member = await auth.repos.members.updateRole(organization.id, id, role);
      if (!member) throw notFound("Member");

      await app.audit(request, {
        action: "ROLE_CHANGE",
        entityType: "organization_member",
        entityId: id,
        metadata: { userId: target.userId, from: target.role, to: role }
      });
      return { member };
    });

    app.delete("/organizations/current/members/:id", manage, async (request, reply) => {
      const auth = getAuth(request);
      const organization = getOrganization(request);
      const { id } = parseWith(idParamsSchema, request.params, "params");

      const target = await auth.repos.members.get(organization.id, id);
      if (!target) throw notFound("Member");
      if (target.role === "OWNER") {
        throw forbidden("The OWNER cannot be removed. Transfer ownership first.", "CANNOT_REMOVE_OWNER");
      }

      const auditEntry = {
        action: "DELETE" as const,
        entityType: "organization_member",
        entityId: id,
        metadata: { userId: target.userId, role: target.role }
      };
      const removingSelf = target.userId === auth.user.id;

      // The audit actor must be a member when the record is inserted.
      if (removingSelf) await app.audit(request, auditEntry);
      const removed = await auth.repos.members.remove(organization.id, id);
      if (!removed) throw notFound("Member");
      if (!removingSelf) await app.audit(request, auditEntry);

      return reply.status(204).send();
    });
  };
}
