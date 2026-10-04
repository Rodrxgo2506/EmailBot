import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * Browser Supabase client (anon key). Used for authentication only; all
 * application data goes through the EmailBot API, which re-validates the
 * session and enforces RBAC on top of RLS.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
