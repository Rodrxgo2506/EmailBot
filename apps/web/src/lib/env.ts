import { parseWebEnv } from "./env-schema";

/*
 * Browser configuration (see env-schema.ts). A production bundle never falls
 * back to a localhost API: a missing VITE_API_URL is reported as a
 * configuration error instead.
 */
const result = parseWebEnv(import.meta.env, { production: import.meta.env.PROD });

export const envError = result.ok ? null : `Missing or invalid web configuration: ${result.issues.join("; ")}`;

export const env = result.ok
  ? result.env
  : { supabaseUrl: "http://invalid.localhost", supabaseAnonKey: "invalid", apiUrl: "http://invalid.localhost" };
