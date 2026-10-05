import { describe, expect, it } from "vitest";
import { adminLogQuerySchema, adminOrganizationCreateSchema, adminOrganizationListQuerySchema, adminOrganizationUpdateSchema } from "./admin.js";

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
  it("normalizes the owner e-mail and defaults the plan", () => {
    expect(adminOrganizationCreateSchema.parse({ name: " Acme ", ownerEmail: "Owner@Example.COM" })).toEqual({
      name: "Acme",
      plan: "FREE",
      ownerEmail: "owner@example.com"
    });
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
  it("accepts plan and/or status only", () => {
    expect(adminOrganizationUpdateSchema.parse({ status: "SUSPENDED" })).toEqual({ status: "SUSPENDED" });
    expect(adminOrganizationUpdateSchema.parse({ plan: "BUSINESS", status: "ACTIVE" })).toEqual({ plan: "BUSINESS", status: "ACTIVE" });
  });

  it.each([[{}], [{ name: "Otro" }], [{ status: "ACTIVE", slug: "x" }], [{ status: "PAUSED" }], [{ plan: null }]])("rejects %j", (body) => {
    expect(adminOrganizationUpdateSchema.safeParse(body).success).toBe(false);
  });
});

describe("admin log query", () => {
  it("accepts an optional organization id", () => {
    expect(adminLogQuerySchema.parse({ organizationId: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ page: 1, pageSize: 25 });
    expect(adminLogQuerySchema.safeParse({ organizationId: "nope" }).success).toBe(false);
  });
});
