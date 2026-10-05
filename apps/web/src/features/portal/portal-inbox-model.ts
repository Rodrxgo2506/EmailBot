import type { PortalInboxParams } from "./portal-api";

/*
 * Portal inbox filter state -> API query parameters. The API filters (inside
 * the session's scope); the UI never filters or re-sorts results itself.
 */

export type InboxView = "all" | "unread" | "important";

export interface InboxFilterState {
  view: InboxView;
  bot: string;
  category: string;
  /** Already debounced. */
  search: string;
  /** yyyy-mm-dd (date inputs), inclusive. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: InboxFilterState = { view: "all", bot: "", category: "", search: "", from: "", to: "" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Local day start as ISO; `to` is exclusive on the API, so the day after is sent. */
function dayStart(value: string, offsetDays = 0): string | undefined {
  if (!DAY.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day + offsetDays);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function toInboxParams(state: InboxFilterState): Omit<PortalInboxParams, "cursor" | "limit"> {
  const search = state.search.trim().slice(0, 100);
  return {
    unread: state.view === "unread" ? true : undefined,
    important: state.view === "important" ? true : undefined,
    bot: state.bot || undefined,
    category: state.category || undefined,
    search: search || undefined,
    from: dayStart(state.from),
    to: dayStart(state.to, 1)
  };
}

export function hasActiveFilters(state: InboxFilterState): boolean {
  return (
    state.view !== "all" || Boolean(state.bot) || Boolean(state.category) || Boolean(state.search.trim()) || Boolean(state.from) || Boolean(state.to)
  );
}
