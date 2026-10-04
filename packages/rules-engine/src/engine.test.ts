import type { NormalizedEmail } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { evaluateRule, evaluateRules } from "./engine.js";
import { parseRuleRow, sampleToNormalizedEmail } from "./records.js";
import { htmlToText } from "./text.js";
import type { EngineRule } from "./types.js";

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: "GMAIL",
    providerMessageId: "msg-1",
    threadId: "thread-1",
    internetMessageId: "<abc@mail.example.com>",
    accountId: "account-1",
    direction: "INBOUND",
    sender: { address: "info@account.streaming.example", name: "Streaming Service" },
    recipients: [{ address: "me@example.com", name: null }],
    cc: [],
    bcc: [],
    subject: "Tu código temporal de acceso",
    snippet: null,
    textBody: "Hola. Ingresa este código para iniciar sesión: 4821. Vence en 15 minutos.",
    htmlBody: null,
    receivedAt: "2026-10-02T15:30:00.000Z",
    sentAt: null,
    attachments: [],
    headers: {},
    ...overrides
  };
}

function makeRule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "rule-1",
    name: "Rule",
    enabled: true,
    priority: 100,
    stopProcessing: false,
    matchMode: "AND",
    categoryId: null,
    conditions: [],
    actions: [],
    ...overrides
  };
}

const senderCondition = { field: "sender", operator: "contains", value: "streaming.example" } as const;
const subjectCondition = { field: "subject", operator: "contains", value: "código temporal" } as const;
const nonMatchingCondition = { field: "subject", operator: "contains", value: "factura" } as const;

describe("match modes", () => {
  it("AND requires every condition", () => {
    const email = makeEmail();
    const both = makeRule({ conditions: [senderCondition, subjectCondition] });
    const oneFails = makeRule({ conditions: [senderCondition, nonMatchingCondition] });

    expect(evaluateRule(email, both)).toEqual({ matched: true, conditionResults: [true, true], regexTimedOut: false });
    expect(evaluateRule(email, oneFails)).toEqual({ matched: false, conditionResults: [true, false], regexTimedOut: false });
  });

  it("AND does not behave like OR", () => {
    const email = makeEmail();
    const conditions = [senderCondition, nonMatchingCondition];

    expect(evaluateRule(email, makeRule({ matchMode: "OR", conditions })).matched).toBe(true);
    expect(evaluateRule(email, makeRule({ matchMode: "AND", conditions })).matched).toBe(false);
  });

  it("a rule without conditions never matches", () => {
    expect(evaluateRule(makeEmail(), makeRule({ conditions: [], matchMode: "AND" })).matched).toBe(false);
    expect(evaluateRule(makeEmail(), makeRule({ conditions: [], matchMode: "OR" })).matched).toBe(false);
  });
});

describe("evaluateRules", () => {
  it("produces the configured actions for a generic verification-code rule", () => {
    const rule = makeRule({
      categoryId: "category-codes",
      conditions: [senderCondition, subjectCondition],
      actions: [
        { type: "MARK_IMPORTANT" },
        { type: "EXTRACT", name: "verification_code", preset: "verification_code", source: "any" },
        { type: "NOTIFY", channel: "in_app" }
      ]
    });

    const result = evaluateRules(makeEmail(), [rule]);

    expect(result.matched).toBe(true);
    expect(result.categoryId).toBe("category-codes");
    expect(result.markImportant).toBe(true);
    expect(result.extracted).toEqual({ verification_code: "4821" });
    expect(result.notifications).toEqual([{ ruleId: "rule-1", channel: "in_app", title: null }]);
  });

  it("returns no match when nothing matches (email must not be captured)", () => {
    const result = evaluateRules(makeEmail(), [makeRule({ conditions: [nonMatchingCondition] })]);
    expect(result.matched).toBe(false);
    expect(result.primaryRuleId).toBeNull();
  });

  it("never executes disabled rules", () => {
    const disabled = makeRule({
      enabled: false,
      conditions: [senderCondition],
      actions: [{ type: "MARK_IMPORTANT" }]
    });

    const result = evaluateRules(makeEmail(), [disabled]);
    expect(result.matched).toBe(false);
    expect(result.markImportant).toBe(false);
  });

  it("evaluates by priority and the highest-priority category wins", () => {
    const low = makeRule({ id: "low", priority: 200, categoryId: "cat-low", conditions: [senderCondition] });
    const high = makeRule({ id: "high", priority: 10, categoryId: "cat-high", conditions: [senderCondition] });

    const result = evaluateRules(makeEmail(), [low, high]);
    expect(result.primaryRuleId).toBe("high");
    expect(result.categoryId).toBe("cat-high");
    expect(result.matchedRules.map((rule) => rule.id)).toEqual(["high", "low"]);
  });

  it("stop_processing halts evaluation of lower-priority rules", () => {
    const stopper = makeRule({ id: "stopper", priority: 1, stopProcessing: true, conditions: [senderCondition] });
    const later = makeRule({
      id: "later",
      priority: 2,
      conditions: [senderCondition],
      actions: [{ type: "MARK_IMPORTANT" }]
    });

    const result = evaluateRules(makeEmail(), [later, stopper]);
    expect(result.matchedRules.map((rule) => rule.id)).toEqual(["stopper"]);
    expect(result.stoppedByRuleId).toBe("stopper");
    expect(result.markImportant).toBe(false);
  });

  it("stop_processing on a rule that does not match does not stop evaluation", () => {
    const stopper = makeRule({ id: "stopper", priority: 1, stopProcessing: true, conditions: [nonMatchingCondition] });
    const later = makeRule({ id: "later", priority: 2, conditions: [senderCondition] });

    const result = evaluateRules(makeEmail(), [stopper, later]);
    expect(result.matchedRules.map((rule) => rule.id)).toEqual(["later"]);
    expect(result.stoppedByRuleId).toBeNull();
  });

  it("keeps the first extracted value per name (priority order)", () => {
    const first = makeRule({
      id: "a",
      priority: 1,
      conditions: [senderCondition],
      actions: [{ type: "EXTRACT", name: "value", pattern: "iniciar (sesión)", source: "body" }]
    });
    const second = makeRule({
      id: "b",
      priority: 2,
      conditions: [senderCondition],
      actions: [{ type: "EXTRACT", name: "value", pattern: "Vence", source: "body" }]
    });

    expect(evaluateRules(makeEmail(), [second, first]).extracted).toEqual({ value: "sesión" });
  });
});

describe("operators", () => {
  const email = makeEmail({
    recipients: [{ address: "team@example.com", name: null }],
    cc: [{ address: "boss@example.com", name: null }],
    attachments: [
      {
        providerAttachmentId: "att-1",
        filename: "Factura-2026.PDF",
        contentType: "application/pdf",
        size: 100,
        contentId: null,
        isInline: false
      }
    ]
  });

  const check = (condition: EngineRule["conditions"][number], target = email) =>
    evaluateRule(target, makeRule({ conditions: [condition] })).matched;

  it("is case and accent insensitive by default", () => {
    expect(check({ field: "subject", operator: "contains", value: "CODIGO TEMPORAL" })).toBe(true);
    expect(check({ field: "subject", operator: "contains", value: "CODIGO", caseSensitive: true })).toBe(false);
  });

  it("supports equals / not_equals / starts_with / ends_with", () => {
    expect(check({ field: "sender", operator: "equals", value: "INFO@account.streaming.example" })).toBe(true);
    expect(check({ field: "sender", operator: "not_equals", value: "other@example.com" })).toBe(true);
    expect(check({ field: "subject", operator: "starts_with", value: "tu código" })).toBe(true);
    expect(check({ field: "sender", operator: "ends_with", value: "@account.streaming.example" })).toBe(true);
  });

  it("uses any-semantics for positive and none-semantics for negative operators on multi-valued fields", () => {
    expect(check({ field: "recipient", operator: "equals", value: "boss@example.com" })).toBe(true);
    expect(check({ field: "recipient", operator: "not_contains", value: "boss" })).toBe(false);
    expect(check({ field: "recipient", operator: "not_contains", value: "nobody" })).toBe(true);
  });

  it("supports regex", () => {
    expect(check({ field: "body", operator: "regex", value: "\\b\\d{4}\\b" })).toBe(true);
    expect(check({ field: "body", operator: "regex", value: "^nope" })).toBe(false);
  });

  it("supports exists / not_exists for attachments", () => {
    expect(check({ field: "attachment", operator: "exists" })).toBe(true);
    expect(check({ field: "attachment", operator: "ends_with", value: ".pdf" })).toBe(true);
    expect(check({ field: "attachment", operator: "not_exists" }, makeEmail())).toBe(true);
  });

  it("supports date comparisons", () => {
    expect(check({ field: "date", operator: "after", value: "2026-10-01" })).toBe(true);
    expect(check({ field: "date", operator: "before", value: "2026-10-02T00:00:00Z" })).toBe(false);
    expect(check({ field: "date", operator: "equals", value: "2026-10-02" })).toBe(true);
    expect(check({ field: "date", operator: "starts_with", value: "2026-10" })).toBe(true);
  });

  it("falls back to HTML body converted to text", () => {
    const htmlEmail = makeEmail({ textBody: null, htmlBody: "<p>Your code is <b>739201</b></p><style>x{}</style>" });
    expect(check({ field: "body", operator: "contains", value: "code is 739201" }, htmlEmail)).toBe(true);
  });
});

describe("extractors", () => {
  const extract = (email: NormalizedEmail, preset: "verification_code" | "url" | "amount" | "email") =>
    evaluateRules(email, [
      makeRule({
        conditions: [{ field: "subject", operator: "exists" }],
        actions: [{ type: "EXTRACT", name: "v", preset, source: "any" }]
      })
    ]).extracted.v;

  it("finds verification codes in several formats", () => {
    expect(extract(makeEmail({ subject: "Security", textBody: "Your verification code: A7K92Q" }), "verification_code")).toBe(
      "A7K92Q"
    );
    expect(extract(makeEmail({ subject: "Login", textBody: "Use 123-456 as your code" }), "verification_code")).toBe(
      "123456"
    );
    expect(extract(makeEmail({ subject: "Hi", textBody: "Enter 908172 to continue" }), "verification_code")).toBe(
      "908172"
    );
    expect(extract(makeEmail({ subject: "Hi", textBody: "482913 is your login code" }), "verification_code")).toBe(
      "482913"
    );
    expect(extract(makeEmail({ subject: "Hi", textBody: "No numbers here" }), "verification_code")).toBeUndefined();
  });

  it("finds urls, amounts and emails", () => {
    const email = makeEmail({
      subject: "Recibo",
      textBody: "Total: S/ 1,250.90. Ver https://shop.example.com/o/1?x=2 o escribe a soporte@shop.example.com"
    });
    expect(extract(email, "url")).toBe("https://shop.example.com/o/1?x=2");
    expect(extract(email, "amount")).toBe("S/ 1,250.90");
    expect(extract(email, "email")).toBe("soporte@shop.example.com");
  });
});

describe("parseRuleRow", () => {
  const row = {
    id: "r1",
    name: "Codes",
    enabled: true,
    priority: 10,
    stop_processing: false,
    match_mode: "AND" as const,
    category_id: null,
    conditions: { conditions: [senderCondition] },
    actions: { actions: [{ type: "MARK_IMPORTANT" }] }
  };

  it("parses valid JSONB documents", () => {
    const parsed = parseRuleRow(row);
    expect(parsed.ok).toBe(true);
  });

  it("rejects malformed JSONB instead of partially executing it", () => {
    expect(parseRuleRow({ ...row, conditions: { conditions: [{ field: "nope" }] } }).ok).toBe(false);
    expect(parseRuleRow({ ...row, actions: { actions: [{ type: "DELETE_EVERYTHING" }] } }).ok).toBe(false);
  });
});

describe("helpers", () => {
  it("converts a test sample into a NormalizedEmail", () => {
    const email = sampleToNormalizedEmail({
      sender: "Streaming <info@streaming.example>",
      recipients: ["me@example.com"],
      cc: [],
      subject: "Hi",
      body: "Body",
      attachments: []
    });
    expect(email.sender).toEqual({ address: "info@streaming.example", name: "Streaming" });
    expect(email.recipients).toEqual([{ address: "me@example.com", name: null }]);
  });

  it("decodes entities when converting html", () => {
    expect(htmlToText("<div>a&nbsp;&amp;&#39;b&#x41;</div>")).toBe("a &'bA");
  });
});
