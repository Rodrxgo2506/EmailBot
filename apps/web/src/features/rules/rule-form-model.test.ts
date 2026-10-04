import { ruleConditionsDocumentSchema, ruleActionsDocumentSchema } from "@emailbot/validation";
import { describe, expect, it } from "vitest";
import type { EmailRule } from "./api";
import {
  defaultRuleFormValues,
  describeCondition,
  fromRule,
  operatorsFor,
  ruleFormSchema,
  toRulePayload,
  validateRulePayload,
  type RuleFormValues
} from "./rule-form-model";

const CATEGORY = "77777777-7777-4777-8777-777777777777";

function codesRule(): RuleFormValues {
  return {
    ...defaultRuleFormValues(),
    name: "Códigos de acceso",
    categoryId: CATEGORY,
    stopProcessing: true,
    conditions: [
      { field: "sender", operator: "contains", value: "streaming.example", caseSensitive: false },
      { field: "subject", operator: "contains", value: "código temporal", caseSensitive: false },
      { field: "attachment", operator: "not_exists", value: "ignored", caseSensitive: false }
    ],
    markImportant: true,
    notify: true,
    extractors: [{ name: "verification_code", mode: "preset", preset: "verification_code", pattern: "", source: "any" }]
  };
}

describe("rule form model", () => {
  it("produces exactly the payload expected by the API", () => {
    expect(toRulePayload(codesRule())).toEqual({
      name: "Códigos de acceso",
      description: null,
      enabled: true,
      priority: 100,
      stopProcessing: true,
      matchMode: "AND",
      categoryId: CATEGORY,
      botId: null,
      conditions: [
        { field: "sender", operator: "contains", value: "streaming.example" },
        { field: "subject", operator: "contains", value: "código temporal" },
        { field: "attachment", operator: "not_exists" }
      ],
      actions: [
        { type: "MARK_IMPORTANT" },
        { type: "EXTRACT", name: "verification_code", preset: "verification_code", source: "any" },
        { type: "NOTIFY", channel: "in_app" }
      ]
    });
  });

  it("sends the bot of the rule and loads it back (empty = general rule)", () => {
    const BOT = "88888888-8888-4888-8888-888888888888";
    expect(toRulePayload({ ...codesRule(), botId: BOT }).botId).toBe(BOT);
    expect(toRulePayload({ ...codesRule(), botId: "" }).botId).toBeNull();
    const result = validateRulePayload({ ...codesRule(), botId: BOT });
    expect(result.ok && result.payload.botId).toBe(BOT);
  });

  it("passes the backend schema and the JSONB document schemas", () => {
    const result = validateRulePayload(codesRule());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ruleConditionsDocumentSchema.safeParse({ conditions: result.payload.conditions }).success).toBe(true);
    expect(ruleActionsDocumentSchema.safeParse({ actions: result.payload.actions }).success).toBe(true);
  });

  it("reports backend validation issues (e.g. dangerous regex)", () => {
    const values = codesRule();
    values.conditions = [{ field: "body", operator: "regex", value: "(a+)+", caseSensitive: false }];
    const result = validateRulePayload(values);
    expect(result.ok).toBe(false);
  });

  it("round-trips a stored rule", () => {
    const payload = toRulePayload(codesRule());
    const stored: EmailRule = {
      id: "r1",
      organizationId: "o1",
      categoryId: payload.categoryId ?? null,
      botId: payload.botId ?? null,
      name: payload.name,
      description: null,
      enabled: payload.enabled,
      priority: payload.priority,
      stopProcessing: payload.stopProcessing,
      matchMode: payload.matchMode,
      conditions: payload.conditions,
      actions: payload.actions,
      createdBy: null,
      updatedBy: null,
      createdAt: "",
      updatedAt: ""
    };
    expect(toRulePayload(fromRule(stored))).toEqual(payload);
    expect(ruleFormSchema.safeParse(fromRule(stored)).success).toBe(true);
  });

  it("supports custom regex extractors and OR mode", () => {
    const values = { ...defaultRuleFormValues(), name: "Facturas", matchMode: "OR" as const };
    values.conditions = [{ field: "subject", operator: "contains", value: "factura", caseSensitive: true }];
    values.extractors = [{ name: "invoice", mode: "pattern", preset: "verification_code", pattern: "N° (\\d+)", source: "subject" }];
    const payload = toRulePayload(values);
    expect(payload.matchMode).toBe("OR");
    expect(payload.conditions[0]).toEqual({ field: "subject", operator: "contains", value: "factura", caseSensitive: true });
    expect(payload.actions).toEqual([{ type: "EXTRACT", name: "invoice", pattern: "N° (\\d+)", source: "subject" }]);
  });

  it("offers before/after only for dates and describes conditions", () => {
    expect(operatorsFor("subject")).not.toContain("before");
    expect(operatorsFor("date")).toContain("after");
    expect(describeCondition({ field: "subject", operator: "contains", value: "x" })).toBe('Asunto contiene "x"');
  });
});
