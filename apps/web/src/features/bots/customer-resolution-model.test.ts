import { describe, expect, it } from "vitest";
import type { EmailRule } from "@/features/rules/api";
import { deliveryEnabled, extractedFieldNames, resolutionError, toResolutionForm, toResolutionPayload } from "./customer-resolution-model";

describe("customer resolution model", () => {
  it("the default bot configuration (NONE) means no delivery; any other source delivers", () => {
    expect(deliveryEnabled({ source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" })).toBe(false);
    expect(deliveryEnabled(undefined)).toBe(false);
    expect(deliveryEnabled({ source: "RECIPIENT", identifierType: "EMAIL", onMultipleMatches: "LEAVE_UNASSIGNED" })).toBe(true);
  });

  it("payload keeps only the keys the source accepts (the API schema is strict)", () => {
    const form = { ...toResolutionForm({ source: "EXTRACTED_FIELD", field: "code", identifierType: "PHONE", onMultipleMatches: "DELIVER_ALL" }) };
    expect(toResolutionPayload(form)).toEqual({ source: "EXTRACTED_FIELD", field: "code", identifierType: "PHONE", onMultipleMatches: "DELIVER_ALL" });
    expect(toResolutionPayload({ ...form, source: "SENDER" })).toEqual({ source: "SENDER", onMultipleMatches: "DELIVER_ALL" });
    expect(toResolutionPayload({ ...form, source: "NONE" })).toEqual({ source: "NONE", onMultipleMatches: "DELIVER_ALL" });
    expect(resolutionError({ ...form, source: "RECIPIENT" })).toBeNull();
  });

  it("EXTRACTED_FIELD requires a valid field name", () => {
    const form = toResolutionForm({ source: "EXTRACTED_FIELD", field: "code", identifierType: "EMAIL", onMultipleMatches: "LEAVE_UNASSIGNED" });
    expect(resolutionError(form)).toBeNull();
    expect(resolutionError({ ...form, field: " " })).toMatch(/Elige el dato/);
    expect(resolutionError({ ...form, field: "Not Valid" })).toMatch(/no es válida/);
  });

  it("extracted field names come only from EXTRACT actions of the bot's own rules", () => {
    const rule = (botId: string | null, actions: EmailRule["actions"]) => ({ botId, actions }) as EmailRule;
    const rules = [
      rule("bot-1", [{ type: "EXTRACT", name: "code", source: "any" }, { type: "MARK_IMPORTANT" }]),
      rule("bot-1", [{ type: "EXTRACT", name: "account", source: "any" }, { type: "EXTRACT", name: "code", source: "body" }]),
      rule("bot-2", [{ type: "EXTRACT", name: "other", source: "any" }]),
      rule(null, [{ type: "EXTRACT", name: "general", source: "any" }])
    ];
    expect(extractedFieldNames(rules, "bot-1")).toEqual(["account", "code"]);
  });
});
