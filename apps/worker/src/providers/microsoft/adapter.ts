import { z } from "zod";
import { decodeBase64Url, providerGet } from "../http.js";
import type { ChangeSet, ProviderAdapter } from "../types.js";
import { normalizeGraphMessage } from "./normalize.js";

/*
 * Microsoft Graph adapter (Outlook / Hotmail / Microsoft 365).
 *
 * Sync model: delta query on the Inbox folder. The cursor is either
 *   - "since:<ISO date>" (set at connection time): first delta round filtered
 *     by receivedDateTime so historical mail is not imported, or
 *   - the @odata.deltaLink returned by the previous round.
 *
 * Status: implemented against the documented API and unit-tested with
 * mocked HTTP; not yet exercised against a live mailbox. Change-notification
 * subscriptions (POST /subscriptions, renewed before expiry) are NOT created
 * yet; the polling scheduler covers it in the meantime.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_DELTA_PAGES = 20;

const MESSAGE_SELECT =
  "id,conversationId,internetMessageId,subject,bodyPreview,body,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,internetMessageHeaders";

const deltaPageSchema = z.object({
  value: z.array(z.object({ id: z.string(), "@removed": z.unknown().optional() }).passthrough()).default([]),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional()
});

const attachmentSchema = z.object({ contentBytes: z.string() });

/** Cursor links are followed only if they point to Graph (defense against tampered cursors). */
function assertGraphUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== "graph.microsoft.com") {
    throw new Error("Refusing to follow a non-Graph delta link");
  }
  return url;
}

function initialDeltaUrl(since: string | null): string {
  const url = new URL(`${GRAPH}/me/mailFolders/inbox/messages/delta`);
  url.searchParams.set("$select", "id,receivedDateTime");
  if (since) url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  return url.toString();
}

export function createMicrosoftAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    provider: "MICROSOFT",

    async listNewMessageIds(context): Promise<ChangeSet> {
      const cursor = context.account.syncCursor;
      let url =
        cursor && cursor.startsWith("https://")
          ? assertGraphUrl(cursor)
          : initialDeltaUrl(cursor?.startsWith("since:") ? cursor.slice("since:".length) : new Date().toISOString());

      const ids = new Set<string>();

      for (let page = 0; page < MAX_DELTA_PAGES; page++) {
        const body = deltaPageSchema.parse(
          await providerGet(context, url, fetchImpl, { prefer: "odata.maxpagesize=200" })
        );

        for (const item of body.value) {
          if (item["@removed"] === undefined) ids.add(item.id);
        }

        if (body["@odata.deltaLink"]) {
          return { messageIds: [...ids], nextCursor: assertGraphUrl(body["@odata.deltaLink"]) };
        }
        if (!body["@odata.nextLink"]) break;
        url = assertGraphUrl(body["@odata.nextLink"]);
      }

      // Page budget exhausted: continue from the last nextLink on the next run.
      return { messageIds: [...ids], nextCursor: url };
    },

    async fetchMessage(context, providerMessageId) {
      const url = new URL(`${GRAPH}/me/messages/${encodeURIComponent(providerMessageId)}`);
      url.searchParams.set("$select", MESSAGE_SELECT);
      url.searchParams.set("$expand", "attachments($select=id,name,contentType,size,isInline)");
      const raw = await providerGet(context, url.toString(), fetchImpl);
      return normalizeGraphMessage(raw, context.account.id);
    },

    async downloadAttachment(context, providerMessageId, providerAttachmentId) {
      const body = attachmentSchema.parse(
        await providerGet(
          context,
          `${GRAPH}/me/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(providerAttachmentId)}`,
          fetchImpl
        )
      );
      return decodeBase64Url(body.contentBytes);
    }
  };
}
