import { describe, expect, it } from "vitest";
import {
  categoryUpdateSchema,
  isLocalHostname,
  looksLikeSupabaseSecretKey,
  productionUrlProblem,
  PUBLIC_URL,
  REDIS_URL,
  emailListQuerySchema,
  memberAddSchema,
  memberUpdateSchema,
  ruleActionSchema,
  ruleConditionSchema,
  ruleCreateSchema,
  ruleUpdateSchema,
  slugify,
  validateUserRegex
} from "./index.js";

describe("slugify", () => {
  it("removes accents and produces a DB-compatible slug", () => {
    expect(slugify("Códigos Temporales")).toBe("codigos-temporales");
    expect(slugify("  --Facturación & Pagos!! ")).toBe("facturacion-pagos");
  });
});

describe("rule conditions", () => {
  it("requires a value except for exists/not_exists", () => {
    expect(ruleConditionSchema.safeParse({ field: "subject", operator: "contains" }).success).toBe(false);
    expect(ruleConditionSchema.safeParse({ field: "attachment", operator: "exists" }).success).toBe(true);
  });

  it("restricts before/after to the date field", () => {
    expect(
      ruleConditionSchema.safeParse({ field: "subject", operator: "before", value: "2026-01-01" }).success
    ).toBe(false);
    expect(
      ruleConditionSchema.safeParse({ field: "date", operator: "after", value: "2026-01-01T00:00:00Z" }).success
    ).toBe(true);
  });

  it("rejects invalid and dangerous regular expressions", () => {
    expect(ruleConditionSchema.safeParse({ field: "body", operator: "regex", value: "([a-z" }).success).toBe(false);
    expect(validateUserRegex("(a+)+$")).not.toBeNull();
    expect(validateUserRegex("(\\w*)*")).not.toBeNull();
    expect(validateUserRegex("(a)\\1")).not.toBeNull();
    expect(validateUserRegex("\\b\\d{6}\\b")).toBeNull();
  });

  it("rejects repeated groups with alternation (exponential backtracking)", () => {
    expect(validateUserRegex("(a|a)+$")).not.toBeNull();
    expect(validateUserRegex("(\\w|\\d){2,}x")).not.toBeNull();
    expect(validateUserRegex("(factura|boleta) N° \\d+")).toBeNull();
    expect(validateUserRegex("(ab|cd){3}")).toBeNull();
  });
});

describe("rule actions", () => {
  it("requires exactly one of preset or pattern for EXTRACT", () => {
    expect(ruleActionSchema.safeParse({ type: "EXTRACT", name: "code" }).success).toBe(false);
    expect(
      ruleActionSchema.safeParse({ type: "EXTRACT", name: "code", preset: "verification_code", pattern: "\\d+" })
        .success
    ).toBe(false);
    expect(ruleActionSchema.safeParse({ type: "EXTRACT", name: "code", preset: "verification_code" }).success).toBe(
      true
    );
  });

  it("rejects unknown action types", () => {
    expect(ruleActionSchema.safeParse({ type: "FORWARD_TO", to: "x@y.com" }).success).toBe(false);
  });
});

describe("rule create/update", () => {
  const base = {
    name: "Codes",
    conditions: [{ field: "sender", operator: "contains", value: "example.com" }]
  };

  it("applies defaults on create", () => {
    const parsed = ruleCreateSchema.parse(base);
    expect(parsed).toMatchObject({ enabled: true, priority: 100, stopProcessing: false, matchMode: "AND", actions: [] });
  });

  it("requires at least one condition", () => {
    expect(ruleCreateSchema.safeParse({ ...base, conditions: [] }).success).toBe(false);
  });

  it("does not inject defaults on partial update", () => {
    const parsed = ruleUpdateSchema.parse({ priority: 5 });
    expect(parsed).toEqual({ priority: 5 });
  });

  it("rejects an empty update", () => {
    expect(ruleUpdateSchema.safeParse({}).success).toBe(false);
    expect(categoryUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("members", () => {
  it("never accepts OWNER as an assignable role", () => {
    expect(memberAddSchema.safeParse({ email: "a@b.com", role: "OWNER" }).success).toBe(false);
    expect(memberUpdateSchema.safeParse({ role: "OWNER" }).success).toBe(false);
    expect(memberUpdateSchema.safeParse({ role: "ADMIN" }).success).toBe(true);
  });

  it("normalizes the email", () => {
    expect(memberAddSchema.parse({ email: "User@Example.COM" }).email).toBe("user@example.com");
  });
});

describe("email list query", () => {
  it("coerces pagination and booleans", () => {
    const parsed = emailListQuerySchema.parse({ page: "2", pageSize: "10", isRead: "false" });
    expect(parsed).toMatchObject({ page: 2, pageSize: 10, isRead: false });
  });

  it("caps pageSize", () => {
    expect(emailListQuerySchema.safeParse({ pageSize: "1000" }).success).toBe(false);
  });
});

declare const btoa: (data: string) => string;

describe("deployment URL checks", () => {
  it.each(["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "::1", "[::1]", "host.docker.internal"])(
    "%s is local",
    (host) => expect(isLocalHostname(host)).toBe(true)
  );

  it.each(["api.example.com", "10.0.0.5", "redis.internal", "128.0.0.1"])("%s is not local", (host) => {
    expect(isLocalHostname(host)).toBe(false);
  });

  it("explains why a production URL is rejected without echoing it", () => {
    expect(productionUrlProblem(undefined, PUBLIC_URL)).toBe("is required in production");
    expect(productionUrlProblem("  ", PUBLIC_URL)).toBe("is required in production");
    expect(productionUrlProblem("not a url", PUBLIC_URL)).toBe("must be a valid URL");
    expect(productionUrlProblem("http://api.example.com", PUBLIC_URL)).toBe("must use https in production");
    expect(productionUrlProblem("https://localhost:3000", PUBLIC_URL)).toMatch(/localhost/);
    expect(productionUrlProblem("https://api.example.com", PUBLIC_URL)).toBeNull();
    expect(productionUrlProblem("rediss://u:secret@redis.example.com:6380", REDIS_URL)).toBeNull();
    expect(productionUrlProblem("redis://redis.internal:6379", REDIS_URL)).toBeNull();
    expect(productionUrlProblem("https://redis.example.com", REDIS_URL)).toBe("must use redis or rediss in production");
    expect(productionUrlProblem("redis://u:secret@localhost:6379", REDIS_URL)).not.toContain("secret");
  });

  it("accepts the Render Key Value URL formats (internal redis://, external rediss://)", () => {
    // Internal: single-label host on Render's private network, no TLS. External: TLS with credentials.
    expect(productionUrlProblem("redis://red-abc123def456ghi789:6379", REDIS_URL)).toBeNull();
    expect(productionUrlProblem("rediss://red-abc123def456ghi789:secret@oregon-keyvalue.render.com:6379", REDIS_URL)).toBeNull();
  });

  it("detects Supabase secret keys", () => {
    const jwt = (role: string) => `h.${btoa(JSON.stringify({ role })).replace(/=+$/, "")}.s`;
    expect(looksLikeSupabaseSecretKey(jwt("service_role"))).toBe(true);
    expect(looksLikeSupabaseSecretKey(jwt("anon"))).toBe(false);
    expect(looksLikeSupabaseSecretKey("sb_secret_abc")).toBe(true);
    expect(looksLikeSupabaseSecretKey("sb_publishable_abc")).toBe(false);
    expect(looksLikeSupabaseSecretKey("not-a-jwt")).toBe(false);
  });
});
