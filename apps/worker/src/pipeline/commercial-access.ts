import type { AccountStore, CommercialAccess, Logger } from "./ports.js";

/*
 * Commercial V1.2: the worker never processes for an organization without
 * commercial access (an ACTIVE subscription inside its period, or the legacy
 * access of organizations created before subscriptions). The decision is the
 * database's (public.organization_access, the same the API and the portal
 * use) and is taken again right before every sensitive operation, so a job
 * queued while the organization had access is skipped if it lost it.
 *
 * Nothing is deleted or disconnected: mailboxes, cursors, emails, rules,
 * bots, customers and remote push subscriptions stay as they are; only the
 * processing stops (and resumes from the stored cursor once access returns).
 */

/** Fail closed: an organization the database did not answer for has no access. */
export const NO_ACCESS: CommercialAccess = { allowed: false, access: "NONE", subscriptionStatus: null };

export type GatedOperation =
  | "sync"
  | "process_email"
  | "watch"
  | "push_notification"
  | "poll"
  | "renew_watch"
  | "recover_incomplete"
  | "notification";

export interface AccessDenial {
  organizationId: string;
  operation: GatedOperation;
  emailAccountId?: string | undefined;
  provider?: string | undefined;
  jobType?: string | undefined;
}

export function accessDeniedReason(access: CommercialAccess): string {
  if (access.subscriptionStatus === null) return "no_subscription";
  if (access.subscriptionStatus === "ACTIVE") return "period_not_current";
  return `subscription_${access.subscriptionStatus.toLowerCase()}`;
}

/** Structured, content-free log line (no addresses, tokens or email data). */
export function logAccessDenied(logger: Logger, access: CommercialAccess, denial: AccessDenial): void {
  logger.info(
    {
      event: "subscription.access_denied",
      organizationId: denial.organizationId,
      subscriptionStatus: access.subscriptionStatus,
      operation: denial.operation,
      reason: accessDeniedReason(access),
      ...(denial.emailAccountId ? { emailAccountId: denial.emailAccountId } : {}),
      ...(denial.provider ? { provider: denial.provider } : {}),
      ...(denial.jobType ? { jobType: denial.jobType } : {})
    },
    "operation skipped: the organization has no active subscription"
  );
}

export async function commercialAccessOf(accounts: Pick<AccountStore, "commercialAccess">, organizationId: string): Promise<CommercialAccess> {
  return (await accounts.commercialAccess([organizationId])).get(organizationId) ?? NO_ACCESS;
}

/** Checks one organization; logs and returns false without access. */
export async function hasCommercialAccess(
  accounts: Pick<AccountStore, "commercialAccess">,
  logger: Logger,
  denial: AccessDenial
): Promise<boolean> {
  const access = await commercialAccessOf(accounts, denial.organizationId);
  if (!access.allowed) logAccessDenied(logger, access, denial);
  return access.allowed;
}

/**
 * Keeps the items whose organization has access (one database call for the
 * whole batch); the others are logged once per organization and dropped.
 */
export async function withCommercialAccess<T extends { organizationId: string }>(
  items: T[],
  accounts: Pick<AccountStore, "commercialAccess">,
  logger: Logger,
  operation: GatedOperation,
  jobType?: string
): Promise<T[]> {
  if (items.length === 0) return items;
  const access = await accounts.commercialAccess(items.map((item) => item.organizationId));
  const denied = new Set<string>();
  const allowed = items.filter((item) => {
    const entry = access.get(item.organizationId) ?? NO_ACCESS;
    if (!entry.allowed && !denied.has(item.organizationId)) {
      denied.add(item.organizationId);
      logAccessDenied(logger, entry, { organizationId: item.organizationId, operation, jobType });
    }
    return entry.allowed;
  });
  return allowed;
}
