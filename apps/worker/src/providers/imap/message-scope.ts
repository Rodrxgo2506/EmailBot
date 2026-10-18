import { AsyncLocalStorage } from "node:async_hooks";
import { parseImapMessageId } from "./cursor.js";
import { extractImapAttachments, imapAttachmentIndex } from "./normalize.js";

/*
 * IMAP A2.1 (C): reuse, within ONE job, the message source that job already downloaded.
 *
 * Every attachment download of the adapter used to read the whole message again (up to IMAP_MAX_MESSAGE_BYTES,
 * 10 MiB): with a slow server and a run budget, a message with many attachments could need more runs than the
 * recovery allows and end FAILED with contents missing. Now the job runner opens a scope per IMAP email-processing
 * job (withImapMessageScope, job-processors.ts); inside it the adapter remembers the source it read (fetchMessage,
 * or a first attachment download) and serves the next attachments of THAT message from memory:
 *
 *   - key: the account id + UIDVALIDITY + UID of the message (never another account, mailbox generation or UID);
 *     a request for any other key goes to the server as before;
 *   - one message per scope (a new one replaces the old one), only sources up to the adapter's maxMessageBytes;
 *     after the first extraction only the decoded attachments are kept (their total is at most the source size);
 *   - the scope belongs to one job: AsyncLocalStorage, never shared between jobs, closed (and emptied) when the
 *     job ends - success, failure, budget or shutdown; a late result of a cancelled read is never kept.
 *
 * Memory: at most one message (<= maxMessageBytes, plus the transient parse) per IMAP email-processing job, i.e.
 * per IMAP processing slot of the process (WORKER_IMAP_PROCESSING_CONCURRENCY). Outside a scope (synchronization
 * runs, Gmail / Microsoft) nothing is remembered and nothing changes.
 */

export interface ImapMessageKey {
  accountId: string;
  uidValidity: number;
  uid: number;
}

interface Entry {
  key: ImapMessageKey;
  /** Released once the attachments are extracted. */
  source: Uint8Array | null;
  attachments: Promise<Uint8Array[] | null> | null;
  bytes: number;
}

class MessageScope {
  closed = false;
  entry: Entry | null = null;
}

const scopes = new AsyncLocalStorage<MessageScope>();
const open = new Set<MessageScope>();

const sameKey = (a: ImapMessageKey, b: ImapMessageKey) => a.accountId === b.accountId && a.uidValidity === b.uidValidity && a.uid === b.uid;

function liveEntry(key: ImapMessageKey): Entry | null {
  const scope = scopes.getStore();
  const entry = scope && !scope.closed ? scope.entry : null;
  return entry && sameKey(entry.key, key) ? entry : null;
}

/** Runs one IMAP job with its own message scope; the scope is emptied when `fn` settles, whatever the outcome. */
export async function withImapMessageScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope = new MessageScope();
  open.add(scope);
  try {
    return await scopes.run(scope, fn);
  } finally {
    scope.closed = true;
    scope.entry = null;
    open.delete(scope);
  }
}

/** Remembers the full source of a message read by the current job (no-op outside a scope or above `maxBytes`). */
export function rememberImapSource(key: ImapMessageKey, source: Uint8Array, maxBytes: number): void {
  const scope = scopes.getStore();
  if (!scope || scope.closed || source.byteLength > maxBytes) return;
  scope.entry = { key: { ...key }, source, attachments: null, bytes: source.byteLength };
}

/** True when the current job holds the source of this message (an attachment of it needs no IMAP operation). */
export function imapMessageReusable(key: ImapMessageKey): boolean {
  return liveEntry(key) !== null;
}

/** imapMessageReusable for an account and a provider message id ("<UIDVALIDITY>:<UID>"). */
export function imapMessageReusableById(accountId: string, providerMessageId: string): boolean {
  const ref = parseImapMessageId(providerMessageId);
  return ref !== null && imapMessageReusable({ accountId, uidValidity: ref.uidValidity, uid: ref.uid });
}

/**
 * One attachment of a message the current job already read: its bytes, null when that message has no such
 * attachment (or cannot be parsed), undefined when the job does not hold this message (read it from the server).
 * The message is parsed once; the source is then released and only the attachments are kept.
 */
export async function reusedImapAttachment(key: ImapMessageKey, providerAttachmentId: string): Promise<Uint8Array | null | undefined> {
  const entry = liveEntry(key);
  if (!entry) return undefined;
  const index = imapAttachmentIndex(providerAttachmentId);
  if (index === null) return null;
  if (!entry.attachments) {
    const source = entry.source as Uint8Array;
    entry.attachments = extractImapAttachments(source).then((list) => {
      entry.source = null;
      entry.bytes = list ? list.reduce((sum, bytes) => sum + bytes.byteLength, 0) : 0;
      return list;
    });
  }
  const list = await entry.attachments;
  return list?.[index] ?? null;
}

/** Open scopes and the bytes they hold (diagnostics and tests). */
export function imapMessageScopeStats(): { open: number; bytes: number } {
  let bytes = 0;
  for (const scope of open) bytes += scope.entry?.bytes ?? 0;
  return { open: open.size, bytes };
}
