import { describe, expect, it } from "vitest";
import {
  adminLogQuerySchema,
  adminOrganizationCreateSchema,
  adminOrganizationListQuerySchema,
  adminOrganizationUpdateSchema,
  adminSubscriptionActionParamsSchema,
  adminSubscriptionActionSchema,
  adminSubscriptionActivateSchema
} from "./admin.js";

describe("admin organization list query", () => {
  it("defaults page, size and sort", () => {
    expect(adminOrganizationListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25, sort: "created_desc" });
  });

  it("accepts the enums and trims the search", () => {
    expect(adminOrganizationListQuerySchema.parse({ search: "  acme ", status: "SUSPENDED", plan: "PRO", sort: "name_asc", page: "2", pageSize: "50" })).toEqual({
      search: "acme",
      status: "SUSPENDED",
      plan: "PRO",
      sort: "name_asc",
      page: 2,
      pageSize: 50
    });
  });

  it("the plan filter also finds legacy FREE organizations", () => {
    expect(adminOrganizationListQuerySchema.parse({ plan: "FREE" }).plan).toBe("FREE");
    expect(adminOrganizationListQuerySchema.parse({ plan: "BASIC" }).plan).toBe("BASIC");
  });

  it.each([
    [{ sort: "name" }],
    [{ sort: "created_at desc; drop table organizations" }],
    [{ status: "DELETED" }],
    [{ plan: "ENTERPRISE" }],
    [{ pageSize: "101" }],
    [{ page: "0" }],
    [{ search: "x".repeat(101) }]
  ])("rejects %j", (query) => {
    expect(adminOrganizationListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("admin organization create", () => {
  it("normalizes the owner e-mail; no plan (it comes from a subscription)", () => {
    expect(adminOrganizationCreateSchema.parse({ name: " Acme ", ownerEmail: "Owner@Example.COM" })).toEqual({
      name: "Acme",
      ownerEmail: "owner@example.com"
    });
  });

  it("Commercial V1.1: no plan is accepted at creation, not even a commercial one", () => {
    for (const plan of ["FREE", "BASIC", "PRO", "BUSINESS"]) {
      expect(adminOrganizationCreateSchema.safeParse({ name: "Acme", ownerEmail: "o@example.com", plan }).success).toBe(false);
    }
  });

  it.each([
    [{ name: "A", ownerEmail: "o@example.com" }],
    [{ name: "Acme", ownerEmail: "not-an-email" }],
    [{ name: "Acme" }],
    [{ name: "Acme", ownerEmail: "o@example.com", slug: "Not Valid" }],
    [{ name: "Acme", ownerEmail: "o@example.com", status: "SUSPENDED" }],
    [{ name: "Acme", ownerEmail: "o@example.com", ownerUserId: "11111111-1111-4111-8111-111111111111" }]
  ])("rejects %j (strict body)", (body) => {
    expect(adminOrganizationCreateSchema.safeParse(body).success).toBe(false);
  });
});

describe("admin organization update", () => {
  it("accepts the status only (the plan changes through a subscription)", () => {
    expect(adminOrganizationUpdateSchema.parse({ status: "SUSPENDED" })).toEqual({ status: "SUSPENDED" });
    expect(adminOrganizationUpdateSchema.safeParse({ plan: "BUSINESS", status: "ACTIVE" }).success).toBe(false);
  });

  it.each([[{}], [{ name: "Otro" }], [{ status: "ACTIVE", slug: "x" }], [{ status: "PAUSED" }], [{ plan: null }], [{ plan: "FREE" }]])("rejects %j", (body) => {
    expect(adminOrganizationUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe("admin log query", () => {
  it("accepts an optional organization id", () => {
    expect(adminLogQuerySchema.parse({ organizationId: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ page: 1, pageSize: 25 });
    expect(adminLogQuerySchema.safeParse({ organizationId: "nope" }).success).toBe(false);
  });
});

describe("admin subscription activation (manual payment)", () => {
  const valid = {
    plan: "PRO",
    billingPeriod: "MONTHLY",
    paymentMethod: "YAPE",
    amount: " 39.90 ",
    periodStart: "2026-10-06T00:00:00-05:00",
    periodEnd: "2026-11-06T00:00:00-05:00",
    reference: " OP-1 "
  };

  it("accepts a manual payment; the amount stays a decimal string (never a float)", () => {
    expect(adminSubscriptionActivateSchema.parse(valid)).toEqual({ ...valid, amount: "39.90", reference: "OP-1" });
    for (const amount of ["19.9", "199", "899.00"]) expect(adminSubscriptionActivateSchema.parse({ ...valid, amount }).amount).toBe(amount);
    for (const paymentMethod of ["YAPE", "CASH", "TRANSFER", "MANUAL"]) expect(adminSubscriptionActivateSchema.safeParse({ ...valid, paymentMethod }).success).toBe(true);
  });

  it.each([
    [{ paymentMethod: "CULQI" }],
    [{ plan: "FREE" }],
    [{ billingPeriod: "WEEKLY" }],
    [{ amount: 39.9 }],
    [{ amount: "39.999" }],
    [{ amount: "0" }],
    [{ amount: "-1" }],
    [{ amount: "1e3" }],
    [{ periodEnd: "2026-10-01T00:00:00-05:00" }],
    [{ periodStart: "mañana" }],
    [{ status: "ACTIVE" }],
    [{ currentPeriodEnd: "2099-01-01T00:00:00Z" }],
    [{ reference: "x".repeat(101) }]
  ])("rejects %j", (change) => {
    expect(adminSubscriptionActivateSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it("actions: suspend / reactivate / cancel / expire only, with an optional reason", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const action of ["suspend", "reactivate", "cancel", "expire"]) expect(adminSubscriptionActionParamsSchema.safeParse({ id, action }).success).toBe(true);
    expect(adminSubscriptionActionParamsSchema.safeParse({ id, action: "activate" }).success).toBe(false);
    expect(adminSubscriptionActionSchema.parse({ reason: " Falta de pago " })).toEqual({ reason: "Falta de pago" });
    expect(adminSubscriptionActionSchema.safeParse({ status: "ACTIVE" }).success).toBe(false);
  });
});
