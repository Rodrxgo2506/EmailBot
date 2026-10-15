import { imapProtocolLimitFailure } from "@emailbot/shared";
import type { NormalizedAttachment, NormalizedEmail } from "@emailbot/types";
import { ProviderHttpError } from "../http.js";
import {
  ProviderAuthError,
  ProviderNotImplementedError,
  type ChangeSet,
  type ImapCredentials,
  type ProviderAdapter,
  type ProviderContext,
  type RecoverySet
} from "../types.js";
import { createImapConnector, imapPoolKey, readImapEndpoint, type ImapClient, type ImapConnector } from "./connection.js";
import { formatImapCursor, formatImapMessageId, parseImapCursor, parseImapMessageId } from "./cursor.js";
import { assertImapOperationAlive, IMAP_OPERATION_DEADLINES, runImapOperation, trackImapClient, withinImapPhase } from "./deadline.js";
import { classifyImapError } from "./errors.js";
import { extractImapAttachment, IMAP_MAX_BODY_CHARS, IMAP_MAX_MESSAGE_BYTES, normalizeImapMessage, snippetOf, type ImapEnvelope } from "./normalize.js";
import type { ImapConnectionPool } from "./pool.js";

/*
 * IMAP provider.
 *
 * createImapAdapter(): what the registry holds while IMAP synchronization is
 * DISABLED (worker config imapSyncEnabled = false): every method refuses, no
 * connection can be opened.
 *
 * createImapSyncAdapter(): the real adapter (E2), created only when IMAP
 * synchronization is enabled. Same contract as Gmail / Microsoft: it lists and
 * fetches, the existing pipeline (syncAccount / processEmail) does the rest.
 *
 *   - INBOX only, opened with EXAMINE (read-only); messages are read with
 *     BODY.PEEK[] (ImapFlow `source`): nothing is marked \Seen or changed;
 *   - cursor "imap:v1:<UIDVALIDITY>:<UID>" (cursor.ts). No cursor (or one this
 *     version cannot read): the run only records the newest UID; no history is
 *     imported. Another UIDVALIDITY: historyGap, and recoverMessageIds lists
 *     the messages since the last sync (window bounded by syncAccount);
 *   - at most `maxMessages` (200) ids per run, oldest first, `hasMore` set;
 *   - messages up to 10 MB are parsed in full; bigger ones keep their headers
 *     and text parts (bounded), their attachments are listed, not downloadable;
 *   - every connection goes through the E1 checks (connection.ts) and the
 *     process-wide pool (pool.ts: 2 per mailbox, 10 in total, 30 s idle);
 *   - A2: every operation (new connection, listing, one message) has a total
 *     deadline (deadline.ts); on expiry its connection is closed and the
 *     operation fails as transient (retried, never an account ERROR).
 */

/** Registry entry while IMAP synchronization is disabled: an explicit scaffold that refuses everything. */
export function createImapAdapter(): ProviderAdapter {
  return {
    provider: "IMAP",
    listNewMessageIds() {
      return Promise.reject(new ProviderNotImplementedError("IMAP", "synchronization"));
    },
    fetchMessage() {
      return Promise.reject(new ProviderNotImplementedError("IMAP", "message fetch"));
    },
    downloadAttachment() {
      return Promise.reject(new ProviderNotImplementedError("IMAP", "attachment download"));
    }
  };
}

export interface ImapAdapterDeps {
  pool: ImapConnectionPool<ImapClient>;
  /** Default: createImapConnector() (E1 SSRF / TLS checks, then ImapFlow). */
  connect?: ImapConnector;
  maxMessageBytes?: number;
  /** A2 total deadlines (default IMAP_OPERATION_DEADLINES; shorter only in tests). */
  deadlines?: Partial<Record<"connectMs" | "listMs" | "fetchMs", number>>;
}

interface BodyNode {
  part?: string;
  type?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  id?: string;
  childNodes?: BodyNode[];
}

interface MessageInfo {
  size?: number;
  internalDate?: Date | string;
  envelope?: ImapEnvelope;
  bodyStructure?: BodyNode;
  headers?: Buffer;
}

interface Mailbox {
  uidValidity: number;
  uidNext: number;
}

/** Decoded text parts of an oversized message are read up to this many bytes (then cut to IMAP_MAX_BODY_CHARS). */
const OVERSIZED_TEXT_BYTES = IMAP_MAX_BODY_CHARS * 4;

async function readStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    total += buffer.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

function walk(node: BodyNode | undefined, visit: (node: BodyNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

/** Extra days searched before the recovery start (see imapSearchSince). */
export const IMAP_SINCE_MARGIN_DAYS = 2;

/** INTERNALDATE values fetched per FETCH while applying the M1 window (metadata only). */
export const IMAP_DATE_CHUNK = 100;

/**
 * IMAP SEARCH SINCE compares only the DATE part of each message's INTERNALDATE,
 * in that date's own timezone (RFC 3501 6.4.4), while ImapFlow sends the UTC
 * date of the given instant. A message received after `since` can therefore
 * carry an earlier calendar date (e.g. 03:00Z = 22:00 the day before at UTC-5).
 * Searching two days earlier covers every timezone offset (-12h..+14h) and the
 * day boundary; the extra (older) messages are deduplicated downstream, and
 * syncAccount's bound (most recent `maxMessages`) still applies.
 */
export function imapSearchSince(since: Date): Date {
  return new Date(since.getTime() - IMAP_SINCE_MARGIN_DAYS * 24 * 60 * 60 * 1000);
}

const isAttachmentNode = (node: BodyNode) =>
  node.disposition === "attachment" || Boolean(node.dispositionParameters?.filename) || Boolean(node.parameters?.name);

export function createImapSyncAdapter(deps: ImapAdapterDeps): ProviderAdapter {
  const connect = deps.connect ?? createImapConnector();
  const maxMessageBytes = deps.maxMessageBytes ?? IMAP_MAX_MESSAGE_BYTES;
  const deadlines = { ...IMAP_OPERATION_DEADLINES, ...deps.deadlines };

  async function credentialsOf(context: ProviderContext): Promise<ImapCredentials> {
    if (!context.getImapCredentials) throw new ProviderAuthError("The IMAP login is not available", "IMAP_CREDENTIALS_MISSING");
    return context.getImapCredentials();
  }

  /**
   * Runs `fn` on INBOX opened read-only (EXAMINE), on a pooled connection that passed the E1 checks.
   * A2: the whole operation (a new connection included, itself bounded by connectMs) has a total deadline;
   * on expiry the connection is closed and the operation rejects with ImapDeadlineError (transient).
   */
  async function withInbox<T>(context: ProviderContext, kind: "list" | "fetch", fn: (client: ImapClient, mailbox: Mailbox) => Promise<T>): Promise<T> {
    try {
      const endpoint = readImapEndpoint(context.account);
      const credentials = await credentialsOf(context);
      const key = imapPoolKey(context.account, endpoint, credentials.username);
      return await runImapOperation(kind, kind === "list" ? deadlines.listMs : deadlines.fetchMs, () =>
        deps.pool.use(
          key,
          // An operation that expired while waiting for a pool slot never opens a connection afterwards.
          () => {
            assertImapOperationAlive();
            return withinImapPhase("connect", deadlines.connectMs, () => connect(endpoint, credentials));
          },
          async (client) => {
            // A pooled connection is closed by this operation's deadline too; an expired operation runs nothing.
            trackImapClient(client);
            assertImapOperationAlive();
            try {
              // A pooled connection may still have INBOX selected by an earlier operation: ImapFlow
              // would not EXAMINE it again, leaving UIDNEXT / UIDVALIDITY stale. Leave it first. CLOSE
              // on a mailbox opened read-only never expunges (RFC 3501 6.4.2); a read-write one is
              // never opened by this adapter and is refused rather than closed.
              const open = client.mailbox;
              if (open) {
                if (open.readOnly !== true) throw new Error("Unexpected read-write mailbox on an IMAP sync connection");
                await client.mailboxClose();
              }
              const lock = await client.getMailboxLock("INBOX", { readOnly: true });
              try {
                const mailbox = client.mailbox;
                if (!mailbox) throw new Error("INBOX is not open");
                return await fn(client, { uidValidity: Number(mailbox.uidValidity), uidNext: Number(mailbox.uidNext) });
              } finally {
                lock.release();
              }
            } catch (error) {
              // E6.1: an answer above the protocol limits closed the connection, and the pending command
              // only saw "connection not available". Report the real cause (security: never retried).
              throw imapProtocolLimitFailure(client) ?? error;
            }
          }
        )
      );
    } catch (error) {
      throw classifyImapError(error);
    }
  }

  const messageId = (mailbox: Mailbox, uid: number) => formatImapMessageId({ uidValidity: mailbox.uidValidity, uid });
  const newest = (mailbox: Mailbox) => Math.max(0, mailbox.uidNext - 1);

  async function uidsOf(client: ImapClient, query: Record<string, unknown>): Promise<number[]> {
    const found = await client.search(query, { uid: true });
    return (Array.isArray(found) ? found : []).filter((uid) => Number.isSafeInteger(uid) && uid > 0).sort((a, b) => a - b);
  }

  /** INTERNALDATE of each UID (one FETCH of metadata only; no body is read). */
  async function internalDates(client: ImapClient, uids: number[]): Promise<Map<number, Date>> {
    const dates = new Map<number, Date>();
    if (uids.length === 0) return dates;
    for await (const message of client.fetch(uids, { uid: true, internalDate: true }, { uid: true })) {
      const value = (message as unknown as { uid?: number; internalDate?: Date | string }).internalDate;
      const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
      if (message.uid && date && !Number.isNaN(date.getTime())) dates.set(message.uid, date);
    }
    return dates;
  }

  async function listNewMessageIds(context: ProviderContext, options: { maxMessages?: number; since?: Date } = {}): Promise<ChangeSet> {
    const max = Math.max(1, options.maxMessages ?? 200);
    return withInbox(context, "list", async (client, mailbox) => {
      const top = newest(mailbox);
      const cursor = parseImapCursor(context.account.syncCursor);
      // No (readable) cursor: start at the newest message, import nothing.
      if (!cursor) return { messageIds: [], nextCursor: formatImapCursor({ uidValidity: mailbox.uidValidity, uid: top }) };
      // The mailbox was recreated / renumbered: the stored UIDs mean nothing any more.
      if (cursor.uidValidity !== mailbox.uidValidity) return { messageIds: [], nextCursor: null, historyGap: true };
      if (top <= cursor.uid) return { messageIds: [], nextCursor: formatImapCursor(cursor) };

      // "N:*" also returns the highest message when it is below N: keep only UIDs after the cursor.
      const uids = (await uidsOf(client, { uid: `${cursor.uid + 1}:*` })).filter((uid) => uid > cursor.uid);
      if (options.since) return withinWindow(client, mailbox, cursor.uid, top, uids, max, options.since);
      const taken = uids.slice(0, max);
      const hasMore = uids.length > max;
      // Nothing left up to `top` (expunged meanwhile): the cursor may move to `top`.
      const last = taken.length > 0 ? (taken[taken.length - 1] as number) : top;
      return {
        messageIds: taken.map((uid) => messageId(mailbox, uid)),
        nextCursor: formatImapCursor({ uidValidity: mailbox.uidValidity, uid: last }),
        hasMore
      };
    });
  }

  /**
   * IMAP M1 (decision B): the new UIDs after the cursor, oldest first, restricted to messages received since
   * `since` (exact INTERNALDATE; candidates from a timezone-proof SEARCH SINCE two days earlier). At most `max`
   * messages are taken; the cursor stops at the last UID examined, so nothing that was not taken or deliberately
   * skipped is ever jumped (the rest continues in the next run). Older messages are counted in `outOfWindow`,
   * never fetched. INTERNALDATE is read in chunks, only for the candidates this run may take.
   */
  async function withinWindow(client: ImapClient, mailbox: Mailbox, after: number, top: number, uids: number[], max: number, since: Date): Promise<ChangeSet> {
    const candidates = new Set((await uidsOf(client, { uid: `${after + 1}:*`, since: imapSearchSince(since) })).filter((uid) => uid > after));
    const candidateList = uids.filter((uid) => candidates.has(uid));
    const dates = new Map<number, Date>();
    let fetched = 0;
    let candidateIndex = 0;
    const taken: number[] = [];
    const outOfWindowUids: number[] = [];
    let last = after;
    let hasMore = false;
    for (const uid of uids) {
      if (taken.length >= max) {
        hasMore = true;
        break;
      }
      let inWindow = false;
      if (candidates.has(uid)) {
        if (candidateIndex >= fetched) {
          const chunk = candidateList.slice(fetched, fetched + IMAP_DATE_CHUNK);
          fetched += chunk.length;
          for (const [chunkUid, date] of await internalDates(client, chunk)) dates.set(chunkUid, date);
        }
        candidateIndex += 1;
        const date = dates.get(uid);
        // An unknown INTERNALDATE is kept (deduplicated downstream), as in recoverMessageIds.
        inWindow = date === undefined || date.getTime() >= since.getTime();
      }
      if (inWindow) taken.push(uid);
      else outOfWindowUids.push(uid);
      last = uid;
    }
    // Everything listed was examined: no UID up to `top` is left (any gap was expunged), the cursor may reach it.
    if (!hasMore) last = Math.max(last, top);
    return {
      messageIds: taken.map((uid) => messageId(mailbox, uid)),
      nextCursor: formatImapCursor({ uidValidity: mailbox.uidValidity, uid: last }),
      hasMore,
      outOfWindow: outOfWindowUids.length,
      outOfWindowUids
    };
  }

  async function recoverMessageIds(context: ProviderContext, options: { since: Date; maxMessages: number }): Promise<RecoverySet> {
    return withInbox(context, "list", async (client, mailbox) => {
      // Position taken before listing: anything arriving meanwhile is picked up by the next run.
      const top = newest(mailbox);
      // Coarse, timezone-proof candidates (2 days earlier), then the exact instant from INTERNALDATE:
      // nothing received before `since` is imported. An unknown date is kept (deduplicated downstream).
      const candidates = (await uidsOf(client, { since: imapSearchSince(options.since) })).filter((uid) => uid <= top);
      const received = await internalDates(client, candidates);
      const uids = candidates.filter((uid) => {
        const date = received.get(uid);
        return date === undefined || date.getTime() >= options.since.getTime();
      });
      const max = Math.max(1, options.maxMessages);
      return {
        messageIds: uids.slice(-max).map((uid) => messageId(mailbox, uid)),
        nextCursor: formatImapCursor({ uidValidity: mailbox.uidValidity, uid: top }),
        truncated: uids.length > max
      };
    });
  }

  /** Headers + bounded text parts of a message above the size limit; attachments listed, not downloadable. */
  async function oversized(client: ImapClient, uid: number, providerMessageId: string, info: MessageInfo, accountId: string): Promise<NormalizedEmail> {
    const attachments: NormalizedAttachment[] = [];
    let textPart: BodyNode | null = null;
    let htmlPart: BodyNode | null = null;
    walk(info.bodyStructure, (node) => {
      if (node.childNodes?.length) return;
      if (isAttachmentNode(node)) {
        attachments.push({
          providerAttachmentId: null,
          filename: (node.dispositionParameters?.filename ?? node.parameters?.name ?? "attachment").slice(0, 500),
          contentType: node.type ?? null,
          size: typeof node.size === "number" ? node.size : null,
          contentId: node.id ? node.id.replace(/^<|>$/g, "").slice(0, 1000) : null,
          isInline: node.disposition === "inline"
        });
      } else if (node.type === "text/plain" && !textPart) textPart = node;
      else if (node.type === "text/html" && !htmlPart) htmlPart = node;
    });
    // The root of a single-part message has no part number (ImapFlow numbers only the children of a
    // multipart). Its body is part "1" (RFC 3501 6.4.5): ImapFlow's download() then reads BODY.PEEK[TEXT]
    // in partial chunks and decodes it with the message headers. Never "" (that would be the whole message).
    const partOf = (node: BodyNode): string | undefined => node.part ?? (node === info.bodyStructure && !node.childNodes?.length ? "1" : undefined);
    const download = async (node: BodyNode | null): Promise<string | null> => {
      const part = node ? partOf(node) : undefined;
      if (!part) return null;
      const result = await client.download(String(uid), part, { uid: true, maxBytes: OVERSIZED_TEXT_BYTES });
      const content = result && "content" in result ? result.content : null;
      if (!content) return null;
      const text = (await readStream(content, OVERSIZED_TEXT_BYTES)).toString("utf8").slice(0, IMAP_MAX_BODY_CHARS);
      return text.length > 0 ? text : null;
    };
    const headersOnly = Buffer.concat([info.headers ?? Buffer.alloc(0), Buffer.from("\r\n")]);
    const email = await normalizeImapMessage(
      headersOnly,
      { providerMessageId, internalDate: info.internalDate, envelope: info.envelope },
      accountId,
      { oversizedAttachments: attachments }
    );
    const textBody = await download(textPart);
    const htmlBody = await download(htmlPart);
    return { ...email, textBody, htmlBody, snippet: snippetOf(textBody, htmlBody) ?? email.snippet };
  }

  async function fetchSource(client: ImapClient, uid: number): Promise<Buffer | null> {
    const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    const source = full ? (full as unknown as { source?: Buffer }).source : undefined;
    return source ?? null;
  }

  async function fetchMessage(context: ProviderContext, providerMessageId: string): Promise<NormalizedEmail> {
    const ref = parseImapMessageId(providerMessageId);
    if (!ref) throw new ProviderHttpError("Invalid IMAP message id", 404);
    return withInbox(context, "fetch", async (client, mailbox) => {
      if (ref.uidValidity !== mailbox.uidValidity) throw new ProviderHttpError("The IMAP message is no longer available", 404);
      const meta = await client.fetchOne(
        String(ref.uid),
        { uid: true, size: true, internalDate: true, envelope: true, bodyStructure: true, headers: true },
        { uid: true }
      );
      if (!meta) throw new ProviderHttpError("The IMAP message is no longer available", 404);
      const info = meta as unknown as MessageInfo;
      if ((info.size ?? 0) > maxMessageBytes) return oversized(client, ref.uid, providerMessageId, info, context.account.id);

      const source = await fetchSource(client, ref.uid);
      if (!source) throw new ProviderHttpError("The IMAP message is no longer available", 404);
      return normalizeImapMessage(source, { providerMessageId, internalDate: info.internalDate, envelope: info.envelope }, context.account.id);
    });
  }

  async function downloadAttachment(context: ProviderContext, providerMessageId: string, providerAttachmentId: string): Promise<Uint8Array> {
    const ref = parseImapMessageId(providerMessageId);
    if (!ref) throw new ProviderHttpError("Invalid IMAP message id", 404);
    return withInbox(context, "fetch", async (client, mailbox) => {
      if (ref.uidValidity !== mailbox.uidValidity) throw new ProviderHttpError("The IMAP message is no longer available", 404);
      const meta = await client.fetchOne(String(ref.uid), { uid: true, size: true }, { uid: true });
      const size = meta ? ((meta as unknown as MessageInfo).size ?? 0) : 0;
      if (!meta || size > maxMessageBytes) throw new ProviderHttpError("The IMAP attachment is not available", 404);
      const source = await fetchSource(client, ref.uid);
      const content = source ? await extractImapAttachment(source, providerAttachmentId) : null;
      if (!content) throw new ProviderHttpError("The IMAP attachment is not available", 404);
      return content;
    });
  }

  return { provider: "IMAP", listNewMessageIds, recoverMessageIds, fetchMessage, downloadAttachment };
}
