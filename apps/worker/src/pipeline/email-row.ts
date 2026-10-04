import { createHash } from "node:crypto";
import type { RuleEvaluationResult } from "@emailbot/rules-engine";
import type { NormalizedEmail } from "@emailbot/types";
import { isStorableAddress } from "../providers/address.js";
import type { WorkerAccount } from "../providers/types.js";
import type { EmailInsertRow } from "./ports.js";

/** Headers kept in emails.headers (full header sets can be very large). */
const KEPT_HEADERS = [
  "message-id",
  "in-reply-to",
  "references",
  "from",
  "reply-to",
  "to",
  "cc",
  "subject",
  "date",
  "list-id",
  "list-unsubscribe",
  "authentication-results"
];

const truncate = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

export function contentHash(email: NormalizedEmail): string {
  return createHash("sha256")
    .update([email.provider, email.sender.address, email.subject, email.receivedAt, (email.textBody ?? "").slice(0, 2000)].join("\u0000"))
    .digest("hex");
}

/**
 * Maps a normalized email + rule outcome to a public.emails row, respecting
 * every check constraint of migration 3 (lengths, sender format, objects).
 */
export function buildEmailRow(
  email: NormalizedEmail,
  account: WorkerAccount,
  result: RuleEvaluationResult,
  processing: { startedAt: string; attempts: number }
): EmailInsertRow {
  const senderValid = isStorableAddress(email.sender.address);
  const headers = Object.fromEntries(
    KEPT_HEADERS.filter((name) => email.headers[name] !== undefined).map((name) => [
      name,
      (email.headers[name] as string).slice(0, 4000)
    ])
  );

  return {
    organization_id: account.organizationId,
    email_account_id: account.id,
    category_id: result.categoryId,
    matched_rule_id: result.primaryRuleId,
    direction: email.direction,
    // Completed by the worker once every step is done (migration 9).
    processing_status: "RECEIVED",
    provider_message_id: email.providerMessageId,
    provider_thread_id: truncate(email.threadId, 1000),
    internet_message_id: truncate(email.internetMessageId, 1000),
    // Constraint emails_sender_email_format: keep the original value in metadata if unusable.
    sender_email: senderValid ? email.sender.address : "unknown@invalid.invalid",
    sender_name: truncate(email.sender.name, 200),
    to_emails: email.recipients.map((recipient) => recipient.address),
    cc_emails: email.cc.map((recipient) => recipient.address),
    bcc_emails: email.bcc.map((recipient) => recipient.address),
    subject: truncate(email.subject, 1000),
    snippet: truncate(email.snippet, 2000),
    text_body: email.textBody,
    html_body: email.htmlBody,
    received_at: email.receivedAt,
    sent_at: email.sentAt,
    headers,
    provider_metadata: {
      matchedRuleIds: result.matchedRules.map((rule) => rule.id),
      ...(senderValid ? {} : { originalSender: email.sender.address.slice(0, 320) })
    },
    extracted_data: result.extracted,
    processing_attempts: processing.attempts,
    processing_started_at: processing.startedAt,
    processed_at: null,
    is_read: result.markRead,
    is_important: result.markImportant,
    is_archived: result.archive,
    content_hash: contentHash(email)
  };
}
