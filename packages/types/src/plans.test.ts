import { describe, expect, it } from "vitest";
import { ORGANIZATION_PLANS } from "./enums.js";
import {
  COMMERCIAL_PLANS,
  LEGACY_PLANS,
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHODS,
  PLAN_ACCESS,
  PLAN_LIMIT_KEYS,
  PLAN_USAGE_KEYS,
  SUBSCRIPTION_STATUSES,
  isCommercialPlan
} from "./plans.js";

describe("Commercial V1 plans", () => {
  it("sells BASIC, PRO and BUSINESS; there is no free plan", () => {
    expect(COMMERCIAL_PLANS).toEqual(["BASIC", "PRO", "BUSINESS"]);
    expect(isCommercialPlan("FREE")).toBe(false);
    for (const plan of COMMERCIAL_PLANS) expect(isCommercialPlan(plan)).toBe(true);
  });

  it("organizations.plan mirrors the database enum: legacy FREE + the commercial plans", () => {
    expect(ORGANIZATION_PLANS).toEqual(["FREE", "BASIC", "PRO", "BUSINESS"]);
    expect([...LEGACY_PLANS, ...COMMERCIAL_PLANS]).toEqual([...ORGANIZATION_PLANS]);
  });

  it("every measured usage is a limit; retention is a limit without usage", () => {
    for (const key of PLAN_USAGE_KEYS) expect(PLAN_LIMIT_KEYS).toContain(key);
    expect(PLAN_USAGE_KEYS).not.toContain("RETENTION_DAYS");
  });
});

describe("Commercial V1.1 subscriptions", () => {
  it("mirrors the database enums; CULQI is never a manual payment; no trial / free state", () => {
    expect(SUBSCRIPTION_STATUSES).toEqual(["ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELED", "EXPIRED"]);
    expect(PAYMENT_METHODS).toEqual(["CULQI", "YAPE", "CASH", "TRANSFER", "MANUAL"]);
    expect(MANUAL_PAYMENT_METHODS).toEqual(["YAPE", "CASH", "TRANSFER", "MANUAL"]);
    expect(PLAN_ACCESS).toEqual(["SUBSCRIPTION", "LEGACY", "NONE"]);
    expect(SUBSCRIPTION_STATUSES.join()).not.toMatch(/TRIAL|FREE/);
  });
});
