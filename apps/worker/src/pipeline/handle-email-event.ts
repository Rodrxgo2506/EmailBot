import { resumeProcessingJobId, type EmailEventJob } from "@emailbot/shared";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderContext, WorkerAccount } from "../providers/types.js";
import type { AccountStore, EmailStore, JobProducer, Logger } from "./ports.js";

export interface HandleEventDeps {
  accounts: AccountStore;
  emails: Pick<EmailStore, "listIncompleteEmails" | "updateProcessingState">;
  producer: JobProducer;
  providers: ProviderRegistry;
  createContext(account: WorkerAccount): ProviderContext;
  enqueueSync(account: Pick<WorkerAccount, "id" | "organizationId">): Promise<void>;
  logger: Logger;
}

export interface HandleEventOutcome {
  accounts: number;
  enqueued: number;
}

const POLL_BATCH = 500;

/** An email still RECEIVED / PROCESSING this long after it started was abandoned by its job. */
export const RECOVERY_STALE_MS = 15 * 60 * 1000;
export const RECOVERY_BATCH = 100;
/**
 * Every run (first attempt, BullMQ retries, recovery runs) increments
 * processing_attempts. Past this, the email is marked FAILED instead of being
 * retried forever; its stored data is kept.
 */
export const MAX_PROCESSING_ATTEMPTS = 25;

/**
 * Lists new messages for one account and enqueues one processing job per
 * message (deterministic job id => no duplicate jobs), then advances the
 * cursor. Messages are NOT fetched here.
 */
export async function syncAccount(account: WorkerAccount, deps: HandleEventDeps): Promise<number> {
  // Inactive organization: nothing is listed and the cursor does not move, so no mail is lost or processed.
  if (account.status !== "ACTIVE" || account.organizationStatus !== "ACTIVE") return 0;

  const changes = await deps.providers[account.provider].listNewMessageIds(deps.createContext(account));

  for (const providerMessageId of changes.messageIds) {
    await deps.producer.enqueueProcessing({
      organizationId: account.organizationId,
      emailAccountId: account.id,
      provider: account.provider,
      providerMessageId
    });
  }

  // Cursor is advanced only after every id was enqueued.
  await deps.accounts.updateSyncState(account.id, {
    syncCursor: changes.nextCursor,
    lastSyncedAt: new Date().toISOString()
  });

  deps.logger.info({ emailAccountId: account.id, enqueued: changes.messageIds.length }, "account synchronized");
  return changes.messageIds.length;
}

export async function handleEmailEvent(job: EmailEventJob, deps: HandleEventDeps): Promise<HandleEventOutcome> {
  switch (job.type) {
    case "GMAIL_NOTIFICATION": {
      // The same mailbox may be connected to several organizations; each has its own rules.
      const accounts = await deps.accounts.findActiveAccountsByAddress("GMAIL", job.emailAddress);
      let enqueued = 0;
      for (const account of accounts) enqueued += await syncAccount(account, deps);
      return { accounts: accounts.length, enqueued };
    }

    case "MICROSOFT_NOTIFICATION": {
      const account = await deps.accounts.findAccountBySubscription(job.subscriptionId);
      if (!account || account.status !== "ACTIVE") return { accounts: 0, enqueued: 0 };

      if (job.messageId) {
        await deps.producer.enqueueProcessing({
          organizationId: account.organizationId,
          emailAccountId: account.id,
          provider: "MICROSOFT",
          providerMessageId: job.messageId
        });
        return { accounts: 1, enqueued: 1 };
      }
      return { accounts: 1, enqueued: await syncAccount(account, deps) };
    }

    case "SYNC_ACCOUNT": {
      const account = await deps.accounts.getAccount(job.emailAccountId);
      if (!account || account.organizationId !== job.organizationId) return { accounts: 0, enqueued: 0 };
      return { accounts: 1, enqueued: await syncAccount(account, deps) };
    }

    case "RECOVER_INCOMPLETE": {
      const startedBefore = new Date(Date.now() - RECOVERY_STALE_MS).toISOString();
      const incomplete = await deps.emails.listIncompleteEmails({ startedBefore, limit: RECOVERY_BATCH });
      let enqueued = 0;
      for (const email of incomplete) {
        if (email.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
          await deps.emails.updateProcessingState(email.id, {
            status: "FAILED",
            errorCode: "RECOVERY_EXHAUSTED",
            errorMessage: `Processing could not be completed after ${email.processingAttempts} attempts`
          });
          deps.logger.error({ emailId: email.id, attempts: email.processingAttempts }, "email processing abandoned");
          continue;
        }
        await deps.producer.enqueueProcessing(
          {
            organizationId: email.organizationId,
            emailAccountId: email.emailAccountId,
            provider: email.provider,
            providerMessageId: email.providerMessageId
          },
          // One recovery job per generation; the run itself increments processing_attempts.
          { jobId: resumeProcessingJobId(email.id, email.processingAttempts) }
        );
        enqueued += 1;
      }
      if (incomplete.length > 0) deps.logger.info({ found: incomplete.length, enqueued }, "incomplete emails recovered");
      return { accounts: incomplete.length, enqueued };
    }
    case "POLL_ACCOUNTS": {
      const accounts = await deps.accounts.listActiveOAuthAccounts(POLL_BATCH);
      for (const account of accounts) await deps.enqueueSync(account);
      return { accounts: accounts.length, enqueued: 0 };
    }
  }
}
