/*
 * Stricter per-IP limits for expensive or abuse-prone routes (route option
 * `config: { rateLimit }`). Everything else uses the global RATE_LIMIT_MAX.
 * Supabase Auth endpoints (login, sign-up, password recovery) are rate
 * limited by Supabase itself ([auth.rate_limit] / project settings).
 */
export const RATE_LIMITS = {
  /** CPU-bound rule evaluation (user regexes, large sample bodies). */
  ruleTest: { max: 30, timeWindow: "1 minute" },
  /** Membership lookups by email (enumeration) and invitations. */
  memberAdd: { max: 20, timeWindow: "10 minutes" },
  organizationCreate: { max: 10, timeWindow: "1 hour" },
  oauthStart: { max: 20, timeWindow: "10 minutes" },
  oauthCallback: { max: 30, timeWindow: "10 minutes" },
  imapCreate: { max: 10, timeWindow: "10 minutes" },
  accountSync: { max: 10, timeWindow: "1 minute" },
  loginEvent: { max: 20, timeWindow: "10 minutes" },
  /** Customer portal login (Access ID guessing); plus a 15 min lockout after 10 failures (login-throttle.ts). */
  portalLogin: { max: 5, timeWindow: "1 minute" },
  /** Generating / regenerating customer Access IDs. */
  customerAccessIssue: { max: 30, timeWindow: "10 minutes" },
  /** Provider push traffic can burst. */
  webhook: { max: 1200, timeWindow: "1 minute" }
} as const;
