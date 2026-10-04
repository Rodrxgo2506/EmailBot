/*
 * The API records LOGIN audit events in the active organization
 * (POST /api/me/login-event). The login page marks a fresh sign-in; the
 * organization provider sends the event once the organization is known.
 */
const KEY = "emailbot.pendingLoginEvent";

export function markPendingLoginEvent(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Storage unavailable: the login simply is not audited.
  }
}

export function consumePendingLoginEvent(): boolean {
  try {
    const pending = sessionStorage.getItem(KEY) === "1";
    sessionStorage.removeItem(KEY);
    return pending;
  } catch {
    return false;
  }
}
