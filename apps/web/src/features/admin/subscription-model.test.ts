import type { AdminPlanPrice, AdminSubscription } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import {
  activationProblem,
  addPeriod,
  availableActions,
  currentSubscription,
  defaultActivation,
  limaDate,
  limaStartOfDay,
  toActivation
} from "./subscription-model";

const prices: AdminPlanPrice[] = [
  { id: "1", plan: "BASIC", planName: "Básico", billingPeriod: "MONTHLY", currency: "PEN", amount: "19.90", amountCents: 1990 },
  { id: "2", plan: "PRO", planName: "Pro", billingPeriod: "YEARLY", currency: "PEN", amount: "399.00", amountCents: 39900 }
];

const subscription = (overrides: Partial<AdminSubscription> = {}): AdminSubscription => ({
  id: "s1",
  status: "ACTIVE",
  plan: "PRO",
  billingPeriod: "YEARLY",
  currency: "PEN",
  listAmount: "399.00",
  paymentMethod: "CASH",
  origin: "ADMIN",
  startedAt: "2026-10-06T05:00:00.000Z",
  currentPeriodStart: "2026-10-06T05:00:00.000Z",
  currentPeriodEnd: "2027-10-06T05:00:00.000Z",
  canceledAt: null,
  suspendedAt: null,
  expiredAt: null,
  createdAt: "2026-10-06T05:00:00.000Z",
  updatedAt: "2026-10-06T05:00:00.000Z",
  ...overrides
});

const NOW = new Date("2026-10-06T15:00:00Z");

describe("dates (calendar days in Lima)", () => {
  it("today in Lima, and 00:00 Lima as an ISO instant", () => {
    expect(limaDate(new Date("2026-10-07T03:00:00Z"))).toBe("2026-10-06"); // still the 6th in Lima (UTC-5)
    expect(limaStartOfDay("2026-10-06")).toBe("2026-10-06T00:00:00-05:00");
  });

  it("one month / one year later; month ends are clamped", () => {
    expect(addPeriod("2026-10-06", "MONTHLY")).toBe("2026-11-06");
    expect(addPeriod("2026-11-06", "MONTHLY")).toBe("2026-12-06");
    expect(addPeriod("2026-12-15", "MONTHLY")).toBe("2027-01-15");
    expect(addPeriod("2027-01-31", "MONTHLY")).toBe("2027-02-28");
    expect(addPeriod("2026-10-06", "YEARLY")).toBe("2027-10-06");
    expect(addPeriod("2028-02-29", "YEARLY")).toBe("2029-02-28");
  });
});

describe("current subscription and allowed actions (mirrors the database state machine)", () => {
  it("the open one is current; history is not", () => {
    expect(currentSubscription([subscription({ id: "old", status: "EXPIRED", expiredAt: "x" }), subscription()])?.id).toBe("s1");
    expect(currentSubscription([subscription({ status: "CANCELED", canceledAt: "x" })])).toBeNull();
  });

  it.each([
    ["ACTIVE", "2027-10-06T05:00:00.000Z", ["suspend", "cancel"]],
    ["ACTIVE", "2026-10-01T05:00:00.000Z", ["suspend", "expire", "cancel"]],
    ["SUSPENDED", "2027-10-06T05:00:00.000Z", ["reactivate", "cancel"]],
    ["SUSPENDED", "2026-10-01T05:00:00.000Z", ["expire", "cancel"]],
    ["PAST_DUE", "2027-10-06T05:00:00.000Z", ["suspend", "reactivate", "cancel"]],
    ["CANCELED", "2027-10-06T05:00:00.000Z", []],
    ["EXPIRED", "2026-10-01T05:00:00.000Z", []]
  ] as const)("%s ending %s -> %j", (status, currentPeriodEnd, actions) => {
    expect(availableActions(subscription({ status, currentPeriodEnd }), NOW)).toEqual(actions);
  });
});

describe("activation form", () => {
  it("no subscription: Básico mensual at list price, from today for one month", () => {
    expect(defaultActivation(null, prices, NOW)).toEqual({
      plan: "BASIC",
      billingPeriod: "MONTHLY",
      paymentMethod: "YAPE",
      amount: "19.90",
      start: "2026-10-06",
      end: "2026-11-06",
      reference: "",
      note: ""
    });
  });

  it("renewal: same plan and period, starting when the paid period ends", () => {
    expect(defaultActivation(subscription(), prices, NOW)).toMatchObject({ plan: "PRO", billingPeriod: "YEARLY", amount: "399.00", start: "2027-10-06", end: "2028-10-06" });
  });

  it("validates before calling the API and sends a decimal string with Lima dates", () => {
    const form = defaultActivation(null, prices, NOW);
    expect(activationProblem(form)).toBeNull();
    expect(activationProblem({ ...form, amount: "39,90" })).toMatch(/importe/);
    expect(activationProblem({ ...form, amount: "0" })).toMatch(/importe/);
    expect(activationProblem({ ...form, end: form.start })).toMatch(/posterior/);
    expect(toActivation({ ...form, reference: "  OP-1 ", note: " " })).toEqual({
      plan: "BASIC",
      billingPeriod: "MONTHLY",
      paymentMethod: "YAPE",
      amount: "19.90",
      periodStart: "2026-10-06T00:00:00-05:00",
      periodEnd: "2026-11-06T00:00:00-05:00",
      reference: "OP-1"
    });
  });
});
