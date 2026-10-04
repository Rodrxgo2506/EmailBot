import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../config/env.js";

describe("worker configuration fail-fast", () => {
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  const production = {
    ...secrets,
    NODE_ENV: "production",
    SUPABASE_URL: "https://project.supabase.co",
    REDIS_URL: "rediss://default:redis-password@redis.example.com:6380"
  };

  it("development without REDIS_URL uses the local default", () => {
    const config = loadWorkerConfig({ ...secrets, SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.providerHttpTimeoutMs).toBe(20_000);
    expect(config.supabaseHttpTimeoutMs).toBe(60_000);
  });

  it("a complete production configuration is accepted", () => {
    expect(loadWorkerConfig(production).redisUrl).toBe(production.REDIS_URL);
    expect(loadWorkerConfig({ ...production, REDIS_URL: "redis://redis.internal:6379" }).redisUrl).toBe("redis://redis.internal:6379");
  });

  it("production without REDIS_URL fails", () => {
    const env: Record<string, string> = { ...production };
    delete env.REDIS_URL;
    expect(() => loadWorkerConfig(env)).toThrow(/REDIS_URL: is required in production/);
  });

  it.each([
    ["REDIS_URL", "redis://localhost:6379"],
    ["REDIS_URL", "redis://127.0.0.1:6379"],
    ["SUPABASE_URL", "https://localhost:54321"],
    ["SUPABASE_URL", "http://project.supabase.co"]
  ])("production rejects %s=%s", (name, value) => {
    expect(() => loadWorkerConfig({ ...production, [name]: value })).toThrow(new RegExp(name));
  });

  it("a partial provider configuration fails (token refresh would silently break every account)", () => {
    expect(() => loadWorkerConfig({ ...production, MICROSOFT_CLIENT_ID: "id", MICROSOFT_CLIENT_SECRET: "secret" })).toThrow(
      /MICROSOFT_REDIRECT_URI must be set together/
    );
  });

  it("timeouts are configurable and bounded", () => {
    expect(loadWorkerConfig({ ...production, PROVIDER_HTTP_TIMEOUT_MS: "5000" }).providerHttpTimeoutMs).toBe(5000);
    expect(() => loadWorkerConfig({ ...production, PROVIDER_HTTP_TIMEOUT_MS: "10" })).toThrow(/PROVIDER_HTTP_TIMEOUT_MS/);
  });

  it("never echoes values in errors", () => {
    try {
      loadWorkerConfig({ ...production, REDIS_URL: "redis://user:redis-password@127.0.0.1:6379" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("redis-password");
    }
  });
});

describe("worker health endpoint configuration", () => {
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  const local = { ...secrets, SUPABASE_URL: "http://127.0.0.1:54321" };

  it("is disabled locally unless a port is configured", () => {
    expect(loadWorkerConfig(local).health).toBeNull();
  });

  it("uses WORKER_HEALTH_PORT, else the platform PORT", () => {
    expect(loadWorkerConfig({ ...local, WORKER_HEALTH_PORT: "8081" }).health).toEqual({ port: 8081, host: "0.0.0.0" });
    expect(loadWorkerConfig({ ...local, PORT: "10000" }).health).toEqual({ port: 10000, host: "0.0.0.0" });
    expect(loadWorkerConfig({ ...local, PORT: "10000", WORKER_HEALTH_PORT: "8081", WORKER_HEALTH_HOST: "127.0.0.1" }).health).toEqual({ port: 8081, host: "127.0.0.1" });
  });

  it("rejects invalid ports", () => {
    expect(() => loadWorkerConfig({ ...local, WORKER_HEALTH_PORT: "99999" })).toThrow(/WORKER_HEALTH_PORT/);
  });

  it("refuses weak or malformed TOKEN_ENCRYPTION_KEY with the same rules as the API", () => {
    expect(() => loadWorkerConfig({ ...local, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") })).toThrow(/TOKEN_ENCRYPTION_KEY: is not random enough/);
    expect(() => loadWorkerConfig({ ...local, TOKEN_ENCRYPTION_KEY: "short" })).toThrow(/TOKEN_ENCRYPTION_KEY: must be the standard base64/);
  });
});
