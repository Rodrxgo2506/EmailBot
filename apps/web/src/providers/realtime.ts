import type { RealtimeEvent } from "@emailbot/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { toast } from "sonner";
import { env } from "@/lib/env";
import { queryKeys } from "@/lib/query-keys";
import { supabase } from "@/lib/supabase";
import { connectRealtime, type RealtimeStatus } from "./realtime-connection";

export type { RealtimeStatus } from "./realtime-connection";

const MAX_SEEN = 500;

/**
 * Subscribes to the API Socket.IO server (path /realtime) for the active
 * organization. Session renewal, reconnection and revocation are handled by
 * connectRealtime(); this hook only wires the events into the UI.
 *
 * New processed emails invalidate the inbox/dashboard queries instead of
 * polling. Each email id is handled once (reconnections may resend events).
 * Changing organization or signing out closes the socket (effect cleanup),
 * so there is never more than one connection.
 */
export function useRealtime(organizationId: string | null, userId: string | null): RealtimeStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!organizationId || !userId) return;
    seen.current.clear();

    const connection = connectRealtime({
      organizationId,
      createSocket: (auth) => io(env.apiUrl, { path: "/realtime", transports: ["websocket"], auth }),
      getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
      refreshAccessToken: async () => (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
      onTokenRefreshed: (listener) => {
        // Callbacks must stay synchronous (no Supabase calls inside) to avoid auth deadlocks.
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          if (event === "TOKEN_REFRESHED" && session) listener(session.access_token);
        });
        return () => data.subscription.unsubscribe();
      },
      onStatus: setStatus
    });
    const { socket } = connection;

    const remember = (id: string) => {
      if (seen.current.has(id)) return false;
      if (seen.current.size >= MAX_SEEN) seen.current.clear();
      seen.current.add(id);
      return true;
    };

    socket.on("email.processed", (event: Extract<RealtimeEvent, { type: "email.processed" }>) => {
      if (event.organizationId !== organizationId || !remember(`email:${event.emailId}`)) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails(organizationId) });
      toast(event.important ? "Nuevo correo importante" : "Nuevo correo procesado", {
        description: event.subject ?? undefined
      });
    });

    socket.on("notification", (event: Extract<RealtimeEvent, { type: "notification" }>) => {
      if (event.organizationId !== organizationId || !remember(`notification:${event.emailId}:${event.title}`)) return;
      toast.info(event.title, { description: event.body });
    });

    socket.on("email-account.status", (event: Extract<RealtimeEvent, { type: "email-account.status" }>) => {
      if (event.organizationId !== organizationId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts(organizationId) });
      if (event.status === "ERROR") toast.error("Una cuenta de correo necesita reconectarse");
    });

    return () => connection.close();
  }, [organizationId, userId, queryClient]);

  return organizationId && userId ? status : "disconnected";
}
