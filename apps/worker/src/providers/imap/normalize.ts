import { htmlToText } from "@emailbot/rules-engine";
import type { EmailAddress, NormalizedAttachment, NormalizedEmail } from "@emailbot/types";
import PostalMime from "postal-mime";

/*
 * Raw RFC 5322 message (as fetched with BODY.PEEK[]) -> NormalizedEmail, with
 * postal-mime. Pure: no network, no storage.
 *
 *   - Never throws for a malformed message: if the parser refuses it (limits,
 *     garbage), a minimal email is built from the IMAP envelope so the mailbox
 *     keeps synchronizing; the rules then see subject / sender only.
 *   - Everything the sender controls is bounded: number of MIME parts, nesting,
 *     header size, body length, number of addresses and headers. Attachment
 *     file names are kept as text only (the storage path is built from ids by
 *     buildAttachmentPath / storageObjectName, never from the name).
 *   - Attachments are identified by their position in the parsed message
 *     ("part-<n>"): deterministic for the same bytes, so downloadAttachment
 *     re-parses the message and returns the same part.
 */

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;
type ParsedAddress = NonNullable<ParsedEmail["to"]>[number];

/** Largest message handled in full (E2 target). Bigger ones keep headers and text only (see adapter). */
export const IMAP_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** Same bound as the Gmail normalizer. */
export const IMAP_MAX_BODY_CHARS = 1_000_000;
const MAX_ADDRESSES = 500;
const MAX_HEADERS = 200;
const MAX_HEADER_VALUE = 8_000;
const SNIPPET_CHARS = 200;
/**
 * HTML characters looked at to build a snippet (HTML-only mail). The snippet is
 * 200 characters, so a 64 KB prefix is plenty; it is converted with the rules
 * engine's htmlToText, whose regexes are all linear-time (no regex here).
 */
export const IMAP_SNIPPET_HTML_INPUT = 64 * 1024;

/** Parser limits (postal-mime 4.0.5): far below its defaults, enough for real mail. */
export const IMAP_PARSE_OPTIONS = {
  attachmentEncoding: "arraybuffer",
  maxPartCount: 500,
  maxNestingDepth: 50,
  maxHeadersSize: 1024 * 1024,
  maxRfc822NestingDepth: 3
} as const;

export interface ImapEnvelope {
  subject?: string | undefined;
  from?: Array<{ name?: string | undefined; address?: string | undefined }> | undefined;
  date?: Date | string | undefined;
  messageId?: string | undefined;
}

export interface ImapMessageMeta {
  /** Provider message id ("<UIDVALIDITY>:<UID>"). */
  providerMessageId: string;
  /** IMAP INTERNALDATE: when the server received the message. */
  internalDate: Date | string | null | undefined;
  envelope?: ImapEnvelope | undefined;
}

export interface ParsedAttachmentContent {
  providerAttachmentId: string;
  content: Uint8Array;
}

const attachmentId = (index: number) => `part-${index}`;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function mailbox(name: string | undefined | null, address: string | undefined | null): EmailAddress | null {
  const value = (address ?? "").trim().toLowerCase().slice(0, 320);
  if (!value) return null;
  const display = (name ?? "").trim().slice(0, 200);
  return { address: value, name: display.length > 0 ? display : null };
}

function addresses(list: ParsedAddress[] | undefined): EmailAddress[] {
  const result: EmailAddress[] = [];
  for (const entry of list ?? []) {
    const members = entry.group ? entry.group : [entry];
    for (const member of members) {
      const value = mailbox(member.name, member.address);
      if (value) result.push(value);
      if (result.length >= MAX_ADDRESSES) return result;
    }
  }
  return result;
}

function headerRecord(parsed: ParsedEmail): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of parsed.headers.slice(0, MAX_HEADERS)) {
    const key = header.key.toLowerCase();
    const value = header.value.slice(0, MAX_HEADER_VALUE);
    record[key] = record[key] ? `${record[key]}, ${value}`.slice(0, MAX_HEADER_VALUE) : value;
  }
  return record;
}

const bodyText = (value: string | undefined) => (value && value.length > 0 ? value.slice(0, IMAP_MAX_BODY_CHARS) : null);

/**
 * First 200 characters of the text, or of the HTML converted to text. The HTML
 * is attacker-controlled: only a bounded prefix goes through htmlToText (linear
 * regexes, <script>/<style> removed with indexOf). A tag cut by the prefix is
 * just dropped by the conversion; the snippet is never more than a preview.
 */
/**
 * The bounded HTML a snippet is built from: at most IMAP_SNIPPET_HTML_INPUT
 * characters, without a tag left open by the cut (it would show up as text).
 */
export function snippetHtmlPrefix(html: string): string {
  if (html.length <= IMAP_SNIPPET_HTML_INPUT) return html;
  const prefix = html.slice(0, IMAP_SNIPPET_HTML_INPUT);
  const open = prefix.lastIndexOf("<");
  return open > prefix.lastIndexOf(">") ? prefix.slice(0, open) : prefix;
}

export function snippetOf(text: string | null, html: string | null): string | null {
  const source = text !== null ? text.slice(0, IMAP_SNIPPET_HTML_INPUT) : html !== null ? htmlToText(snippetHtmlPrefix(html)) : "";
  const compact = source.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, SNIPPET_CHARS) : null;
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === "string") return Buffer.byteLength(content);
  return content.byteLength;
}

async function parse(source: Uint8Array): Promise<ParsedEmail | null> {
  try {
    return await PostalMime.parse(source, IMAP_PARSE_OPTIONS);
  } catch {
    return null;
  }
}

/** Minimal email from the IMAP envelope when the MIME body cannot be parsed. */
function fromEnvelope(meta: ImapMessageMeta, accountId: string): NormalizedEmail {
  const envelope = meta.envelope ?? {};
  const sender = mailbox(envelope.from?.[0]?.name, envelope.from?.[0]?.address) ?? { address: "", name: null };
  return {
    provider: "IMAP",
    providerMessageId: meta.providerMessageId,
    threadId: null,
    internetMessageId: envelope.messageId?.trim().slice(0, 1000) || null,
    accountId,
    direction: "INBOUND",
    sender,
    recipients: [],
    cc: [],
    bcc: [],
    subject: (envelope.subject ?? "").slice(0, 1000),
    snippet: null,
    textBody: null,
    htmlBody: null,
    receivedAt: toIso(meta.internalDate) ?? toIso(envelope.date) ?? new Date().toISOString(),
    sentAt: toIso(envelope.date),
    attachments: [],
    headers: {}
  };
}

/**
 * Normalizes a full message. `truncated` = the bytes are only the headers and
 * text parts of an oversized message: attachments are listed from
 * `oversizedAttachments` (not downloadable) instead of the parsed bytes.
 */
export async function normalizeImapMessage(
  source: Uint8Array,
  meta: ImapMessageMeta,
  accountId: string,
  options: { oversizedAttachments?: NormalizedAttachment[] } = {}
): Promise<NormalizedEmail> {
  const parsed = await parse(source);
  if (!parsed) return fromEnvelope(meta, accountId);

  const textBody = bodyText(parsed.text);
  const htmlBody = bodyText(parsed.html);
  const fromAddress = parsed.from && !parsed.from.group ? mailbox(parsed.from.name, parsed.from.address) : null;
  const sender = fromAddress ?? mailbox(meta.envelope?.from?.[0]?.name, meta.envelope?.from?.[0]?.address) ?? { address: "", name: null };

  const attachments: NormalizedAttachment[] =
    options.oversizedAttachments ??
    parsed.attachments.map((attachment, index) => {
      const contentId = attachment.contentId ? attachment.contentId.replace(/^<|>$/g, "").slice(0, 1000) : null;
      return {
        providerAttachmentId: attachmentId(index),
        filename: (attachment.filename ?? "").trim().slice(0, 500) || "attachment",
        contentType: attachment.mimeType || null,
        size: byteLength(attachment.content),
        contentId,
        isInline: attachment.disposition === "inline" || (attachment.related === true && contentId !== null)
      };
    });

  return {
    provider: "IMAP",
    providerMessageId: meta.providerMessageId,
    threadId: null,
    internetMessageId: parsed.messageId?.trim().slice(0, 1000) || meta.envelope?.messageId?.trim().slice(0, 1000) || null,
    accountId,
    direction: "INBOUND",
    sender,
    recipients: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    subject: (parsed.subject ?? meta.envelope?.subject ?? "").slice(0, 1000),
    snippet: snippetOf(textBody, htmlBody),
    textBody,
    htmlBody,
    receivedAt: toIso(meta.internalDate) ?? toIso(parsed.date) ?? new Date().toISOString(),
    sentAt: toIso(parsed.date),
    attachments,
    headers: headerRecord(parsed)
  };
}

/** Index of an attachment id ("part-<n>", the order of normalizeImapMessage); null when it is not one. */
export function imapAttachmentIndex(providerAttachmentId: string): number | null {
  const match = /^part-(0|[1-9][0-9]{0,3})$/.exec(providerAttachmentId);
  return match ? Number(match[1]) : null;
}

function attachmentBytes(attachment: ParsedEmail["attachments"][number]): Uint8Array {
  const content = attachment.content;
  if (typeof content === "string") return new Uint8Array(Buffer.from(content, attachment.encoding === "base64" ? "base64" : "utf8"));
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** The bytes of one attachment ("part-<n>") of a full message; null when the message or the part cannot be read. */
export async function extractImapAttachment(source: Uint8Array, providerAttachmentId: string): Promise<Uint8Array | null> {
  const index = imapAttachmentIndex(providerAttachmentId);
  if (index === null) return null;
  const parsed = await parse(source);
  const attachment = parsed?.attachments[index];
  return attachment ? attachmentBytes(attachment) : null;
}

/** A2.1: the bytes of EVERY attachment of a full message, in "part-<n>" order (one parse); null when it cannot be read. */
export async function extractImapAttachments(source: Uint8Array): Promise<Uint8Array[] | null> {
  const parsed = await parse(source);
  return parsed ? parsed.attachments.map(attachmentBytes) : null;
}
