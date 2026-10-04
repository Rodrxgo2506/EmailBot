import type { InboxFilter } from "@emailbot/types";

/*
 * Inbox filters live in the URL (?view=&category=&account=&bot=&q=&page=) so
 * views can be bookmarked and the back button works. `toEmailQuery`
 * translates them into the query parameters of GET /api/emails.
 */

export const INBOX_VIEWS = ["all", "unread", "important", "attachments", "archived"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const INBOX_PAGE_SIZE = 25;

export interface InboxFilters {
  view: InboxView;
  categoryId: string | null;
  accountId: string | null;
  /** Emails routed to a bot (EmailBot V2). */
  botId?: string | null;
  search: string;
  page: number;
}

const DEFAULT_VIEW_BY_SETTING: Record<InboxFilter, InboxView> = {
  ALL: "all",
  UNREAD: "unread",
  IMPORTANT: "important",
  ATTACHMENTS: "attachments"
};

export function defaultView(setting: InboxFilter | undefined): InboxView {
  return setting ? DEFAULT_VIEW_BY_SETTING[setting] : "all";
}

export function parseInboxFilters(params: URLSearchParams, fallbackView: InboxView = "all"): InboxFilters {
  const view = params.get("view");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    view: INBOX_VIEWS.includes(view as InboxView) ? (view as InboxView) : fallbackView,
    categoryId: params.get("category") || null,
    accountId: params.get("account") || null,
    botId: params.get("bot") || null,
    search: (params.get("q") ?? "").slice(0, 200),
    page: Number.isFinite(page) && page > 0 ? page : 1
  };
}

export function serializeInboxFilters(filters: InboxFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", filters.view);
  if (filters.categoryId) params.set("category", filters.categoryId);
  if (filters.accountId) params.set("account", filters.accountId);
  if (filters.botId) params.set("bot", filters.botId);
  if (filters.search.trim()) params.set("q", filters.search.trim());
  if (filters.page > 1) params.set("page", String(filters.page));
  return params;
}

/** Query string values accepted by emailListQuerySchema in @emailbot/validation. */
export function toEmailQuery(filters: InboxFilters): Record<string, string | number | boolean | undefined> {
  return {
    page: filters.page,
    pageSize: INBOX_PAGE_SIZE,
    // Archived mail only appears in the "archived" view.
    isArchived: filters.view === "archived",
    isRead: filters.view === "unread" ? false : undefined,
    isImportant: filters.view === "important" ? true : undefined,
    hasAttachments: filters.view === "attachments" ? true : undefined,
    categoryId: filters.categoryId ?? undefined,
    accountId: filters.accountId ?? undefined,
    botId: filters.botId ?? undefined,
    search: filters.search.trim() || undefined
  };
}
