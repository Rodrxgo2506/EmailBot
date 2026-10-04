import type { NormalizedAttachment, NormalizedEmail } from "@emailbot/types";
import { z } from "zod";
import { parseAddress, parseAddressList } from "../address.js";

/* Gmail API `users.messages.get?format=full` -> NormalizedEmail (pure). */

interface GmailPart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?: { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined } | undefined;
  parts?: GmailPart[] | undefined;
}

const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z
      .object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() })
      .optional(),
    parts: z.array(partSchema).optional()
  })
);

export const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: partSchema
});

export type GmailMessage = z.infer<typeof gmailMessageSchema>;

const MAX_BODY_CHARS = 1_000_000;

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectHeaders(part: GmailPart): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { name, value } of part.headers ?? []) {
    const key = name.toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

function walk(
  part: GmailPart,
  state: { text: string[]; html: string[]; attachments: NormalizedAttachment[] }
): void {
  const mimeType = (part.mimeType ?? "").toLowerCase();
  const partHeaders = collectHeaders(part);
  const disposition = (partHeaders["content-disposition"] ?? "").toLowerCase();
  const filename = part.filename ?? "";

  if (filename.length > 0 || part.body?.attachmentId) {
    const contentId = partHeaders["content-id"]?.replace(/^<|>$/g, "") ?? null;
    state.attachments.push({
      providerAttachmentId: part.body?.attachmentId ?? null,
      filename: filename.length > 0 ? filename : "attachment",
      contentType: part.mimeType ?? null,
      size: part.body?.size ?? null,
      contentId,
      isInline: disposition.startsWith("inline") || (contentId !== null && !disposition.startsWith("attachment"))
    });
    return;
  }

  if (mimeType === "text/plain") state.text.push(decodeBody(part.body?.data));
  else if (mimeType === "text/html") state.html.push(decodeBody(part.body?.data));

  for (const child of part.parts ?? []) walk(child, state);
}

function toIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function normalizeGmailMessage(raw: unknown, accountId: string): NormalizedEmail {
  const message = gmailMessageSchema.parse(raw);
  const headers = collectHeaders(message.payload);
  const state = { text: [] as string[], html: [] as string[], attachments: [] as NormalizedAttachment[] };
  walk(message.payload, state);

  const sender = parseAddress(headers["from"] ?? "") ?? { address: "", name: null };
  const internalDate = message.internalDate ? Number(message.internalDate) : Number.NaN;
  const receivedAt = Number.isFinite(internalDate)
    ? new Date(internalDate).toISOString()
    : (toIsoDate(headers["date"]) ?? new Date().toISOString());

  const text = state.text.join("\n").slice(0, MAX_BODY_CHARS);
  const html = state.html.join("\n").slice(0, MAX_BODY_CHARS);

  return {
    provider: "GMAIL",
    providerMessageId: message.id,
    threadId: message.threadId ?? null,
    internetMessageId: headers["message-id"]?.trim() ?? null,
    accountId,
    direction: message.labelIds?.includes("SENT") ? "OUTBOUND" : "INBOUND",
    sender,
    recipients: parseAddressList(headers["to"]),
    cc: parseAddressList(headers["cc"]),
    bcc: parseAddressList(headers["bcc"]),
    subject: headers["subject"] ?? "",
    snippet: message.snippet ?? null,
    textBody: text.length > 0 ? text : null,
    htmlBody: html.length > 0 ? html : null,
    receivedAt,
    sentAt: toIsoDate(headers["date"]),
    attachments: state.attachments,
    headers
  };
}
