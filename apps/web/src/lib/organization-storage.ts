/**
 * Remembers the active organization in the browser. This is a UI
 * preference only: the API re-checks membership and role on every request.
 */
const KEY = "emailbot.activeOrganizationId";

let current: string | null = null;

export function getStoredOrganizationId(): string | null {
  if (current) return current;
  try {
    current = globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    current = null;
  }
  return current;
}

export function setStoredOrganizationId(organizationId: string | null): void {
  current = organizationId;
  try {
    if (organizationId) globalThis.localStorage?.setItem(KEY, organizationId);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode): keep the in-memory value.
  }
}
