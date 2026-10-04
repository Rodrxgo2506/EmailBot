import { hasPermission, type OrganizationRole, type OrganizationStatus, type Permission } from "@emailbot/types";
import { idSchema } from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { badRequest, forbidden } from "../lib/errors.js";
import { getAuth } from "./auth.js";

export interface OrganizationContext {
  id: string;
  role: OrganizationRole;
  status: OrganizationStatus;
}

declare module "fastify" {
  interface FastifyRequest {
    organization: OrganizationContext | null;
  }
  interface FastifyContextConfig {
    /**
     * Route usable while the organization is SUSPENDED / CANCELLED (read its
     * status). Every other organization route answers 403 ORGANIZATION_INACTIVE.
     */
    allowInactiveOrganization?: boolean;
  }
  interface FastifyInstance {
    requireOrganization(request: FastifyRequest): Promise<void>;
  }
}

export const ORGANIZATION_HEADER = "x-organization-id";

/**
 * Resolves the active organization for the request.
 *
 * - The client selects it with the `X-Organization-Id` header.
 * - Membership and role are read from the database with the caller's JWT
 *   (never trusted from the client).
 * - Without the header, a user with exactly one organization uses it.
 */
export function registerOrganizationContext(app: FastifyInstance): void {
  app.decorateRequest("organization", null);

  app.decorate("requireOrganization", async (request: FastifyRequest) => {
    const auth = getAuth(request);
    const header = request.headers[ORGANIZATION_HEADER];

    if (typeof header === "string" && header.length > 0) {
      const parsed = idSchema.safeParse(header);
      if (!parsed.success) throw badRequest("Invalid X-Organization-Id header", "INVALID_ORGANIZATION_ID");

      const access = await auth.repos.memberships.findAccess(auth.user.id, parsed.data);
      if (!access) throw forbidden("You are not a member of this organization", "NOT_A_MEMBER");

      request.organization = { id: parsed.data, role: access.role, status: access.organizationStatus };
    } else {
      const memberships = await auth.repos.memberships.listForUser(auth.user.id);
      const only = memberships.length === 1 ? memberships[0] : undefined;

      if (memberships.length === 0) {
        throw forbidden("You do not belong to any organization yet", "NO_ORGANIZATION");
      }
      if (!only) {
        throw badRequest("Select an organization with the X-Organization-Id header", "ORGANIZATION_REQUIRED");
      }
      request.organization = { id: only.organization.id, role: only.role, status: only.organization.status };
    }

    // EmailBot V2: a SUSPENDED / CANCELLED organization keeps its data but cannot be operated.
    if (request.organization.status !== "ACTIVE" && request.routeOptions.config.allowInactiveOrganization !== true) {
      throw forbidden("This organization is not active", "ORGANIZATION_INACTIVE");
    }

    request.log = request.log.child({ organizationId: request.organization.id });
  });
}

export function getOrganization(request: FastifyRequest): OrganizationContext {
  if (!request.organization) throw forbidden("Organization context required", "ORGANIZATION_REQUIRED");
  return request.organization;
}

/** preHandler enforcing an application permission (mirrors RLS). */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest) => {
    const organization = getOrganization(request);
    if (!hasPermission(organization.role, permission)) {
      throw forbidden(`Your role (${organization.role}) cannot perform this action`, "INSUFFICIENT_ROLE");
    }
  };
}
