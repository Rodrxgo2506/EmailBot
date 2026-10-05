import type { OrganizationRole } from "./enums.js";

/**
 * Application permissions, mirroring the RLS policies in supabase/migrations.
 *
 * The database remains the source of truth (RLS is always enforced because
 * the API talks to PostgREST with the caller's JWT). This map lets the API
 * fail fast with a clear 403 and lets the UI hide actions a role cannot do.
 */
export const PERMISSIONS = {
  "organization:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "organization:update": ["OWNER", "ADMIN"],
  "organization:transfer-ownership": ["OWNER"],
  "settings:update": ["OWNER", "ADMIN"],
  "members:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "members:manage": ["OWNER", "ADMIN"],
  "email-accounts:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "email-accounts:manage": ["OWNER", "ADMIN"],
  "email-accounts:sync": ["OWNER", "ADMIN", "OPERATOR"],
  "categories:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "categories:manage": ["OWNER", "ADMIN"],
  "bots:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "bots:manage": ["OWNER", "ADMIN"],
  "customers:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "customers:manage": ["OWNER", "ADMIN", "OPERATOR"],
  /** EmailBot V2 phase 4: generate / regenerate / revoke Access IDs, list and revoke sessions. */
  "customer-access:manage": ["OWNER", "ADMIN", "OPERATOR"],
  /** EmailBot V2 phase 5: create / remove MANUAL deliveries (same rules as automatic ones). */
  "deliveries:manage": ["OWNER", "ADMIN", "OPERATOR"],
  "rules:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "rules:manage": ["OWNER", "ADMIN"],
  "emails:read": ["OWNER", "ADMIN", "OPERATOR", "VIEWER"],
  "emails:update": ["OWNER", "ADMIN", "OPERATOR"],
  "emails:delete": ["OWNER", "ADMIN"],
  "audit:read": ["OWNER", "ADMIN"]
} as const satisfies Record<string, readonly OrganizationRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(
  role: OrganizationRole | null | undefined,
  permission: Permission
): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly OrganizationRole[]).includes(role);
}
