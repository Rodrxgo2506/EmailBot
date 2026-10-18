/*
 * IMAP positions (INBOX only): "imap:v1:<UIDVALIDITY>:<last UID handled>" and
 * "<UIDVALIDITY>:<UID>". Defined in @emailbot/shared (imap-cursor.ts) because the
 * API writes the initial cursor when a mailbox is connected (E3).
 */
export { formatImapCursor, formatImapMessageId, parseImapCursor, parseImapMessageId, type ImapCursor, type ImapMessageRef } from "@emailbot/shared";
