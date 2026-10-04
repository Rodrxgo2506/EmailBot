import type { EmailAddress, NormalizedEmail } from "@emailbot/types";
import { z } from "zod";

/* Microsoft Graph `message` resource -> NormalizedEmail (pure). */

const recipientSchema = z.object({
  emailAddress: z.object({ address: z.string().nullable().optional(), name: z.string().nullable().optional() })
});

export const graphMessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().nullable().optional(),
  internetMessageId: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  bodyPreview: z.string().nullable().optional(),
  body: z.object({ contentType: z.string(), content: z.string() }).nullable().optional(),
  from: recipientSchema.nullable().optional(),
  sender: recipientSchema.nullable().optional(),
  toRecipients: z.array(recipientSchema).optional(),
  ccRecipients: z.array(recipientSchema).optional(),
  bccRecipients: z.array(recipientSchema).optional(),
  receivedDateTime: z.string().nullable().optional(),
  sentDateTime: z.string().nullable().optional(),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })).nullable().optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable().optional(),
        contentType: z.string().nullable().optional(),
        size: z.number().nullable().optional(),
        isInline: z.boolean().nullable().optional(),
        contentId: z.string().nullable().optional()
      })
    )
    .optional()
});

const MAX_BODY_CHARS = 1_000_000;

function toAddress(recipient: z.infer<typeof recipientSchema> | null | undefined): EmailAddress | null {
  const address = recipient?.emailAddress.address?.trim().toLowerCase();
  if (!address) return null;
  const name = recipient?.emailAddress.name?.trim();
  return { address, name: name && name.length > 0 ? name : null };
}

function toAddresses(recipients: Array<z.infer<typeof recipientSchema>> | undefined): EmailAddress[] {
  return (recipients ?? []).map(toAddress).filter((address): address is EmailAddress => address !== null);
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function normalizeGraphMessage(raw: unknown, accountId: string): NormalizedEmail {
  const message = graphMessageSchema.parse(raw);

  const headers: Record<string, string> = {};
  for (const { name, value } of message.internetMessageHeaders ?? []) {
    const key = name.toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }

  const content = message.body?.content.slice(0, MAX_BODY_CHARS) ?? "";
  const isHtml = message.body?.contentType.toLowerCase() === "html";

  return {
    provider: "MICROSOFT",
    providerMessageId: message.id,
    threadId: message.conversationId ?? null,
    internetMessageId: message.internetMessageId ?? null,
    accountId,
    direction: "INBOUND",
    sender: toAddress(message.from) ?? toAddress(message.sender) ?? { address: "", name: null },
    recipients: toAddresses(message.toRecipients),
    cc: toAddresses(message.ccRecipients),
    bcc: toAddresses(message.bccRecipients),
    subject: message.subject ?? "",
    snippet: message.bodyPreview ?? null,
    textBody: !isHtml && content.length > 0 ? content : null,
    htmlBody: isHtml && content.length > 0 ? content : null,
    receivedAt: toIso(message.receivedDateTime) ?? new Date().toISOString(),
    sentAt: toIso(message.sentDateTime),
    attachments: (message.attachments ?? []).map((attachment) => ({
      providerAttachmentId: attachment.id,
      filename: attachment.name?.trim() || "attachment",
      contentType: attachment.contentType ?? null,
      size: attachment.size ?? null,
      contentId: attachment.contentId ?? null,
      isInline: attachment.isInline === true
    })),
    headers
  };
}
