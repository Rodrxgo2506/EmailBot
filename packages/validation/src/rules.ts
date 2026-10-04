import { RULE_MATCH_MODES } from "@emailbot/types";
import { z } from "zod";
import { idSchema } from "./common.js";
import { validateUserRegex } from "./regex-safety.js";

/*
 * Rule conditions/actions are stored as JSONB in public.email_rules:
 *
 *   conditions = { "conditions": RuleCondition[] }
 *   actions    = { "actions":    RuleAction[] }
 *
 * The category assigned by a rule lives in the email_rules.category_id
 * column (foreign key, ON DELETE SET NULL) instead of inside the JSON, so
 * deleting a category can never leave a dangling reference.
 */

export const RULE_FIELDS = ["sender", "recipient", "subject", "body", "date", "attachment"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "regex",
  "exists",
  "not_exists",
  // Date-only comparisons.
  "before",
  "after"
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const VALUELESS_OPERATORS: ReadonlySet<RuleOperator> = new Set(["exists", "not_exists"]);
export const DATE_ONLY_OPERATORS: ReadonlySet<RuleOperator> = new Set(["before", "after"]);

export const MAX_RULE_CONDITIONS = 25;
export const MAX_RULE_ACTIONS = 20;

export const ruleConditionSchema = z
  .object({
    field: z.enum(RULE_FIELDS),
    operator: z.enum(RULE_OPERATORS),
    value: z.string().max(500).optional(),
    caseSensitive: z.boolean().optional()
  })
  .superRefine((condition, ctx) => {
    if (VALUELESS_OPERATORS.has(condition.operator)) {
      return;
    }

    if (condition.value === undefined || condition.value.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `Operator "${condition.operator}" requires a value`
      });
      return;
    }

    if (DATE_ONLY_OPERATORS.has(condition.operator)) {
      if (condition.field !== "date") {
        ctx.addIssue({
          code: "custom",
          path: ["operator"],
          message: `Operator "${condition.operator}" can only be used with the date field`
        });
      } else if (Number.isNaN(Date.parse(condition.value))) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Value must be a valid date" });
      }
    }

    if (condition.operator === "regex") {
      const error = validateUserRegex(condition.value);
      if (error) {
        ctx.addIssue({ code: "custom", path: ["value"], message: error });
      }
    }
  });

export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const EXTRACT_PRESETS = ["verification_code", "url", "amount", "email"] as const;
export type ExtractPreset = (typeof EXTRACT_PRESETS)[number];

export const EXTRACT_SOURCES = ["subject", "body", "any"] as const;

const extractActionSchema = z
  .object({
    type: z.literal("EXTRACT"),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,49}$/, "Use lowercase letters, digits and underscores"),
    preset: z.enum(EXTRACT_PRESETS).optional(),
    pattern: z.string().max(300).optional(),
    source: z.enum(EXTRACT_SOURCES).default("any")
  })
  .superRefine((action, ctx) => {
    const hasPreset = action.preset !== undefined;
    const hasPattern = action.pattern !== undefined && action.pattern.length > 0;

    if (hasPreset === hasPattern) {
      ctx.addIssue({
        code: "custom",
        path: ["preset"],
        message: "Provide exactly one of preset or pattern"
      });
    }

    if (hasPattern) {
      const error = validateUserRegex(action.pattern as string);
      if (error) {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: error });
      }
    }
  });

export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MARK_IMPORTANT") }),
  z.object({ type: z.literal("MARK_READ") }),
  z.object({ type: z.literal("ARCHIVE") }),
  z.object({
    type: z.literal("NOTIFY"),
    channel: z.enum(["in_app", "email"]).default("in_app"),
    title: z.string().trim().max(200).optional()
  }),
  extractActionSchema
]);

export type RuleAction = z.infer<typeof ruleActionSchema>;

/** Shape of email_rules.conditions JSONB. */
export const ruleConditionsDocumentSchema = z.object({
  conditions: z.array(ruleConditionSchema).max(MAX_RULE_CONDITIONS)
});

/** Shape of email_rules.actions JSONB. */
export const ruleActionsDocumentSchema = z.object({
  actions: z.array(ruleActionSchema).max(MAX_RULE_ACTIONS)
});

const ruleFields = {
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(1000).nullable(),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1_000_000),
  stopProcessing: z.boolean(),
  matchMode: z.enum(RULE_MATCH_MODES),
  categoryId: idSchema.nullable(),
  conditions: z.array(ruleConditionSchema).min(1).max(MAX_RULE_CONDITIONS),
  actions: z.array(ruleActionSchema).max(MAX_RULE_ACTIONS)
};

export const ruleCreateSchema = z.object({
  ...ruleFields,
  description: ruleFields.description.optional(),
  enabled: ruleFields.enabled.default(true),
  priority: ruleFields.priority.default(100),
  stopProcessing: ruleFields.stopProcessing.default(false),
  matchMode: ruleFields.matchMode.default("AND"),
  categoryId: ruleFields.categoryId.optional(),
  actions: ruleFields.actions.default([])
});

export type RuleCreateInput = z.infer<typeof ruleCreateSchema>;

export const ruleUpdateSchema = z
  .object(ruleFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export type RuleUpdateInput = z.infer<typeof ruleUpdateSchema>;

/** Sample email used by "test rule" endpoints. */
export const ruleTestEmailSchema = z.object({
  sender: z.string().trim().min(1).max(320),
  senderName: z.string().max(200).optional(),
  recipients: z.array(z.string().max(320)).max(50).default([]),
  cc: z.array(z.string().max(320)).max(50).default([]),
  subject: z.string().max(1000).default(""),
  body: z.string().max(100_000).default(""),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(500),
        contentType: z.string().max(255).optional()
      })
    )
    .max(50)
    .default([])
});

export type RuleTestEmail = z.infer<typeof ruleTestEmailSchema>;

export const ruleTestRequestSchema = z.object({
  email: ruleTestEmailSchema
});

/** Test an unsaved rule definition. */
export const ruleDraftTestRequestSchema = z.object({
  rule: ruleCreateSchema,
  email: ruleTestEmailSchema
});
