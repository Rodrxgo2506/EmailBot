import type { NotificationJob } from "@emailbot/shared";
import { hasCommercialAccess } from "./commercial-access.js";
import type { AccountStore, EmailStore, Logger, RealtimePublisher } from "./ports.js";

export type NotifyOutcome = "delivered" | "skipped_disabled" | "skipped_unsupported_channel" | "skipped_no_subscription";

/**
 * Delivers a rule notification in the app: a real-time event to the
 * organization room. In-app is the only channel. A job queued before V2
 * phase 7 with the removed "email" channel (never implemented) is
 * acknowledged and skipped, as it always was, instead of pretending it was sent.
 */
export async function deliverNotification(
  job: NotificationJob,
  deps: { emails: EmailStore; realtime: RealtimePublisher; logger: Logger; accounts?: Pick<AccountStore, "commercialAccess"> }
): Promise<NotifyOutcome> {
  const settings = await deps.emails.loadSettings(job.organizationId);
  if (!settings.notificationsEnabled) return "skipped_disabled";
  // Commercial V1.2: a notification queued before the organization lost access is not delivered.
  if (deps.accounts && !(await hasCommercialAccess(deps.accounts, deps.logger, { organizationId: job.organizationId, operation: "notification" }))) {
    return "skipped_no_subscription";
  }

  if ((job.channel as string) !== "in_app") {
    deps.logger.warn({ emailId: job.emailId, ruleId: job.ruleId, channel: job.channel }, "unsupported notification channel; skipped");
    return "skipped_unsupported_channel";
  }

  await deps.realtime.publish({
    type: "notification",
    organizationId: job.organizationId,
    emailId: job.emailId,
    title: job.title,
    body: job.body
  });
  return "delivered";
}
