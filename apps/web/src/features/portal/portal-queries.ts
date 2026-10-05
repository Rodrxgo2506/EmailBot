import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePortalApi, PUBLIC_MUTATION } from "./portal-context";
import type { PortalInboxParams } from "./portal-api";

/* Portal queries. Keys live under ["portal", ...] in the portal's own QueryClient. */

export const portalKeys = {
  all: ["portal"] as const,
  me: ["portal", "me"] as const,
  filters: ["portal", "filters"] as const,
  inbox: (params: Omit<PortalInboxParams, "cursor">) => ["portal", "inbox", params] as const,
  inboxAll: ["portal", "inbox"] as const,
  email: (deliveryId: string) => ["portal", "email", deliveryId] as const
};

export const PORTAL_PAGE_SIZE = 25;

export function usePortalMe() {
  const api = usePortalApi();
  return useQuery({ queryKey: portalKeys.me, queryFn: () => api.me(), staleTime: 60_000 });
}

export function usePortalFilters() {
  const api = usePortalApi();
  return useQuery({ queryKey: portalKeys.filters, queryFn: () => api.filters(), staleTime: 60_000 });
}

/** Cursor pagination: the opaque nextCursor from the API is passed back untouched. */
export function usePortalInbox(params: Omit<PortalInboxParams, "cursor" | "limit">) {
  const api = usePortalApi();
  return useInfiniteQuery({
    queryKey: portalKeys.inbox(params),
    queryFn: ({ pageParam }) => api.inbox({ ...params, limit: PORTAL_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  });
}

/** Opening an email marks it read (server side): the inbox is refreshed afterwards. */
export function usePortalEmail(deliveryId: string) {
  const api = usePortalApi();
  const client = useQueryClient();
  return useQuery({
    queryKey: portalKeys.email(deliveryId),
    queryFn: async () => {
      const email = await api.email(deliveryId);
      void client.invalidateQueries({ queryKey: portalKeys.inboxAll });
      return email;
    }
  });
}

export function usePortalLogin() {
  const api = usePortalApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accessId: string) => api.login(accessId),
    meta: PUBLIC_MUTATION,
    onSuccess: () => client.clear()
  });
}

export function usePortalLogout() {
  const api = usePortalApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    meta: PUBLIC_MUTATION,
    // The session is server-side: whatever the answer, the local portal state is dropped.
    onSettled: () => client.clear()
  });
}
