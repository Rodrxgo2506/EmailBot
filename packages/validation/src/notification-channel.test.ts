import { describe, expect, it } from "vitest";
import { NOTIFICATION_CHANNELS, ruleActionSchema, ruleActionsDocumentSchema, ruleCreateSchema, withoutLegacyEmailNotifications } from "./index.js";

/*
 * EmailBot V2 phase 7: the never-implemented "email" notification channel is
 * not part of the rules contract anymore. Stored documents saved before keep
 * working without it.
 */

const rule = (actions: unknown[]) => ({
  name: "Codes",
  conditions: [{ field: "sender", operator: "contains", value: "example.com" }],
  actions
});

describe("NOTIFY channel", () => {
  it("only in-app notifications exist", () => {
    expect(NOTIFICATION_CHANNELS).toEqual(["in_app"]);
    expect(ruleActionSchema.parse({ type: "NOTIFY" })).toEqual({ type: "NOTIFY", channel: "in_app" });
    expect(ruleActionSchema.safeParse({ type: "NOTIFY", channel: "in_app", title: "Nuevo" }).success).toBe(true);
  });

  it("new rules cannot ask for email notifications (or any other channel)", () => {
    expect(ruleActionSchema.safeParse({ type: "NOTIFY", channel: "email" }).success).toBe(false);
    expect(ruleActionSchema.safeParse({ type: "NOTIFY", channel: "sms" }).success).toBe(false);
    expect(ruleCreateSchema.safeParse(rule([{ type: "NOTIFY", channel: "email" }])).success).toBe(false);
  });

  it("a stored document with the removed email NOTIFY drops only that action", () => {
    const parsed = ruleActionsDocumentSchema.parse({
      actions: [{ type: "MARK_IMPORTANT" }, { type: "NOTIFY", channel: "email", title: "x" }, { type: "NOTIFY", channel: "in_app" }]
    });
    expect(parsed.actions).toEqual([{ type: "MARK_IMPORTANT" }, { type: "NOTIFY", channel: "in_app" }]);
  });

  it("stored documents are otherwise validated as before", () => {
    expect(ruleActionsDocumentSchema.safeParse({ actions: [{ type: "NOTIFY", channel: "sms" }] }).success).toBe(false);
    expect(ruleActionsDocumentSchema.safeParse({ actions: [{ type: "DELETE_EVERYTHING" }] }).success).toBe(false);
    expect(ruleActionsDocumentSchema.safeParse({ actions: "nope" }).success).toBe(false);
    expect(withoutLegacyEmailNotifications("nope")).toBe("nope");
  });
});
