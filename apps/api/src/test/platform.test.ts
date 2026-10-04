import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.js";
import { fromDatabaseError } from "../lib/errors.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

describe("health", () => {
  it("GET /health responds ok with a request id", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "emailbot-api" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("propagates a valid incoming x-request-id", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "req-12345678" } });
    expect(response.headers["x-request-id"]).toBe("req-12345678");
  });

  it("GET /health/ready reports failing dependencies with 503", async () => {
    const { app, deps } = await createTestApp();
    deps.readinessChecks.push({ name: "redis", check: async () => Promise.reject(new Error("down")) });

    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready", checks: { redis: "error" } });
  });

  it("unknown routes return a JSON 404", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

describe("CORS", () => {
  it("only allows configured origins", async () => {
    const { app } = await createTestApp({ config: { corsOrigins: ["https://app.example.com"] } });

    const allowed = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://app.example.com" } });
    const denied = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.com" } });

    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("authentication", () => {
  it("rejects requests without a bearer token", async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects malformed and invalid tokens", async () => {
    const { app } = await createTestApp();
    for (const authorization of ["Basic abc", "Bearer ", "Bearer not-a-known-token"]) {
      const response = await app.inject({ method: "GET", url: "/api/me", headers: { authorization } });
      expect(response.statusCode, authorization).toBe(401);
    }
  });

  it("GET /api/me returns the user and their memberships", async () => {
    const user = makeUser({ [ORG_A]: "ADMIN" });
    const { app } = await createTestApp({ users: [user] });

    const response = await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(user) });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(user.id);
    expect(response.json().memberships).toEqual([expect.objectContaining({ role: "ADMIN" })]);
  });
});

describe("organization context", () => {
  it("returns 403 when the user is not a member of the requested organization", async () => {
    const user = makeUser({ [ORG_A]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [user] });

    const response = await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user, ORG_B) });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("NOT_A_MEMBER");
    expect(repos.rules.list).not.toHaveBeenCalled();
  });

  it("scopes queries to the selected organization for multi-organization users", async () => {
    const user = makeUser({ [ORG_A]: "VIEWER", [ORG_B]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [user] });
    repos.rules.list.mockResolvedValue([]);

    await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user, ORG_A) });
    await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user, ORG_B) });

    expect(repos.rules.list.mock.calls).toEqual([[ORG_A], [ORG_B]]);
  });

  it("uses the role of the selected organization, not the highest one", async () => {
    const user = makeUser({ [ORG_A]: "VIEWER", [ORG_B]: "OWNER" });
    const { app, repos } = await createTestApp({ users: [user] });

    const response = await app.inject({
      method: "POST",
      url: "/api/categories",
      headers: authHeaders(user, ORG_A),
      payload: { name: "X" }
    });
    expect(response.statusCode).toBe(403);
    expect(repos.categories.create).not.toHaveBeenCalled();
  });

  it("requires the header when the user has several organizations", async () => {
    const user = makeUser({ [ORG_A]: "VIEWER", [ORG_B]: "OWNER" });
    const { app } = await createTestApp({ users: [user] });

    const response = await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("ORGANIZATION_REQUIRED");
  });

  it("defaults to the only organization of the user", async () => {
    const user = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos } = await createTestApp({ users: [user] });
    repos.categories.list.mockResolvedValue([]);

    const response = await app.inject({ method: "GET", url: "/api/categories", headers: authHeaders(user) });
    expect(response.statusCode).toBe(200);
    expect(repos.categories.list).toHaveBeenCalledWith(ORG_A);
  });

  it("rejects malformed organization ids", async () => {
    const user = makeUser({ [ORG_A]: "VIEWER" });
    const { app } = await createTestApp({ users: [user] });

    const response = await app.inject({ method: "GET", url: "/api/rules", headers: authHeaders(user, "1 or 1=1") });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_ORGANIZATION_ID");
  });
});

describe("database error mapping", () => {
  it("maps RLS, uniqueness and business rule errors", () => {
    expect(fromDatabaseError({ code: "42501", message: "new row violates row-level security policy" }).statusCode).toBe(403);
    expect(fromDatabaseError({ code: "23505", message: "duplicate" }).statusCode).toBe(409);
    const business = fromDatabaseError({ code: "P0001", message: "Only the current OWNER can transfer ownership" });
    expect([business.statusCode, business.message]).toEqual([422, "Only the current OWNER can transfer ownership"]);
  });

  it("hides unknown database messages", () => {
    const error = fromDatabaseError({ code: "XX000", message: "relation public.secret_table does not exist" });
    expect(error.statusCode).toBe(500);
    expect(error.message).not.toContain("secret_table");
  });
});

describe("environment validation", () => {
  const base = {
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    OAUTH_STATE_SECRET: "x".repeat(40)
  };

  it("loads a valid development configuration with permissive CORS", () => {
    const config = loadConfig({ ...base, NODE_ENV: "development" });
    expect(config.corsOrigins).toBe(true);
    expect(config.google).toBeNull();
  });

  it("requires explicit CORS origins in production", () => {
    const production = {
      ...base,
      NODE_ENV: "production",
      SUPABASE_URL: "https://project.supabase.co",
      API_PUBLIC_URL: "https://api.example.com",
      WEB_APP_URL: "https://app.example.com",
      REDIS_URL: "rediss://default:secret@redis.example.com:6380"
    };
    expect(() => loadConfig(production)).toThrow(/CORS_ORIGINS/);
    const config = loadConfig({ ...production, CORS_ORIGINS: "https://app.example.com, https://x.example.com" });
    expect(config.corsOrigins).toEqual(["https://app.example.com", "https://x.example.com"]);
  });

  it("rejects weak secrets without echoing values", () => {
    const run = () => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "short", OAUTH_STATE_SECRET: "tiny" });
    expect(run).toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(run).toThrow(/OAUTH_STATE_SECRET/);
    try {
      loadConfig({ ...base, SUPABASE_URL: "not-a-url" });
    } catch (error) {
      expect(String(error)).not.toContain("service-role-secret-value");
      expect(String(error)).not.toContain("not-a-url");
    }
  });

  it("treats blank optional values as unset", () => {
    const config = loadConfig({ ...base, GOOGLE_CLIENT_ID: "", SENTRY_DSN: "" });
    expect(config.google).toBeNull();
    expect(config.sentryDsn).toBeNull();
  });
});

describe("logging", () => {
  it("never logs authorization headers or OAuth codes", async () => {
    const lines: string[] = [];
    const { buildApp } = await import("../app.js");
    const { deps } = await createTestApp();
    const app = await buildApp(deps, {
      logger: { level: "info", stream: { write: (line: string) => lines.push(line) } }
    });

    await app.inject({
      method: "GET",
      url: "/api/oauth/gmail/callback?code=SECRET-CODE&state=SECRET-STATE",
      headers: { authorization: "Bearer SECRET-TOKEN", cookie: "sb=SECRET-COOKIE" }
    });

    const output = lines.join("\n");
    expect(output.length).toBeGreaterThan(0);
    for (const secret of ["SECRET-CODE", "SECRET-STATE", "SECRET-TOKEN", "SECRET-COOKIE"]) {
      expect(output).not.toContain(secret);
    }
  });
});
