import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./csp";

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values];
    })
  ) as Record<string, string[]>;

describe("content security policy", () => {
  const production = buildContentSecurityPolicy({ apiUrl: "https://api.example.com/", supabaseUrl: "https://project.supabase.co" });
  const parsed = directives(production);

  it("allows only same-origin scripts (no inline, no eval)", () => {
    expect(parsed["script-src"]).toEqual(["'self'"]);
    expect(production).not.toContain("unsafe-eval");
    expect(production).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("connects only to itself, the API (https + wss for Socket.IO) and Supabase", () => {
    expect(parsed["connect-src"]).toEqual(["'self'", "https://api.example.com", "wss://api.example.com", "https://project.supabase.co"]);
  });

  it("locks down plugins, base URI, forms and workers and upgrades insecure requests", () => {
    expect(parsed["object-src"]).toEqual(["'none'"]);
    expect(parsed["base-uri"]).toEqual(["'self'"]);
    expect(parsed["form-action"]).toEqual(["'self'"]);
    expect(parsed["worker-src"]).toEqual(["'none'"]);
    expect(parsed["default-src"]).toEqual(["'self'"]);
    expect(production).toContain("upgrade-insecure-requests");
  });

  it("documents the two deliberate exceptions", () => {
    // Runtime <style> injection by sonner / react-remove-scroll.
    expect(parsed["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    // Sandboxed email preview inherits the policy; remote images only after opt-in.
    expect(parsed["img-src"]).toEqual(["'self'", "data:", "blob:", "https:"]);
  });

  it("local builds use ws:// and do not force HTTPS", () => {
    const local = directives(buildContentSecurityPolicy({ apiUrl: "http://localhost:3000", supabaseUrl: "http://127.0.0.1:54321" }));
    expect(local["connect-src"]).toEqual(["'self'", "http://localhost:3000", "ws://localhost:3000", "http://127.0.0.1:54321"]);
    expect(local["upgrade-insecure-requests"]).toBeUndefined();
  });

  it("keeps non-default ports and drops paths", () => {
    const custom = directives(buildContentSecurityPolicy({ apiUrl: "https://example.com:8443/backend", supabaseUrl: "https://project.supabase.co" }));
    expect(custom["connect-src"]).toContain("https://example.com:8443");
    expect(custom["connect-src"]).toContain("wss://example.com:8443");
  });
});
