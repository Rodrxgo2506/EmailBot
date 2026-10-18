import { describe, expect, it } from "vitest";
import { canPayCurrentPlanByCard } from "./checkout-policy";

/* Same-plan rule of the API checkout policy (decideCheckout): who may move the current plan to card payments. */

describe("canPayCurrentPlanByCard", () => {
  it("a legacy plan can move to card payments", () => {
    expect(canPayCurrentPlanByCard("LEGACY", null)).toBe(true);
    expect(canPayCurrentPlanByCard("LEGACY", undefined)).toBe(true);
  });

  it.each(["YAPE", "CASH", "TRANSFER", "MANUAL"] as const)("a subscription paid manually (%s) can move to card payments", (method) => {
    expect(canPayCurrentPlanByCard("SUBSCRIPTION", method)).toBe(true);
  });

  it("a subscription already paid by card (Culqi) is not offered again", () => {
    expect(canPayCurrentPlanByCard("SUBSCRIPTION", "CULQI")).toBe(false);
  });

  it("without commercial access there is no current plan to pay (every plan is a purchase)", () => {
    expect(canPayCurrentPlanByCard("NONE", null)).toBe(false);
  });
});
