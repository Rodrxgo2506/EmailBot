import { randomBytes } from "node:crypto";
import {
  organizationCreateSchema,
  organizationSettingsUpdateSchema,
  organizationUpdateSchema,
  slugify,
  transferOwnershipSchema
} from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import { AppError, notFound, unprocessable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { compact, parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";

const SETTINGS_COLUMN_MAP = {
  timezone: "timezone",
  language: "language",
  autoProcessingEnabled: "auto_processing_enabled",
  processAttachments: "process_attachments",
  notificationsEnabled: "notifications_enabled",
  emailNotificationsEnabled: "email_notifications_enabled",
  emailRetentionDays: "email_retention_days",
  defaultInboxFilter: "default_inbox_filter"
} as const;

export async function organizationRoutes(app: FastifyInstance) {
  /** Creates an organization; the caller becomes its OWNER (DB function). */
  const createGuards = { preHandler: [app.authenticate], config: { rateLimit: RATE_LIMITS.organizationCreate } };

  app.post("/organizations", createGuards, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseWith(organizationCreateSchema, request.body);
    const baseSlug = input.slug ?? (slugify(input.name) || "workspace");

    let organizationId: string;
    try {
      organizationId = await auth.repos.organizations.create(input.name, baseSlug);
    } catch (error) {
      // Auto-generated slug already taken: retry once with a random suffix.
      if (input.slug || !(error instanceof AppError) || error.code !== "ALREADY_EXISTS") throw error;
      organizationId = await auth.repos.organizations.create(
        input.name,
        `${baseSlug.slice(0, 50)}-${randomBytes(3).toString("hex")}`
      );
    }

    const organization = await auth.repos.organizations.get(organizationId);
    await app.audit(request, {
      organizationId,
      action: "CREATE",
      entityType: "organization",
      entityId: organizationId,
      metadata: { name: input.name }
    });

    return reply.status(201).send({ organization, role: "OWNER" });
  });

  const memberGuards = { preHandler: [app.authenticate, app.requireOrganization] };

  app.get("/organizations/current", memberGuards, async (request) => {
    const auth = getAuth(request);
    const organization = getOrganization(request);
    const [details, settings] = await Promise.all([
      auth.repos.organizations.get(organization.id),
      auth.repos.organizations.getSettings(organization.id)
    ]);
    if (!details) throw notFound("Organization");
    return { organization: details, role: organization.role, settings };
  });

  app.patch(
    "/organizations/current",
    { preHandler: [app.authenticate, app.requireOrganization, requirePermission("organization:update")] },
    async (request) => {
      const organization = getOrganization(request);
      const patch = compact(parseWith(organizationUpdateSchema, request.body));
      const updated = await getAuth(request).repos.organizations.update(organization.id, patch);
      if (!updated) throw notFound("Organization");

      await app.audit(request, {
        action: "UPDATE",
        entityType: "organization",
        entityId: organization.id,
        metadata: { fields: Object.keys(patch) }
      });
      return { organization: updated };
    }
  );

  app.get("/organizations/current/settings", memberGuards, async (request) => {
    const settings = await getAuth(request).repos.organizations.getSettings(getOrganization(request).id);
    if (!settings) throw notFound("Organization settings");
    return { settings };
  });

  app.patch(
    "/organizations/current/settings",
    { preHandler: [app.authenticate, app.requireOrganization, requirePermission("settings:update")] },
    async (request) => {
      const organization = getOrganization(request);
      const input = compact(parseWith(organizationSettingsUpdateSchema, request.body));

      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        patch[SETTINGS_COLUMN_MAP[key as keyof typeof SETTINGS_COLUMN_MAP]] = value;
      }

      const settings = await getAuth(request).repos.organizations.updateSettings(organization.id, patch);
      if (!settings) throw notFound("Organization settings");

      await app.audit(request, {
        action: "UPDATE",
        entityType: "organization_settings",
        entityId: organization.id,
        metadata: { changes: input }
      });
      return { settings };
    }
  );

  /** Only the current OWNER. The target must already be a member; old OWNER becomes ADMIN. */
  app.post(
    "/organizations/current/transfer-ownership",
    {
      preHandler: [app.authenticate, app.requireOrganization, requirePermission("organization:transfer-ownership")]
    },
    async (request) => {
      const auth = getAuth(request);
      const organization = getOrganization(request);
      const { newOwnerUserId } = parseWith(transferOwnershipSchema, request.body);

      if (newOwnerUserId === auth.user.id) {
        throw unprocessable("You already own this organization", "ALREADY_OWNER");
      }

      await auth.repos.organizations.transferOwnership(organization.id, newOwnerUserId);
      await app.audit(request, {
        action: "OWNERSHIP_TRANSFER",
        entityType: "organization",
        entityId: organization.id,
        metadata: { previousOwnerUserId: auth.user.id, newOwnerUserId }
      });

      return { organizationId: organization.id, ownerUserId: newOwnerUserId, yourRole: "ADMIN" };
    }
  );
}
