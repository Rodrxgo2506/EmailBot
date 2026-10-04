import { looksLikeSupabaseSecretKey, productionUrlProblem, PUBLIC_URL } from "@emailbot/validation";
import { z } from "zod";

/*
 * Browser configuration. Only public values belong here: the Supabase anon
 * key is designed to be public (RLS protects the data). Never add the
 * service role key or any OAuth client secret to a VITE_* variable.
 *
 * Shared by the runtime (lib/env.ts) and the production build check
 * (vite.config.ts), so both apply exactly the same rules.
 */

export interface WebEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiUrl: string;
}

export type WebEnvResult = { ok: true; env: WebEnv } | { ok: false; issues: string[] };

const schema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  VITE_API_URL: z.url().optional()
});

/**
 * `production`: the API URL must be explicit (no localhost fallback).
 * `strict` (deployment builds): URLs must also be HTTPS and not local.
 * Issues name the variable only, never its value.
 */
export function parseWebEnv(
  source: Record<string, unknown>,
  options: { production: boolean; strict?: boolean }
): WebEnvResult {
  const values = Object.fromEntries(
    ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_API_URL"].map((name) => [name, source[name] === "" ? undefined : source[name]])
  );
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }

  const issues: string[] = [];
  const { VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL } = parsed.data;

  if (looksLikeSupabaseSecretKey(VITE_SUPABASE_ANON_KEY)) {
    issues.push("VITE_SUPABASE_ANON_KEY: is a secret (service role) key; only the anon/publishable key may reach the browser");
  }
  if (options.production && VITE_API_URL === undefined) {
    issues.push("VITE_API_URL: is required in production builds");
  }
  if (options.strict) {
    for (const [name, value] of [
      ["VITE_SUPABASE_URL", VITE_SUPABASE_URL],
      ["VITE_API_URL", VITE_API_URL]
    ] as const) {
      const problem = productionUrlProblem(value, PUBLIC_URL);
      if (problem && !(name === "VITE_API_URL" && value === undefined)) issues.push(`${name}: ${problem}`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    env: {
      supabaseUrl: VITE_SUPABASE_URL,
      supabaseAnonKey: VITE_SUPABASE_ANON_KEY,
      // Development default only: production requires VITE_API_URL (checked above).
      apiUrl: (VITE_API_URL ?? "http://localhost:3000").replace(/\/+$/, "")
    }
  };
}
