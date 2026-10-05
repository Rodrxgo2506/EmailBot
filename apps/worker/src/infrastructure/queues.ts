import {
  addCoalescedSync,
  COALESCED_JOB_OPTIONS,
  DEFAULT_JOB_OPTIONS,
  emailProcessingJobId,
  notificationJobId,
  QUEUE_NAMES,
  watchAccountJobId,
  type EmailEventJob,
  type EmailProcessingJob,
  type NotificationJob,
  type SyncReason
} from "@emailbot/shared";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { JobProducer } from "../pipeline/ports.js";

export interface WorkerQueues {
  emailEvents: Queue<EmailEventJob>;
  emailProcessing: Queue<EmailProcessingJob>;
  notifications: Queue<NotificationJob>;
  producer: JobProducer;
  enqueueSync(account: { id: string; organizationId: string }, reason?: SyncReason): Promise<void>;
  enqueueWatch(account: { id: string; organizationId: string }): Promise<void>;
  close(): Promise<void>;
}

export function createWorkerQueues(connection: Redis): WorkerQueues {
  const emailEvents = new Queue<EmailEventJob>(QUEUE_NAMES.emailEvents, { connection });
  const emailProcessing = new Queue<EmailProcessingJob>(QUEUE_NAMES.emailProcessing, { connection });
  const notifications = new Queue<NotificationJob>(QUEUE_NAMES.notifications, { connection });

  return {
    emailEvents,
    emailProcessing,
    notifications,
    producer: {
      async enqueueProcessing(job, options) {
        // Deterministic id: the same provider message is never queued twice
        // while a job for it is pending or retained.
        await emailProcessing.add("process-email", job, {
          ...DEFAULT_JOB_OPTIONS,
          jobId: options?.jobId ?? emailProcessingJobId(job.emailAccountId, job.providerMessageId)
        });
      },
      async enqueueNotification(job) {
        // Deterministic id: a resumed/retried email does not notify twice while the job is retained.
        await notifications.add("notify", job, { ...DEFAULT_JOB_OPTIONS, attempts: 3, jobId: notificationJobId(job) });
      }
    },
    async enqueueSync(account, reason = "POLL") {
      await addCoalescedSync(emailEvents as never, account, reason);
    },
    async enqueueWatch(account) {
      await emailEvents.add(
        "WATCH_ACCOUNT",
        { type: "WATCH_ACCOUNT", emailAccountId: account.id, organizationId: account.organizationId },
        { ...COALESCED_JOB_OPTIONS, jobId: watchAccountJobId(account.id) }
      );
    },
    async close() {
      await Promise.all([emailEvents.close(), emailProcessing.close(), notifications.close()]);
    }
  };
}
