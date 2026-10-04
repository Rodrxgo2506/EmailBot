import {
  DATE_ONLY_OPERATORS,
  EXTRACT_PRESETS,
  RULE_FIELDS,
  RULE_OPERATORS,
  ruleCreateSchema,
  VALUELESS_OPERATORS,
  type ExtractPreset,
  type RuleAction,
  type RuleCondition,
  type RuleCreateInput,
  type RuleField,
  type RuleOperator
} from "@emailbot/validation";
import { z } from "zod";
import type { EmailRule } from "./api";

/*
 * The editor works with a UI-friendly shape (checkboxes for flag actions,
 * a list of extractors) and converts it to the exact payload the API
 * expects: { name, ..., categoryId, conditions[], actions[] }. The payload
 * is validated with the SAME ruleCreateSchema the backend uses. Rule
 * evaluation itself always happens in the backend (POST /api/rules/test).
 */

export const FIELD_LABELS: Record<RuleField, string> = {
  sender: "Remitente",
  recipient: "Destinatario",
  subject: "Asunto",
  body: "Cuerpo",
  date: "Fecha",
  attachment: "Adjunto (nombre)"
};

export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: "es igual a",
  not_equals: "no es igual a",
  contains: "contiene",
  not_contains: "no contiene",
  starts_with: "empieza con",
  ends_with: "termina con",
  regex: "coincide con regex",
  exists: "existe",
  not_exists: "no existe",
  before: "es anterior a",
  after: "es posterior a"
};

export const PRESET_LABELS: Record<ExtractPreset, string> = {
  verification_code: "Código de verificación",
  url: "Primer enlace (URL)",
  amount: "Monto",
  email: "Dirección de correo"
};

export const SOURCE_LABELS = { any: "Asunto y cuerpo", subject: "Solo asunto", body: "Solo cuerpo" } as const;

/** Operators offered for a field (before/after only make sense for dates). */
export function operatorsFor(field: RuleField): RuleOperator[] {
  return RULE_OPERATORS.filter((operator) => field === "date" || !DATE_ONLY_OPERATORS.has(operator));
}

export function operatorNeedsValue(operator: RuleOperator): boolean {
  return !VALUELESS_OPERATORS.has(operator);
}

const conditionFormSchema = z.object({
  field: z.enum(RULE_FIELDS),
  operator: z.enum(RULE_OPERATORS),
  value: z.string().max(500),
  caseSensitive: z.boolean()
});

const extractorFormSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, "Usa minúsculas, números y guiones bajos (ej. verification_code)"),
  mode: z.enum(["preset", "pattern"]),
  preset: z.enum(EXTRACT_PRESETS),
  pattern: z.string().max(300),
  source: z.enum(["any", "subject", "body"])
});

export const ruleFormSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(150),
  description: z.string().max(1000),
  enabled: z.boolean(),
  priority: z.number({ error: "Ingresa un número" }).int().min(0).max(1_000_000),
  stopProcessing: z.boolean(),
  matchMode: z.enum(["AND", "OR"]),
  categoryId: z.string(),
  conditions: z.array(conditionFormSchema).min(1, "Agrega al menos una condición").max(25),
  markImportant: z.boolean(),
  markRead: z.boolean(),
  archive: z.boolean(),
  notify: z.boolean(),
  notifyTitle: z.string().max(200),
  extractors: z.array(extractorFormSchema).max(10)
});

export type RuleFormValues = z.infer<typeof ruleFormSchema>;
export type ConditionFormValue = RuleFormValues["conditions"][number];
export type ExtractorFormValue = RuleFormValues["extractors"][number];

export const emptyCondition = (): ConditionFormValue => ({
  field: "sender",
  operator: "contains",
  value: "",
  caseSensitive: false
});

export const emptyExtractor = (): ExtractorFormValue => ({
  name: "verification_code",
  mode: "preset",
  preset: "verification_code",
  pattern: "",
  source: "any"
});

export function defaultRuleFormValues(): RuleFormValues {
  return {
    name: "",
    description: "",
    enabled: true,
    priority: 100,
    stopProcessing: false,
    matchMode: "AND",
    categoryId: "",
    conditions: [emptyCondition()],
    markImportant: false,
    markRead: false,
    archive: false,
    notify: false,
    notifyTitle: "",
    extractors: []
  };
}

function toCondition(condition: ConditionFormValue): RuleCondition {
  const result: RuleCondition = { field: condition.field, operator: condition.operator };
  if (operatorNeedsValue(condition.operator)) result.value = condition.value;
  if (condition.caseSensitive) result.caseSensitive = true;
  return result;
}

function toActions(values: RuleFormValues): RuleAction[] {
  const actions: RuleAction[] = [];
  if (values.markImportant) actions.push({ type: "MARK_IMPORTANT" });
  if (values.markRead) actions.push({ type: "MARK_READ" });
  if (values.archive) actions.push({ type: "ARCHIVE" });
  for (const extractor of values.extractors) {
    actions.push(
      extractor.mode === "preset"
        ? { type: "EXTRACT", name: extractor.name, preset: extractor.preset, source: extractor.source }
        : { type: "EXTRACT", name: extractor.name, pattern: extractor.pattern, source: extractor.source }
    );
  }
  if (values.notify) {
    const title = values.notifyTitle.trim();
    actions.push(title ? { type: "NOTIFY", channel: "in_app", title } : { type: "NOTIFY", channel: "in_app" });
  }
  return actions;
}

/** Builds the API payload (same shape for POST and PATCH). */
export function toRulePayload(values: RuleFormValues): RuleCreateInput {
  return {
    name: values.name.trim(),
    description: values.description.trim() ? values.description.trim() : null,
    enabled: values.enabled,
    priority: values.priority,
    stopProcessing: values.stopProcessing,
    matchMode: values.matchMode,
    categoryId: values.categoryId || null,
    conditions: values.conditions.map(toCondition),
    actions: toActions(values)
  };
}

export type PayloadValidation =
  | { ok: true; payload: RuleCreateInput }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validates the payload with the backend schema before sending it. */
export function validateRulePayload(values: RuleFormValues): PayloadValidation {
  const parsed = ruleCreateSchema.safeParse(toRulePayload(values));
  if (parsed.success) return { ok: true, payload: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
  };
}

/** Loads a stored rule into the editor. */
export function fromRule(rule: EmailRule): RuleFormValues {
  const values = defaultRuleFormValues();
  values.name = rule.name;
  values.description = rule.description ?? "";
  values.enabled = rule.enabled;
  values.priority = rule.priority;
  values.stopProcessing = rule.stopProcessing;
  values.matchMode = rule.matchMode;
  values.categoryId = rule.categoryId ?? "";
  values.conditions = rule.conditions.map((condition) => ({
    field: condition.field,
    operator: condition.operator,
    value: condition.value ?? "",
    caseSensitive: condition.caseSensitive === true
  }));
  if (values.conditions.length === 0) values.conditions = [emptyCondition()];

  for (const action of rule.actions) {
    switch (action.type) {
      case "MARK_IMPORTANT":
        values.markImportant = true;
        break;
      case "MARK_READ":
        values.markRead = true;
        break;
      case "ARCHIVE":
        values.archive = true;
        break;
      case "NOTIFY":
        values.notify = true;
        values.notifyTitle = action.title ?? "";
        break;
      case "EXTRACT":
        values.extractors.push({
          name: action.name,
          mode: action.preset ? "preset" : "pattern",
          preset: action.preset ?? "verification_code",
          pattern: action.pattern ?? "",
          source: action.source
        });
        break;
    }
  }
  return values;
}

/** Human summary used in the rules list. */
export function describeCondition(condition: RuleCondition): string {
  const value = operatorNeedsValue(condition.operator) ? ` "${condition.value ?? ""}"` : "";
  return `${FIELD_LABELS[condition.field]} ${OPERATOR_LABELS[condition.operator]}${value}`;
}
