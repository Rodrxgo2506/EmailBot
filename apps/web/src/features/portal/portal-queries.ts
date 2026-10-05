import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { usePortalApi, usePortalRealtime, PUBLIC_MUTATION } from "./portal-context";
import type { PortalInboxParams } from "./portal-api";

/* Portal queries. Keys live under ["portal", ...] in the portal's own QueryClient. */

export const portalKeys = {
  all: ["portal"] as const,
  me: ["portal", "me"] as const,
  filters: ["portal", "filters"] as const,
  inbox: (params: Omit<PortalInboxParams, "cursor">) => ["portal", "inbox", params] as const,
  inboxAll: ["portal", "inbox"] as const,
  email: (deliveryId: string) => ["portal", "email", deliveryId] as const,
  syncStatus: ["portal", "sync"] as const
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

/** Signals arriving close together (several deliveries of one sync) cause one refetch. */
export const PORTAL_REALTIME_DEBOUNCE_MS = 300;

/**
 * EmailBot V2 phase 7: while a session is open, "inbox changed" signals
 * refetch the inbox and the filters (the data still comes from the API with
 * the session's own scope); a revoked session refetches /me, whose 401 sends
 * the customer to the login page through the portal's single 401 handler.
 */
export function usePortalInboxRealtime(enabled: boolean) {
  const realtime = usePortalRealtime();
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled || !realtime) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = realtime({
      onInboxChanged() {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void client.invalidateQueries({ queryKey: portalKeys.inboxAll });
          void client.invalidateQueries({ queryKey: portalKeys.filters });
        }, PORTAL_REALTIME_DEBOUNCE_MS);
      },
      onRevoked() {
        void client.invalidateQueries({ queryKey: portalKeys.me });
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [enabled, realtime, client]);
}
