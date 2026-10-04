import type { NormalizedEmail, RuleMatchMode } from "@emailbot/types";
import {
  ruleActionsDocumentSchema,
  ruleConditionsDocumentSchema,
  type RuleTestEmail
} from "@emailbot/validation";
import type { EngineRule } from "./types.js";

/** Raw public.email_rules row as returned by PostgREST. */
export interface EmailRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  stop_processing: boolean;
  match_mode: RuleMatchMode;
  category_id: string | null;
  conditions: unknown;
  actions: unknown;
  created_at?: string;
}

export type RuleParseResult =
  | { ok: true; rule: EngineRule }
  | { ok: false; ruleId: string; reason: string };

/**
 * Validates JSONB conditions/actions coming from the database. Rules that
 * fail validation are reported and skipped, never partially executed.
 */
export function parseRuleRow(row: EmailRuleRow): RuleParseResult {
  const conditions = ruleConditionsDocumentSchema.safeParse(row.conditions);
  if (!conditions.success) {
    return { ok: false, ruleId: row.id, reason: "Invalid conditions document" };
  }

  const actions = ruleActionsDocumentSchema.safeParse(row.actions);
  if (!actions.success) {
    return { ok: false, ruleId: row.id, reason: "Invalid actions document" };
  }

  return {
    ok: true,
    rule: {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      priority: row.priority,
      stopProcessing: row.stop_processing,
      matchMode: row.match_mode,
      categoryId: row.category_id,
      conditions: conditions.data.conditions,
      actions: actions.data.actions,
      createdAt: row.created_at
    }
  };
}

function parseAddress(raw: string): { address: string; name: string | null } {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(raw);
  if (match?.[2]) {
    const name = match[1]?.trim();
    return { address: match[2].trim(), name: name && name.length > 0 ? name : null };
  }
  return { address: raw.trim(), name: null };
}

/** Builds a NormalizedEmail from the simplified payload of "test rule" requests. */
export function sampleToNormalizedEmail(sample: RuleTestEmail): NormalizedEmail {
  const sender = parseAddress(sample.sender);

  return {
    provider: "IMAP",
    providerMessageId: "rule-test",
    threadId: null,
    internetMessageId: null,
    accountId: "rule-test",
    direction: "INBOUND",
    sender: { address: sender.address, name: sample.senderName ?? sender.name },
    recipients: sample.recipients.map(parseAddress),
    cc: sample.cc.map(parseAddress),
    bcc: [],
    subject: sample.subject,
    snippet: null,
    textBody: sample.body,
    htmlBody: null,
    receivedAt: sample.receivedAt ?? new Date().toISOString(),
    sentAt: null,
    attachments: sample.attachments.map((attachment) => ({
      providerAttachmentId: null,
      filename: attachment.filename,
      contentType: attachment.contentType ?? null,
      size: null,
      contentId: null,
      isInline: false
    })),
    headers: {}
  };
}
