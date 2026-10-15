import { describe, expect, it } from "vitest";
import { billingCheckoutQuerySchema, billingSubscriptionCreateSchema, culqiWebhookBodySchema } from "./billing.js";

const valid = {
  plan: "PRO",
  billingPeriod: "MONTHLY",
  tokenId: "tkn_test_vEcZSCOVz5PGDPdQ",
  acceptTerms: true,
  customer: { firstName: "Ana María", lastName: "Pérez", phoneNumber: "999888777", address: "Av. Lima 123", addressCity: "Lima", countryCode: "pe" }
};

describe("billing input (the browser never decides the price)", () => {
  it("a valid checkout body: plan, period, card token, accepted terms and Culqi's customer fields", () => {
    expect(billingSubscriptionCreateSchema.parse(valid)).toMatchObject({ plan: "PRO", customer: { countryCode: "PE" } });
  });

  it.each([
    ["amount", { amount: 1 }],
    ["currency", { currency: "USD" }],
    ["price", { price: "0.01" }],
    ["limits", { limits: { EMAIL_ACCOUNTS: 999 } }],
    ["entitlements", { entitlements: {} }],
    ["card number", { cardNumber: "4111111111111111" }],
    ["cvv", { cvv: "123" }]
  ])("rejects a client-sent %s (strict body)", (_label, extra) => {
    expect(billingSubscriptionCreateSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
  });

  it("requires a Culqi token, an EmailBot plan / period and the explicit acceptance of the terms", () => {
    for (const body of [
      { ...valid, tokenId: undefined },
      { ...valid, tokenId: "4111111111111111" },
      { ...valid, plan: "FREE" },
      { ...valid, billingPeriod: "WEEKLY" },
      { ...valid, acceptTerms: false },
      { ...valid, customer: { ...valid.customer, firstName: "R2-D2" } },
      { ...valid, customer: { ...valid.customer, phoneNumber: "12" } },
      { ...valid, customer: { ...valid.customer, email: "x@y.z" } }
    ]) {
      expect(billingSubscriptionCreateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("checkout query: plan and period only", () => {
    expect(billingCheckoutQuerySchema.parse({ plan: "BUSINESS", billingPeriod: "YEARLY" })).toEqual({ plan: "BUSINESS", billingPeriod: "YEARLY" });
    expect(billingCheckoutQuerySchema.safeParse({ plan: "BUSINESS", billingPeriod: "YEARLY", amount: "1" }).success).toBe(false);
  });

  it("webhook body: only a Culqi event id is required", () => {
    expect(culqiWebhookBodySchema.safeParse({ id: "evt_test_0CjjdWhFpEAZlxlz", type: "subscription.charge.succeeded", data: "{}" }).success).toBe(true);
    expect(culqiWebhookBodySchema.safeParse({ id: "evt_test_0CjjdWhFpEAZlxlz" }).success).toBe(true);
    expect(culqiWebhookBodySchema.safeParse({ type: "subscription.charge.succeeded" }).success).toBe(false);
    expect(culqiWebhookBodySchema.safeParse({ id: "'; drop table x" }).success).toBe(false);
  });
});
