import {
  ACCESS_ID_DEFAULT_PREFIX,
  customerAccessIssueSchema,
  customerSessionParamsSchema,
  formatAccessId,
  idParamsSchema
} from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { AccessIdHasher, generateAccessSecret } from "../../lib/customer-access.js";
import { AppError, notFound } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import { requestEntitlements } from "../plans/entitlements.js";

/*
 * Customer Access ID administration (EmailBot V2 phase 4), permission
 * customer-access:manage (OWNER/ADMIN/OPERATOR; never VIEWER).
 *
 * - The customer in the path is resolved inside the active organization
 *   (404 otherwise: IDOR); the database functions check the role again.
 * - The full Access ID is returned ONCE, by the request that generates it
 *   (Cache-Control: no-store). It is never stored, logged or audited:
 *   afterwards only "SP-••••••••XXXX" exists.
 * - Generating while an Access ID exists = regenerating: the previous
 *   credential and every session are revoked in the same transaction.
 */

const sessionListQuerySchema = z.object({ active: z.enum(["true", "false"]).optional() }).strict();
const MAX_ISSUE_ATTEMPTS = 3;

async function requireCustomer(request: FastifyRequest, customerId: string) {
  const customer = await getAuth(request).repos.customers.get(getOrganization(request).id, customerId);
  if (!customer) throw notFound("Customer");
  return customer;
}

export function customerAccessRoutes(deps: AppDeps) {
  const hasher = new AccessIdHasher(deps.config.tokenEncryptionKey);

  return async (app: FastifyInstance) => {
    const manage = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("customer-access:manage")] };

    app.get("/customers/:id/access", manage, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireCustomer(request, id);
      return { credential: await getAuth(request).repos.customerAccess.getActive(getOrganization(request).id, id) };
    });

    app.post("/customers/:id/access", { ...manage, config: { rateLimit: RATE_LIMITS.customerAccessIssue } }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const auth = getAuth(request);
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const input = parseWith(customerAccessIssueSchema, request.body);
      await requireCustomer(request, id);
      // Commercial V1: issuing portal Access IDs needs the PORTAL feature (PRO, BUSINESS).
      // Already issued Access IDs and open portal sessions are not revoked by a plan change.
      await requestEntitlements(request).assertFeatureEnabled("PORTAL");

      for (let attempt = 1; ; attempt++) {
        const secret = generateAccessSecret();
        try {
          const issued = await auth.repos.customerAccess.issue(id, {
            secretHash: hasher.hash(secret),
            last4: secret.slice(-4),
            displayPrefix: ACCESS_ID_DEFAULT_PREFIX,
            expiresAt: input.expiresAt ?? null
          });
          const regenerated = issued.previousCredentialId !== null;
          await app.audit(request, {
            action: "CREATE",
            entityType: "customer",
            entityId: id,
            metadata: {
              event: regenerated ? "customer.access.regenerated" : "customer.access.generated",
              credentialId: issued.credential.id,
              previousCredentialId: issued.previousCredentialId,
              revokedSessions: issued.revokedSessions,
              expiresAt: issued.credential.expiresAt
            }
          });
          return reply.status(201).send({
            accessId: formatAccessId(issued.credential.displayPrefix, secret),
            credential: { ...issued.credential, createdBy: auth.user.id },
            regenerated,
            revokedSessions: issued.revokedSessions
          });
        } catch (error) {
          // 60 random bits: a hash collision is astronomically unlikely, but never fatal.
          if (!(error instanceof AppError && error.code === "ALREADY_EXISTS") || attempt >= MAX_ISSUE_ATTEMPTS) throw error;
        }
      }
    });

    app.delete("/customers/:id/access", manage, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireCustomer(request, id);
      const revoked = await getAuth(request).repos.customerAccess.revoke(id);
      if (revoked.credentialId) {
        await app.audit(request, {
          action: "UPDATE",
          entityType: "customer",
          entityId: id,
          metadata: { event: "customer.access.revoked", credentialId: revoked.credentialId, revokedSessions: revoked.revokedSessions }
        });
      }
      return { revoked: revoked.credentialId !== null, revokedSessions: revoked.revokedSessions };
    });

    app.get("/customers/:id/sessions", manage, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const query = parseWith(sessionListQuerySchema, request.query, "query");
      await requireCustomer(request, id);
      const items = await getAuth(request).repos.customerAccess.listSessions(getOrganization(request).id, id, {
        activeOnly: query.active === "true",
        limit: 50
      });
      return { items };
    });

    app.delete("/customers/:id/sessions", manage, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      await requireCustomer(request, id);
      const revokedSessions = await getAuth(request).repos.customerAccess.revokeSessions(id, null);
      await app.audit(request, {
        action: "UPDATE",
        entityType: "customer",
        entityId: id,
        metadata: { event: "customer.sessions.revoked", revokedSessions }
      });
      return { revokedSessions };
    });

    app.delete("/customers/:id/sessions/:sessionId", manage, async (request) => {
      const { id, sessionId } = parseWith(customerSessionParamsSchema, request.params, "params");
      await requireCustomer(request, id);
      const revokedSessions = await getAuth(request).repos.customerAccess.revokeSessions(id, sessionId);
      if (revokedSessions > 0) {
        await app.audit(request, {
          action: "UPDATE",
          entityType: "customer",
          entityId: id,
          metadata: { event: "customer.session.revoked", reason: "REVOKED", sessionId }
        });
      }
      return { revokedSessions };
    });
  };
}
