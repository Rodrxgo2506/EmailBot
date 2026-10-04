import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions.js";

describe("hasPermission", () => {
  it("mirrors the RLS role matrix", () => {
    expect(hasPermission("OWNER", "organization:transfer-ownership")).toBe(true);
    expect(hasPermission("ADMIN", "organization:transfer-ownership")).toBe(false);
    expect(hasPermission("ADMIN", "rules:manage")).toBe(true);
    expect(hasPermission("OPERATOR", "rules:manage")).toBe(false);
    expect(hasPermission("OPERATOR", "emails:update")).toBe(true);
    expect(hasPermission("VIEWER", "emails:update")).toBe(false);
    expect(hasPermission("VIEWER", "emails:read")).toBe(true);
    expect(hasPermission("VIEWER", "audit:read")).toBe(false);
  });

  it("bots: every member reads, only OWNER/ADMIN manage (same as the bots RLS policies)", () => {
    expect(hasPermission("VIEWER", "bots:read")).toBe(true);
    expect(hasPermission("OPERATOR", "bots:manage")).toBe(false);
    expect(hasPermission("VIEWER", "bots:manage")).toBe(false);
    expect(hasPermission("ADMIN", "bots:manage")).toBe(true);
    expect(hasPermission("OWNER", "bots:manage")).toBe(true);
  });

  it("customers: every member reads; OWNER/ADMIN/OPERATOR manage (same as the customers RLS policies)", () => {
    expect(hasPermission("VIEWER", "customers:read")).toBe(true);
    expect(hasPermission("VIEWER", "customers:manage")).toBe(false);
    expect(hasPermission("OPERATOR", "customers:manage")).toBe(true);
    expect(hasPermission("ADMIN", "customers:manage")).toBe(true);
    expect(hasPermission("OWNER", "customers:manage")).toBe(true);
  });

  it("denies when there is no role", () => {
    expect(hasPermission(null, "emails:read")).toBe(false);
    expect(hasPermission(undefined, "emails:read")).toBe(false);
  });
});
