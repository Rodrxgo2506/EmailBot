import {
  createEvaluationContext,
  evaluateRule,
  evaluateRules,
  sampleToNormalizedEmail,
  type EngineRule
} from "@emailbot/rules-engine";
import {
  idParamsSchema,
  ruleCreateSchema,
  ruleDraftTestRequestSchema,
  ruleTestRequestSchema,
  ruleUpdateSchema,
  type RuleTestEmail
} from "@emailbot/validation";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { notFound, unprocessable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { compact, parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import type { EmailRule, RuleWrite } from "../../repositories/types.js";

/** A rule may only reference a category of the same organization. */
async function assertCategoryInOrganization(request: FastifyRequest, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const category = await getAuth(request).repos.categories.get(getOrganization(request).id, categoryId);
  if (!category) throw unprocessable("Category not found in this organization", "INVALID_CATEGORY");
}

function runTest(rule: EngineRule, sample: RuleTestEmail) {
  const email = sampleToNormalizedEmail(sample);
  // One context per request: user regexes share a single time budget.
  const context = createEvaluationContext();
  const evaluation = evaluateRule(email, rule, context);
  // Actions are computed as if the rule were enabled, so disabled rules can be tested too.
  const outcome = evaluateRules(email, [{ ...rule, enabled: true }], context);

  return {
    matched: evaluation.matched,
    enabled: rule.enabled,
    /** A user regex was too expensive and was stopped (treated as no match). */
    regexTimedOut: outcome.regexTimedOut || evaluation.regexTimedOut,
    conditionResults: rule.conditions.map((condition, index) => ({
      condition,
      matched: evaluation.conditionResults[index] ?? false
    })),
    actions: evaluation.matched
      ? {
          categoryId: outcome.categoryId,
          markImportant: outcome.markImportant,
          markRead: outcome.markRead,
          archive: outcome.archive,
          notify: outcome.notifications.length > 0,
          extracted: outcome.extracted
        }
      : null
  };
}

function toEngineRule(rule: EmailRule): EngineRule {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    stopProcessing: rule.stopProcessing,
    matchMode: rule.matchMode,
    categoryId: rule.categoryId,
    conditions: rule.conditions,
    actions: rule.actions,
    createdAt: rule.createdAt
  };
}

export async function ruleRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("rules:read")] };
  const test = { ...read, config: { rateLimit: RATE_LIMITS.ruleTest } };
  const manage = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("rules:manage")] };

  app.get("/rules", read, async (request) => {
    return { items: await getAuth(request).repos.rules.list(getOrganization(request).id) };
  });

  app.get("/rules/:id", read, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const rule = await getAuth(request).repos.rules.get(getOrganization(request).id, id);
    if (!rule) throw notFound("Rule");
    return { rule };
  });

  app.post("/rules", manage, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseWith(ruleCreateSchema, request.body);
    await assertCategoryInOrganization(request, input.categoryId);

    const rule = await auth.repos.rules.create(getOrganization(request).id, auth.user.id, compact(input) as RuleWrite & {
      name: string;
    });

    await app.audit(request, {
      action: "CREATE",
      entityType: "email_rule",
      entityId: rule.id,
      metadata: { name: rule.name, enabled: rule.enabled, priority: rule.priority }
    });
    return reply.status(201).send({ rule });
  });

  /** Edit, enable/disable and change priority. */
  app.patch("/rules/:id", manage, async (request) => {
    const auth = getAuth(request);
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const patch = compact(parseWith(ruleUpdateSchema, request.body)) as RuleWrite;
    await assertCategoryInOrganization(request, patch.categoryId);

    const rule = await auth.repos.rules.update(getOrganization(request).id, id, auth.user.id, patch);
    if (!rule) throw notFound("Rule");

    await app.audit(request, {
      action: "UPDATE",
      entityType: "email_rule",
      entityId: id,
      metadata: {
        fields: Object.keys(patch),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {})
      }
    });
    return { rule };
  });

  app.delete("/rules/:id", manage, async (request, reply) => {
    const auth = getAuth(request);
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const organizationId = getOrganization(request).id;

    const rule = await auth.repos.rules.get(organizationId, id);
    if (!rule) throw notFound("Rule");

    await auth.repos.rules.remove(organizationId, id);
    await app.audit(request, { action: "DELETE", entityType: "email_rule", entityId: id, metadata: { name: rule.name } });
    return reply.status(204).send();
  });

  /** Tests a saved rule against a sample email. Nothing is persisted. */
  app.post("/rules/:id/test", test, async (request) => {
    const { id } = parseWith(idParamsSchema, request.params, "params");
    const { email } = parseWith(ruleTestRequestSchema, request.body);
    const rule = await getAuth(request).repos.rules.get(getOrganization(request).id, id);
    if (!rule) throw notFound("Rule");
    return runTest(toEngineRule(rule), email);
  });

  /** Tests an unsaved rule definition (rule editor preview). */
  app.post("/rules/test", test, async (request) => {
    const { rule, email } = parseWith(ruleDraftTestRequestSchema, request.body);
    return runTest(
      {
        id: "draft",
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        stopProcessing: rule.stopProcessing,
        matchMode: rule.matchMode,
        categoryId: rule.categoryId ?? null,
        conditions: rule.conditions,
        actions: rule.actions
      },
      email
    );
  });
}
