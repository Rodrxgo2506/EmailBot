import type { EmailDirection, EmailProvider } from "./enums.js";

export interface EmailAddress {
  address: string;
  name: string | null;
}

export interface NormalizedAttachment {
  providerAttachmentId: string | null;
  filename: string;
  contentType: string | null;
  size: number | null;
  contentId: string | null;
  isInline: boolean;
}

/**
 * Provider-independent representation of an email message.
 *
 * Gmail, Microsoft Graph and IMAP adapters all normalize their native
 * payloads into this shape so the rule engine and the persistence layer
 * never depend on a specific provider. Dates are ISO-8601 strings so the
 * structure can travel through the job queue unchanged.
 */
export interface NormalizedEmail {
  provider: EmailProvider;
  providerMessageId: string;
  threadId: string | null;
  internetMessageId: string | null;
  accountId: string;
  direction: EmailDirection;
  sender: EmailAddress;
  recipients: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  snippet: string | null;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: string;
  sentAt: string | null;
  attachments: NormalizedAttachment[];
  /** Header names are lower-cased; repeated headers are joined with ", ". */
  headers: Record<string, string>;
}
