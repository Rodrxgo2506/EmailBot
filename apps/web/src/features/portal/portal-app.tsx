import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { env } from "@/lib/env";
import { createPortalApi, type PortalApi } from "./portal-api";
import { PortalProvider } from "./portal-context";
import { PortalEmailPage } from "./portal-email-page";
import { PortalInboxPage } from "./portal-inbox-page";
import { PortalLayout } from "./portal-layout";
import { PortalLoginPage } from "./portal-login-page";

/**
 * Customer portal (EmailBot V2), mounted at /portal/* outside the panel's
 * Supabase session and organization providers:
 *   /portal/login               Access ID sign-in
 *   /portal                     inbox
 *   /portal/email/:deliveryId   email detail
 */
export function PortalApp({ api }: { api?: PortalApi }) {
  const [client] = useState(() => api ?? createPortalApi({ baseUrl: env.apiUrl }));
  return (
    <PortalProvider api={client}>
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
