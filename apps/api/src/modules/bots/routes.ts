import type { Bot } from "@emailbot/types";
import { botCreateSchema, botUpdateSchema, idParamsSchema, slugify } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import { conflict, notFound } from "../../lib/errors.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import type { BotWrite } from "../../repositories/types.js";
import { requestEntitlements } from "../plans/entitlements.js";

/*
 * Bots (EmailBot V2, phase 1). Organization-scoped; RLS repeats the role
 * checks (OWNER/ADMIN write, every member reads). Audit events use the
 * existing actions with metadata.event (bot.created, bot.updated,
 * bot.paused, bot.resumed, bot.deleted).
 */

function statusEvent(before: Bot, after: Bot): "bot.paused" | "bot.resumed" | null {
  if (before.status === after.status) return null;
  return after.status === "PAUSED" ? "bot.paused" : "bot.resumed";
}

export async function botRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("bots:read")] };
  const manage = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("bots:manage")] };

  app.get("/bots", read, async (request) => {
    return { items: await getAuth(request).repos.bots.list(getOrganization(request).id) };
  });

  app.get("/bots/:id", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const bot = await getAuth(request).repos.bots.get(getOrganization(request).id, id);
    if (!bot) throw notFound("Bot");
    return { bot };
  });

  app.post("/bots", manage, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseWith(botCreateSchema, request.body);
    const insert: BotWrite & { name: string; slug: string } = {
      name: input.name,
      slug: input.slug ?? (slugify(input.name) || "bot"),
      status: input.status
    };
    if (input.description !== undefined) insert.description = input.description;
    if (input.customerResolution !== undefined) insert.customerResolution = input.customerResolution;
    if (input.portalSettings !== undefined) insert.portalSettings = input.portalSettings;
    // Commercial V1: the BOTS limit counts ACTIVE bots (a bot with emails can only be paused).
    if (insert.status === "ACTIVE") await requestEntitlements(request).assertWithinLimit("BOTS");

    const bot = await auth.repos.bots.create(getOrganization(request).id, auth.user.id, insert);
    await app.audit(request, {
      action: "CREATE",
      entityType: "bot",
      entityId: bot.id,
      metadata: { event: "bot.created", name: bot.name, status: bot.status }
    });
    return reply.status(201).send({ bot });
  });

  app.patch("/bots/:id", manage, async (request) => {
    const auth = getAuth(request);
    const organizationId = getOrganization(request).id;
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const input = parseWith(botUpdateSchema, request.body);

    const before = await auth.repos.bots.get(organizationId, id);
    if (!before) throw notFound("Bot");

    const patch: BotWrite = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.description !== undefined) patch.description = input.description;
    if (input.status !== undefined) patch.status = input.status;
    if (input.customerResolution !== undefined) patch.customerResolution = input.customerResolution;
    if (input.portalSettings !== undefined) patch.portalSettings = input.portalSettings;
    if (before.status !== "ACTIVE" && patch.status === "ACTIVE") await requestEntitlements(request).assertWithinLimit("BOTS");

    const bot = await auth.repos.bots.update(organizationId, id, auth.user.id, patch);
    if (!bot) throw notFound("Bot");

    const fields = Object.keys(patch);
    const status = statusEvent(before, bot);
    if (status) {
      await app.audit(request, { action: "UPDATE", entityType: "bot", entityId: id, metadata: { event: status, name: bot.name } });
    }
    if (fields.some((field) => field !== "status")) {
      await app.audit(request, {
        action: "UPDATE",
        entityType: "bot",
        entityId: id,
        metadata: { event: "bot.updated", fields: fields.filter((field) => field !== "status") }
      });
    }
    return { bot };
  });

  /**
   * Only bots without routed emails can be deleted: pausing keeps the history
   * (deleting would clear emails.bot_id). Rules of a deleted bot become
   * general rules (ON DELETE SET NULL (bot_id)).
   */
  app.delete("/bots/:id", manage, async (request, reply) => {
    const repos = getAuth(request).repos;
    const organizationId = getOrganization(request).id;
    const { id } = parseWith(idParamsSchema, request.params, "params");

    const bot = await repos.bots.get(organizationId, id);
    if (!bot) throw notFound("Bot");
    if (await repos.bots.hasEmails(organizationId, id)) {
      throw conflict("This bot already has processed emails; pause it to keep its history", "BOT_HAS_EMAILS");
    }
    // The database blocks it too (NO ACTION foreign keys): nothing is deleted or widened silently.
    if (await repos.bots.hasCustomerLinks(organizationId, id)) {
      throw conflict("Remove the bot's customers and bot-scoped identifiers before deleting it", "BOT_IN_USE");
    }

    await repos.bots.remove(organizationId, id);
    await app.audit(request, { action: "DELETE", entityType: "bot", entityId: id, metadata: { event: "bot.deleted", name: bot.name } });
    return reply.status(204).send();
  });
}
