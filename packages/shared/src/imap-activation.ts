/*
 * IMAP activation policy: which organizations may use IMAP at all.
 *
 * IMAP stays off globally: the API's imapAccountsEnabled and the worker's imapSyncEnabled are fixed to false in
 * code. Even once a reviewed code change turns them on for the first controlled test, IMAP is available ONLY to
 * the organizations listed below, in code. No environment variable, database row, request field or other route
 * can add one: the API and the worker read this constant through their configuration and nothing else.
 *
 * The list is EMPTY until the id of the test organization is confirmed and written here in a reviewed change.
 * Empty = IMAP refused for every organization (connection test, creation, activation, manual sync, polling,
 * synchronization, processing and recovery), whatever the global switches say.
 */
export const IMAP_TRIAL_ORGANIZATION_IDS: readonly string[] = Object.freeze([]);

/** An organization id as the database stores it (lower-case UUID). */
const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validated, frozen copy of an allowlist: lower-case UUIDs only, no duplicates. Anything else throws, so a typo in
 * the constant stops the API / worker at start-up instead of silently allowing nobody (or somebody else).
 */
export function imapOrganizationAllowlist(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !ORGANIZATION_ID.test(id)) throw new Error("IMAP organization allowlist: every entry must be a lower-case organization UUID");
    if (seen.has(id)) throw new Error("IMAP organization allowlist: duplicate entry");
    seen.add(id);
  }
  return Object.freeze([...seen]);
}

/**
 * True only when IMAP is switched on (exactly `true`) AND the organization is in the allowlist. A missing or
 * malformed organization id, a missing allowlist or an empty one: false (fail closed).
 */
export function imapAllowedForOrganization(enabled: boolean | undefined, allowlist: readonly string[] | undefined, organizationId: unknown): boolean {
  return (
    enabled === true &&
    Array.isArray(allowlist) &&
    typeof organizationId === "string" &&
    ORGANIZATION_ID.test(organizationId) &&
    allowlist.includes(organizationId)
  );
}
