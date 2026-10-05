import type { NormalizedEmail } from "@emailbot/types";
import { z } from "zod";
import { decodeBase64Url, ProviderHttpError, providerGet, providerPost } from "../http.js";
import type { ChangeSet, ProviderAdapter, ProviderContext } from "../types.js";
import { normalizeGmailMessage } from "./normalize.js";

/*
 * Gmail REST adapter (https://developers.google.com/gmail/api/reference/rest).
 *
 * Sync model: the cursor is a Gmail historyId (email_accounts.sync_cursor).
 * New messages are discovered with users.history.list(historyTypes=
 * messageAdded, labelId=INBOX), all pages. A run is bounded (maxMessages /
 * MAX_HISTORY_PAGES); when it stops early the cursor proposed is the id of
 * the last history record fully included, never the mailbox's latest id, so
 * no record is skipped. The caller persists it only after processing.
 *
 * History gap: when startHistoryId is too old Gmail answers 404. The adapter
 * reports it (historyGap) instead of jumping to "now"; the caller recovers
 * with recoverMessageIds (bounded messages.list of recent INBOX mail).
 *
 * Push: watch() registers users.watch on the configured Pub/Sub topic (INBOX
 * only). It works with the existing gmail.readonly scope.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_HISTORY_PAGES = 20;
const DEFAULT_MAX_MESSAGES = 200;
const RECOVERY_PAGE_SIZE = 100;

const historyId = z.union([z.string(), z.number()]).transform(String);

const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: historyId.optional(),
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional()
      })
    )
    .optional(),
  historyId: historyId.optional(),
  nextPageToken: z.string().optional()
});

const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional()
});

const profileSchema = z.object({ historyId });
const watchSchema = z.object({ historyId, expiration: z.union([z.string(), z.number()]).transform(Number) });
const attachmentSchema = z.object({ data: z.string() });

export function createGmailAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  async function currentHistoryId(context: ProviderContext): Promise<string> {
    return profileSchema.parse(await providerGet(context, `${API}/profile`, fetchImpl)).historyId;
  }

  return {
    provider: "GMAIL",

    async listNewMessageIds(context, options = {}): Promise<ChangeSet> {
      const cursor = context.account.syncCursor;
      // No cursor: start from "now" (historical mail is never bulk-imported).
      if (!cursor) return { messageIds: [], nextCursor: await currentHistoryId(context) };

      const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let latestHistoryId = cursor;
      let lastRecordId: string | null = null;

      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const url = new URL(`${API}/history`);
        url.searchParams.set("startHistoryId", cursor);
        url.searchParams.set("historyTypes", "messageAdded");
        url.searchParams.set("labelId", "INBOX");
        url.searchParams.set("maxResults", "500");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        let body: z.infer<typeof historySchema>;
        try {
          body = historySchema.parse(await providerGet(context, url.toString(), fetchImpl));
        } catch (error) {
          // 404: startHistoryId is older than Gmail's history window. Reported, never skipped silently.
          if (error instanceof ProviderHttpError && error.status === 404) {
            return { messageIds: [], nextCursor: cursor, historyGap: true };
          }
          throw error;
        }

        for (const record of body.history ?? []) {
          const added = (record.messagesAdded ?? []).map((entry) => entry.message.id).filter((id) => !ids.has(id));
          // Stop at a record boundary: the cursor then points to the last record fully included.
          if (ids.size > 0 && ids.size + added.length > maxMessages && record.id) {
            return { messageIds: [...ids], nextCursor: lastRecordId ?? cursor, hasMore: true };
          }
          for (const id of added) ids.add(id);
          if (record.id) lastRecordId = record.id;
        }
        if (body.historyId) latestHistoryId = body.historyId;
        if (!body.nextPageToken) return { messageIds: [...ids], nextCursor: latestHistoryId };
        pageToken = body.nextPageToken;
      }

      // Page limit reached with more history left: continue from the last record included.
      return { messageIds: [...ids], nextCursor: lastRecordId ?? cursor, hasMore: true };
    },

    async recoverMessageIds(context, { since, maxMessages }) {
      // Take the mailbox position FIRST: mail arriving during the listing is caught by the next sync.
      const nextCursor = await currentHistoryId(context);
      const ids: string[] = [];
      let pageToken: string | undefined;
      let truncated = false;
      do {
        const url = new URL(`${API}/messages`);
        url.searchParams.set("labelIds", "INBOX");
        url.searchParams.set("maxResults", String(Math.min(RECOVERY_PAGE_SIZE, maxMessages - ids.length)));
        url.searchParams.set("q", `after:${Math.floor(since.getTime() / 1000)}`);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = messageListSchema.parse(await providerGet(context, url.toString(), fetchImpl));
        for (const message of body.messages ?? []) ids.push(message.id);
        pageToken = body.nextPageToken;
        if (pageToken && ids.length >= maxMessages) truncated = true;
      } while (pageToken && ids.length < maxMessages);
      // Oldest first, like history order.
      return { messageIds: [...new Set(ids)].reverse(), nextCursor, truncated };
    },

    async watch(context, topicName) {
      const body = watchSchema.parse(
        await providerPost(context, `${API}/watch`, { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }, fetchImpl)
      );
      return { expiresAt: new Date(body.expiration).toISOString() };
    },

    async fetchMessage(context, providerMessageId): Promise<NormalizedEmail> {
      const raw = await providerGet(
        context,
        `${API}/messages/${encodeURIComponent(providerMessageId)}?format=full`,
        fetchImpl
      );
      return normalizeGmailMessage(raw, context.account.id);
    },

    async downloadAttachment(context, providerMessageId, providerAttachmentId) {
      const body = attachmentSchema.parse(
        await providerGet(
          context,
          `${API}/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(providerAttachmentId)}`,
          fetchImpl
        )
      );
      return decodeBase64Url(body.data);
    }
  };
}
