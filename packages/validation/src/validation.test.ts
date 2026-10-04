import { describe, expect, it } from "vitest";
import {
  botCustomerAssignSchema,
  botCreateSchema,
  customerCreateSchema,
  customerIdentifierCreateSchema,
  customerIdentifierUpdateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  normalizeIdentifier,
  botUpdateSchema,
  categoryUpdateSchema,
  customerResolutionSchema,
  portalSettingsSchema,
  isLocalHostname,
  looksLikeSupabaseSecretKey,
  productionUrlProblem,
  PUBLIC_URL,
  REDIS_URL,
  emailListQuerySchema,
  memberAddSchema,
  memberUpdateSchema,
  normalizeOrigin,
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

  it("normalizes CORS origins the way browsers serialize the Origin header", () => {
    const ok = (value: string) => {
      const result = normalizeOrigin(value);
      return result.ok ? result.origin : `problem: ${result.problem}`;
    };
    expect(ok("https://emailbot.app")).toBe("https://emailbot.app");
    expect(ok("https://emailbot.app/")).toBe("https://emailbot.app");
    expect(ok("  https://EmailBot.App  ")).toBe("https://emailbot.app");
    expect(ok("https://emailbot.app:443")).toBe("https://emailbot.app");
    expect(ok("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(ok("https://emailbot.app:8443")).toBe("https://emailbot.app:8443");
    expect(ok("https://emailbot.app/login")).toMatch(/no path/);
    expect(ok("https://emailbot.app/?x=1")).toMatch(/no path/);
    expect(ok("https://emailbot.app/#top")).toMatch(/no path/);
    expect(ok("https://user:secret@emailbot.app")).toBe("problem: must not contain credentials");
    expect(ok("ftp://emailbot.app")).toBe("problem: must use http or https");
    expect(ok('"https://emailbot.app"')).toBe("problem: must be a valid URL");
    // Problems never echo the configured value.
    expect(ok("https://user:secret@emailbot.app")).not.toContain("secret");
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

describe("bots (EmailBot V2)", () => {
  const BOT = "11111111-1111-4111-8111-111111111111";

  it("creates with safe defaults and rejects unknown keys such as organizationId", () => {
    expect(botCreateSchema.parse({ name: " Netflix " })).toEqual({ name: "Netflix", status: "ACTIVE" });
    expect(botCreateSchema.safeParse({ name: "Netflix", organizationId: BOT }).success).toBe(false);
    expect(botCreateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(botCreateSchema.safeParse({ name: "x", slug: "Bad Slug" }).success).toBe(false);
    expect(botCreateSchema.safeParse({ name: "x", status: "DELETED" }).success).toBe(false);
  });

  it("update requires at least one known field", () => {
    expect(botUpdateSchema.safeParse({}).success).toBe(false);
    expect(botUpdateSchema.safeParse({ status: "PAUSED" }).success).toBe(true);
    expect(botUpdateSchema.safeParse({ owner: "x" }).success).toBe(false);
  });

  it("customer resolution: NONE takes no extra settings", () => {
    expect(customerResolutionSchema.parse({ source: "NONE" })).toEqual({ source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" });
    expect(customerResolutionSchema.safeParse({ source: "NONE", field: "code" }).success).toBe(false);
  });

  it("customer resolution: RECIPIENT/SENDER always match EMAIL identifiers", () => {
    expect(customerResolutionSchema.parse({ source: "RECIPIENT" })).toEqual({
      source: "RECIPIENT",
      identifierType: "EMAIL",
      onMultipleMatches: "LEAVE_UNASSIGNED"
    });
    expect(customerResolutionSchema.safeParse({ source: "SENDER", identifierType: "PHONE" }).success).toBe(false);
    expect(customerResolutionSchema.safeParse({ source: "RECIPIENT", field: "account" }).success).toBe(false);
  });

  it("customer resolution: EXTRACTED_FIELD needs a field name and an identifier type", () => {
    expect(customerResolutionSchema.safeParse({ source: "EXTRACTED_FIELD", identifierType: "USERNAME" }).success).toBe(false);
    expect(customerResolutionSchema.safeParse({ source: "EXTRACTED_FIELD", field: "account_email" }).success).toBe(false);
    expect(customerResolutionSchema.safeParse({ source: "EXTRACTED_FIELD", field: "Bad Name", identifierType: "CUSTOM" }).success).toBe(false);
    expect(
      customerResolutionSchema.parse({ source: "EXTRACTED_FIELD", field: "account_email", identifierType: "EMAIL", onMultipleMatches: "DELIVER_ALL" })
    ).toEqual({ source: "EXTRACTED_FIELD", field: "account_email", identifierType: "EMAIL", onMultipleMatches: "DELIVER_ALL" });
    expect(customerResolutionSchema.safeParse({ source: "RECIPIENT", onMultipleMatches: "FIRST" }).success).toBe(false);
  });

  it("portal settings: closed by default, unique keys, bounded labels and count", () => {
    expect(portalSettingsSchema.parse({})).toEqual({ showBody: false, showAttachments: false, fields: [] });
    const field = (key: string) => ({ key, label: "Código" });
    expect(portalSettingsSchema.safeParse({ fields: [field("code"), field("code")] }).success).toBe(false);
    expect(portalSettingsSchema.safeParse({ fields: [{ key: "code", label: "" }] }).success).toBe(false);
    expect(portalSettingsSchema.safeParse({ fields: Array.from({ length: 11 }, (_, i) => field(`f${i}`)) }).success).toBe(false);
    expect(portalSettingsSchema.safeParse({ showBody: true, extra: 1 }).success).toBe(false);
  });

  it("rules accept an optional bot id (null = general rule)", () => {
    const base = { name: "r", conditions: [{ field: "subject", operator: "contains", value: "code" }] };
    expect(ruleCreateSchema.parse({ ...base, botId: BOT }).botId).toBe(BOT);
    expect(ruleCreateSchema.parse({ ...base, botId: null }).botId).toBeNull();
    expect(ruleCreateSchema.safeParse({ ...base, botId: "netflix" }).success).toBe(false);
    expect(ruleUpdateSchema.safeParse({ botId: null }).success).toBe(true);
  });
});

describe("normalizeIdentifier (single implementation for API, web and worker)", () => {
  const norm = (type: Parameters<typeof normalizeIdentifier>[0], value: string) => {
    const result = normalizeIdentifier(type, value);
    return result.ok ? result.normalized : `problem: ${result.problem}`;
  };

  it("EMAIL: trim + lowercase, keeping dots and +alias", () => {
    expect(norm("EMAIL", "  Juan@Gmail.com ")).toBe("juan@gmail.com");
    expect(norm("EMAIL", "john.smith@gmail.com")).toBe("john.smith@gmail.com");
    expect(norm("EMAIL", "john+netflix@gmail.com")).toBe("john+netflix@gmail.com");
    expect(norm("EMAIL", "JOHN.SMITH+Netflix@GMAIL.COM")).toBe("john.smith+netflix@gmail.com");
    expect(norm("EMAIL", "no-at-sign")).toMatch(/problem/);
    expect(norm("EMAIL", "a b@example.com")).toMatch(/problem/);
    expect(norm("EMAIL", "a@b@example.com")).toMatch(/problem/);
  });

  it("PHONE: digits with a leading + kept, separators removed, 6-15 digits", () => {
    expect(norm("PHONE", "+51 987-654-321")).toBe("+51987654321");
    expect(norm("PHONE", "(01) 234.5678")).toBe("012345678");
    expect(norm("PHONE", "+1 (415) 555/0100")).toBe("+14155550100");
    expect(norm("PHONE", "987654321")).toBe("987654321");
    expect(norm("PHONE", "12345")).toMatch(/6 to 15 digits/);
    expect(norm("PHONE", "+1234567890123456")).toMatch(/6 to 15 digits/);
    expect(norm("PHONE", "98765abc")).toMatch(/problem/);
    expect(norm("PHONE", "51+987654321")).toMatch(/problem/);
  });

  it("USERNAME / EXTERNAL_ID / CUSTOM: trim + lowercase only", () => {
    expect(norm("USERNAME", "  Juan.Perez_01 ")).toBe("juan.perez_01");
    expect(norm("EXTERNAL_ID", "CRM-0042")).toBe("crm-0042");
    expect(norm("CUSTOM", "Perfil 3 Kids")).toBe("perfil 3 kids");
  });

  it("is deterministic and Unicode-stable (composed and decomposed accents are equal)", () => {
    const composed = "José";
    const decomposed = "Jose\u0301";
    expect(norm("USERNAME", decomposed)).toBe(norm("USERNAME", composed));
    expect(norm("USERNAME", composed)).toBe(norm("USERNAME", composed));
  });

  it("rejects empty and overlong values", () => {
    expect(norm("CUSTOM", "   ")).toMatch(/empty/);
    expect(norm("CUSTOM", "x".repeat(321))).toMatch(/at most 320/);
  });

  it("outputs satisfy the database invariants (customer_identifiers_normalized_format)", () => {
    for (const [type, value] of [
      ["EMAIL", "Juan@Gmail.com"],
      ["PHONE", "+51 987 654 321"],
      ["USERNAME", " MiUsuario "],
      ["CUSTOM", "Ñandú Ünïcode"]
    ] as const) {
      const result = normalizeIdentifier(type, value);
      if (!result.ok) throw new Error(result.problem);
      if (type === "PHONE") expect(result.normalized).toMatch(/^\+?[0-9]{6,15}$/);
      else expect(result.normalized).not.toMatch(/[A-Z]/);
      expect(result.normalized).toBe(result.normalized.trim());
    }
  });
});

describe("customers (EmailBot V2)", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("customer create/update are strict and never accept organizationId or createdBy", () => {
    expect(customerCreateSchema.parse({ displayName: " Juan " })).toEqual({ displayName: "Juan", status: "ACTIVE" });
    expect(customerCreateSchema.safeParse({ displayName: "Juan", organizationId: ID }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ displayName: "Juan", createdBy: ID }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ displayName: "" }).success).toBe(false);
    expect(customerUpdateSchema.safeParse({}).success).toBe(false);
    expect(customerUpdateSchema.safeParse({ status: "SUSPENDED" }).success).toBe(true);
    expect(customerUpdateSchema.safeParse({ status: "DELETED" }).success).toBe(false);
  });

  it("identifier create validates the value with the normalizer; normalizedValue is never accepted", () => {
    expect(customerIdentifierCreateSchema.safeParse({ type: "EMAIL", value: "juan@example.com" }).success).toBe(true);
    expect(customerIdentifierCreateSchema.safeParse({ type: "EMAIL", value: "not-an-email" }).success).toBe(false);
    expect(customerIdentifierCreateSchema.safeParse({ type: "PHONE", value: "123" }).success).toBe(false);
    expect(customerIdentifierCreateSchema.safeParse({ type: "EMAIL", value: "a@b.c", normalizedValue: "x@y.z" }).success).toBe(false);
    expect(customerIdentifierCreateSchema.safeParse({ type: "EMAIL", value: "a@b.c", botId: "netflix" }).success).toBe(false);
    expect(customerIdentifierUpdateSchema.safeParse({ type: "PHONE" }).success).toBe(false);
  });

  it("list query and assignment schemas", () => {
    expect(customerListQuerySchema.parse({ search: " juan ", page: "2" })).toMatchObject({ search: "juan", page: 2, pageSize: 25 });
    expect(botCustomerAssignSchema.parse({ customerId: ID })).toEqual({ customerId: ID, active: true });
    expect(botCustomerAssignSchema.safeParse({ customerId: ID, organizationId: ID }).success).toBe(false);
  });
});
