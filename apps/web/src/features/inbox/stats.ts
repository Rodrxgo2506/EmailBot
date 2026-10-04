import type { EmailSummary, Paginated } from "@emailbot/types";
import { useQuery } from "@tanstack/react-query";
import { api, buildQuery } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export interface InboxStats {
  total: number;
  unread: number;
  important: number;
  recent: EmailSummary[];
}

/**
 * Dashboard counters derived from GET /api/emails `total` (pageSize=1) —
 * there is no dedicated stats endpoint. Refreshed by realtime invalidation
 * (key lives under the organization's "emails" namespace).
 */
export function useInboxStats() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.stats(organizationId),
    queryFn: async (): Promise<InboxStats> => {
      const list = (params: Record<string, string | number | boolean>) =>
        api.get<Paginated<EmailSummary>>(`/api/emails${buildQuery({ isArchived: false, ...params })}`);
      const [recent, unread, important] = await Promise.all([
        list({ pageSize: 8 }),
        list({ pageSize: 1, isRead: false }),
        list({ pageSize: 1, isImportant: true })
      ]);
      return { total: recent.total, unread: unread.total, important: important.total, recent: recent.items };
    }
  });
}
