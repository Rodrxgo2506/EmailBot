import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import { usePortalApi } from "./portal-context";
import { portalKeys } from "./portal-queries";
import { lastSyncText, SYNC_MAX_WAIT_MS, SYNC_MESSAGES, SYNC_POLL_INTERVAL_MS, syncOutcome, type SyncUiState } from "./portal-sync-model";

/**
 * "Actualizar": asks the backend to sync now (POST /api/portal/sync, fast),
 * polls GET /api/portal/sync every 2 s while it runs (no WebSocket), then
 * refreshes the inbox through TanStack Query (no page reload) and tells
 * whether new mail arrived. Repeated clicks are blocked while running; the
 * backend also limits one request per customer every 30 s. Nothing but the
 * session cookie is sent (no customer / organization / bot / account id).
 */
export function PortalSyncButton({ latestDeliveryId, refreshInbox }: { latestDeliveryId: string | undefined; refreshInbox: () => Promise<string | undefined> }) {
  const api = usePortalApi();
  const client = useQueryClient();
  const [state, setState] = useState<SyncUiState>("idle");
  const startedAt = useRef(0);
  const baseline = useRef<string | undefined>(undefined);
  const finishing = useRef(false);
  // A mutation (not a direct call): a 401 then reaches the portal's session-expired handler.
  const request = useMutation({ mutationFn: () => api.sync() });

  const status = useQuery({
    queryKey: portalKeys.syncStatus,
    queryFn: () => api.syncStatus(),
    refetchInterval: state === "running" ? SYNC_POLL_INTERVAL_MS : false,
    staleTime: 15_000
  });

  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    try {
      const latest = await refreshInbox();
      void client.invalidateQueries({ queryKey: portalKeys.filters });
      setState(syncOutcome(baseline.current, latest));
    } catch {
      setState("error");
    } finally {
      finishing.current = false;
    }
  };

  // While running: done when the backend reports no pending sync (or after a bounded wait).
  useEffect(() => {
    if (state !== "running" || status.isFetching) return;
    const timedOut = Date.now() - startedAt.current > SYNC_MAX_WAIT_MS;
    if ((status.data && !status.data.running && status.dataUpdatedAt >= startedAt.current) || timedOut) void finish();
  });

  const start = async () => {
    if (state === "running") return;
    baseline.current = latestDeliveryId;
    startedAt.current = Date.now();
    setState("running");
    try {
      const result = await request.mutateAsync();
      if (result.status === "NOTHING_TO_SYNC") {
        await finish();
        return;
      }
      await client.invalidateQueries({ queryKey: portalKeys.syncStatus });
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) setState("rate_limited");
      // A 401 is handled once by the portal provider (back to login); anything else is generic.
      else if (!(error instanceof ApiError && error.status === 401)) setState("error");
    }
  };

  const running = state === "running";
  const message = state === "idle" || running ? null : SYNC_MESSAGES[state];
  const last = lastSyncText(status.data?.lastSyncAt);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void start()} disabled={running} aria-busy={running}>
        <RefreshCw className={running ? "animate-spin" : undefined} /> {running ? "Actualizando..." : "Actualizar"}
      </Button>
      {message ? (
        <span role={state === "error" || state === "rate_limited" ? "alert" : "status"} className={state === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message}
        </span>
      ) : null}
      {last ? <span className="hidden text-xs text-muted-foreground sm:inline">{last}</span> : null}
    </div>
  );
}
