import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { env } from "@/lib/env";
import { createPortalApi, type PortalApi } from "./portal-api";
import { PortalProvider } from "./portal-context";
import { PortalEmailPage } from "./portal-email-page";
import { PortalInboxPage } from "./portal-inbox-page";
import { PortalLayout } from "./portal-layout";
import { PortalLoginPage } from "./portal-login-page";
import { createPortalRealtime, type PortalRealtime } from "./portal-realtime";

/**
 * Customer portal (EmailBot V2), mounted at /portal/* outside the panel's
 * Supabase session and organization providers:
 *   /portal/login               Access ID sign-in
 *   /portal                     inbox (refreshed in realtime, phase 7)
 *   /portal/email/:deliveryId   email detail
 *
 * `api` / `realtime` are injected in tests; an injected api without a
 * realtime connector runs without realtime (no socket to the real API).
 */
export function PortalApp({ api, realtime }: { api?: PortalApi; realtime?: PortalRealtime | null }) {
  const [client] = useState(() => api ?? createPortalApi({ baseUrl: env.apiUrl }));
  const [connector] = useState<PortalRealtime | null>(() => (realtime !== undefined ? realtime : api ? null : createPortalRealtime(env.apiUrl)));
  return (
    <PortalProvider api={client} realtime={connector}>
      <Routes>
        <Route path="login" element={<PortalLoginPage />} />
        <Route element={<PortalLayout />}>
          <Route index element={<PortalInboxPage />} />
          <Route path="email/:deliveryId" element={<PortalEmailPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </PortalProvider>
  );
}
