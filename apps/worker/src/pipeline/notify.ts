import type { NotificationJob } from "@emailbot/shared";
import type { EmailStore, Logger, RealtimePublisher } from "./ports.js";

export type NotifyOutcome = "delivered" | "skipped_disabled" | "skipped_not_implemented";

/**
 * Delivers a rule notification.
 *  - in_app: real-time event to the organization room (implemented).
 *  - email: SCAFFOLD — no outbound mail provider is configured yet, so the
 *    job is acknowledged and logged instead of pretending it was sent.
 */
export async function deliverNotification(
  job: NotificationJob,
  deps: { emails: EmailStore; realtime: RealtimePublisher; logger: Logger }
): Promise<NotifyOutcome> {
  const settings = await deps.emails.loadSettings(job.organizationId);
  if (!settings.notificationsEnabled) return "skipped_disabled";

  if (job.channel === "email") {
    if (!settings.emailNotificationsEnabled) return "skipped_disabled";
    deps.logger.warn({ emailId: job.emailId, ruleId: job.ruleId }, "email notifications are not implemented yet");
    return "skipped_not_implemented";
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
