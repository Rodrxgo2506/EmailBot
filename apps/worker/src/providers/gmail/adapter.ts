import type { NormalizedEmail } from "@emailbot/types";
import { z } from "zod";
import { decodeBase64Url, ProviderHttpError, providerGet } from "../http.js";
import type { ChangeSet, ProviderAdapter, ProviderContext } from "../types.js";
import { normalizeGmailMessage } from "./normalize.js";

/*
 * Gmail REST adapter (https://developers.google.com/gmail/api/reference/rest).
 *
 * Sync model: the cursor is a Gmail historyId. New messages are discovered
 * with users.history.list(historyTypes=messageAdded, labelId=INBOX).
 *
 * Status: implemented against the documented API and unit-tested with
 * mocked HTTP; not yet exercised against a live mailbox. Push delivery
 * (users.watch + Pub/Sub, renewed every 7 days) is NOT registered yet; the
 * worker's polling scheduler covers it in the meantime.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_HISTORY_PAGES = 10;

const historySchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional()
      })
    )
    .optional(),
  historyId: z.union([z.string(), z.number()]).transform(String).optional(),
  nextPageToken: z.string().optional()
});

const profileSchema = z.object({ historyId: z.union([z.string(), z.number()]).transform(String) });
const attachmentSchema = z.object({ data: z.string() });

export function createGmailAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  async function currentHistoryId(context: ProviderContext): Promise<string> {
    return profileSchema.parse(await providerGet(context, `${API}/profile`, fetchImpl)).historyId;
  }

  return {
    provider: "GMAIL",

    async listNewMessageIds(context): Promise<ChangeSet> {
      const cursor = context.account.syncCursor;
      // No cursor: start from "now" (historical mail is never bulk-imported).
      if (!cursor) return { messageIds: [], nextCursor: await currentHistoryId(context) };

      const ids = new Set<string>();
      let pageToken: string | undefined;
      let latestHistoryId = cursor;

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
          // 404: startHistoryId is too old. Restart from now (gap is logged by the caller).
          if (error instanceof ProviderHttpError && error.status === 404) {
            return { messageIds: [], nextCursor: await currentHistoryId(context) };
          }
          throw error;
        }

        for (const entry of body.history ?? []) {
          for (const added of entry.messagesAdded ?? []) ids.add(added.message.id);
        }
        if (body.historyId) latestHistoryId = body.historyId;
        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
      }

      return { messageIds: [...ids], nextCursor: latestHistoryId };
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
