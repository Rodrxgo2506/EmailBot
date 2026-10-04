import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Repositories } from "../types.js";
import { botRepository } from "./bot-repositories.js";
import { attachmentRepository, auditRepository, emailRepository } from "./email-repositories.js";
import { memberRepository, membershipRepository, organizationRepository } from "./organization-repositories.js";
import { privilegedOperations } from "./privileged.js";
import { categoryRepository, emailAccountRepository, ruleRepository } from "./resource-repositories.js";

const SERVER_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false
} as const;

export interface SupabaseClients {
  /** Anonymous client: only used to validate access tokens with Supabase Auth. */
  anon: SupabaseClient;
  /** SERVICE ROLE client. Bypasses RLS. Never expose it or its key. */
  service: SupabaseClient;
  /** Client acting as the caller: PostgREST evaluates RLS with this JWT. */
  forUser(accessToken: string): SupabaseClient;
}

/** `fetchImpl` should carry a deadline (fetchWithTimeout) so a stalled Supabase call cannot hang a request. */
export function createSupabaseClients(
  config: { url: string; anonKey: string; serviceRoleKey: string },
  fetchImpl: typeof fetch = globalThis.fetch
): SupabaseClients {
  return {
    anon: createClient(config.url, config.anonKey, { auth: SERVER_AUTH_OPTIONS, global: { fetch: fetchImpl } }),
    service: createClient(config.url, config.serviceRoleKey, { auth: SERVER_AUTH_OPTIONS, global: { fetch: fetchImpl } }),
    forUser(accessToken) {
      return createClient(config.url, config.anonKey, {
        auth: SERVER_AUTH_OPTIONS,
        global: { fetch: fetchImpl, headers: { Authorization: `Bearer ${accessToken}` } }
      });
    }
  };
}

export function createSupabaseRepositories(db: SupabaseClient): Repositories {
  return {
    memberships: membershipRepository(db),
    organizations: organizationRepository(db),
    members: memberRepository(db),
    emailAccounts: emailAccountRepository(db),
    categories: categoryRepository(db),
    bots: botRepository(db),
    rules: ruleRepository(db),
    emails: emailRepository(db),
    attachments: attachmentRepository(db),
    audit: auditRepository(db)
  };
}

export { privilegedOperations };
