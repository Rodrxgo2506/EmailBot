import { categoryCreateSchema, categoryUpdateSchema, idParamsSchema, slugify } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import { conflict, notFound } from "../../lib/errors.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import type { CategoryInsert } from "../../repositories/types.js";

export async function categoryRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("categories:read")] };
  const manage = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("categories:manage")] };

  app.get("/categories", read, async (request) => {
    return { items: await getAuth(request).repos.categories.list(getOrganization(request).id) };
  });

  app.get("/categories/:id", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const category = await getAuth(request).repos.categories.get(getOrganization(request).id, id);
    if (!category) throw notFound("Category");
    return { category };
  });

  app.post("/categories", manage, async (request, reply) => {
    const input = parseWith(categoryCreateSchema, request.body);
    const insert: CategoryInsert = {
      name: input.name,
      slug: input.slug ?? (slugify(input.name) || "category"),
      sort_order: input.sortOrder
    };
    if (input.description !== undefined) insert.description = input.description;
    if (input.color !== undefined) insert.color = input.color;
    if (input.icon !== undefined) insert.icon = input.icon;

    const category = await getAuth(request).repos.categories.create(getOrganization(request).id, insert);
    await app.audit(request, {
      action: "CREATE",
      entityType: "category",
      entityId: category.id,
      metadata: { name: category.name }
    });
    return reply.status(201).send({ category });
  });

  app.patch("/categories/:id", manage, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const input = parseWith(categoryUpdateSchema, request.body);

    const patch: Partial<CategoryInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.description !== undefined) patch.description = input.description;
    if (input.color !== undefined) patch.color = input.color;
    if (input.icon !== undefined) patch.icon = input.icon;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;

    const category = await getAuth(request).repos.categories.update(getOrganization(request).id, id, patch);
    if (!category) throw notFound("Category");

    await app.audit(request, {
      action: "UPDATE",
      entityType: "category",
      entityId: id,
      metadata: { fields: Object.keys(patch) }
    });
    return { category };
  });

  /** Rules pointing to the category keep working without it (ON DELETE SET NULL). */
  app.delete("/categories/:id", manage, async (request, reply) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const repos = getAuth(request).repos;
    const organizationId = getOrganization(request).id;

    const category = await repos.categories.get(organizationId, id);
    if (!category) throw notFound("Category");
    if (category.isSystem) throw conflict("System categories cannot be deleted", "SYSTEM_CATEGORY");

    await repos.categories.remove(organizationId, id);
    await app.audit(request, {
      action: "DELETE",
      entityType: "category",
      entityId: id,
      metadata: { name: category.name }
    });
    return reply.status(204).send();
  });
}
