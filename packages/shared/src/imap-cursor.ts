/*
 * IMAP positions (INBOX only).
 *
 *   cursor (email_accounts.sync_cursor):  "imap:v1:<UIDVALIDITY>:<last UID handled>"
 *   provider message id:                  "<UIDVALIDITY>:<UID>"
 *
 * A UID only identifies a message together with the mailbox's UIDVALIDITY
 * (RFC 3501 2.3.1.1): when UIDVALIDITY changes every UID may designate another
 * message, so both always travel together. UIDVALIDITY and UID are non-zero
 * 32-bit unsigned integers; a cursor may carry UID 0 ("nothing handled yet").
 * Anything else is rejected, never guessed.
 */

const MAX_UINT32 = 0xffffffff;
const CURSOR = /^imap:v1:([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/;
const MESSAGE_ID = /^([1-9][0-9]{0,9}):([1-9][0-9]{0,9})$/;

export interface ImapCursor {
  uidValidity: number;
  /** Last UID already handled (0: none). */
  uid: number;
}

export interface ImapMessageRef {
  uidValidity: number;
  uid: number;
}

const inRange = (value: number, min: number) => Number.isSafeInteger(value) && value >= min && value <= MAX_UINT32;

/** null = no cursor yet (or a cursor this version cannot read): the caller restarts from the newest message. */
export function parseImapCursor(cursor: string | null | undefined): ImapCursor | null {
  const match = typeof cursor === "string" ? CURSOR.exec(cursor) : null;
  if (!match) return null;
  const uidValidity = Number(match[1]);
  const uid = Number(match[2]);
  return inRange(uidValidity, 1) && inRange(uid, 0) ? { uidValidity, uid } : null;
}

export function formatImapCursor(cursor: ImapCursor): string {
  if (!inRange(cursor.uidValidity, 1) || !inRange(cursor.uid, 0)) throw new Error("Invalid IMAP cursor");
  return `imap:v1:${cursor.uidValidity}:${cursor.uid}`;
}

export function parseImapMessageId(id: string): ImapMessageRef | null {
  const match = MESSAGE_ID.exec(id);
  if (!match) return null;
  const uidValidity = Number(match[1]);
  const uid = Number(match[2]);
  return inRange(uidValidity, 1) && inRange(uid, 1) ? { uidValidity, uid } : null;
}

export function formatImapMessageId(ref: ImapMessageRef): string {
  if (!inRange(ref.uidValidity, 1) || !inRange(ref.uid, 1)) throw new Error("Invalid IMAP message reference");
  return `${ref.uidValidity}:${ref.uid}`;
}
