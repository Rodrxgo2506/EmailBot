import { describe, expect, it } from "vitest";
import { parseWebEnv } from "./env-schema";

const jwt = (role: string) => `h.${btoa(JSON.stringify({ role })).replace(/=+$/, "")}.s`;
const local = { VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_ANON_KEY: jwt("anon") };
const production = { VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_ANON_KEY: jwt("anon"), VITE_API_URL: "https://api.example.com/" };

describe("web configuration", () => {
  it("development falls back to the local API", () => {
    const result = parseWebEnv(local, { production: false });
    expect(result).toEqual({ ok: true, env: { supabaseUrl: local.VITE_SUPABASE_URL, supabaseAnonKey: local.VITE_SUPABASE_ANON_KEY, apiUrl: "http://localhost:3000" } });
  });

  it("a production bundle never falls back to localhost", () => {
    const result = parseWebEnv(local, { production: true });
    expect(result).toEqual({ ok: false, issues: ["VITE_API_URL: is required in production builds"] });
  });

  it("a deployment build requires HTTPS, non-local URLs", () => {
    expect(parseWebEnv(production, { production: true, strict: true })).toMatchObject({ ok: true, env: { apiUrl: "https://api.example.com" } });
    const bad = parseWebEnv({ ...production, VITE_API_URL: "http://localhost:3000", VITE_SUPABASE_URL: "http://project.supabase.co" }, { production: true, strict: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.join(" ")).toMatch(/VITE_SUPABASE_URL: must use https/);
      expect(bad.issues.join(" ")).toMatch(/VITE_API_URL: must use https/);
    }
    const missing = parseWebEnv({ ...production, VITE_API_URL: "" }, { production: true, strict: true });
    expect(missing).toEqual({ ok: false, issues: ["VITE_API_URL: is required in production builds"] });
  });

  it("refuses a service role key in the browser, in every mode", () => {
    for (const options of [{ production: false }, { production: true, strict: true }]) {
      const result = parseWebEnv({ ...production, VITE_SUPABASE_ANON_KEY: jwt("service_role") }, options);
      expect(result.ok).toBe(false);
    }
    expect(parseWebEnv({ ...production, VITE_SUPABASE_ANON_KEY: "sb_secret_x" }, { production: false }).ok).toBe(false);
  });

  it("reports names, never values", () => {
    const result = parseWebEnv({ VITE_SUPABASE_URL: "not a url", VITE_SUPABASE_ANON_KEY: "" }, { production: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).not.toContain("not a url");
  });
});
