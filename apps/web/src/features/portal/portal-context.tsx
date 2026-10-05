import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "@/lib/api-client";
import type { PortalApi } from "./portal-api";

/*
 * Portal state, kept apart from the admin panel:
 *  - its own QueryClient (cleared on logout / expiry; never mixed with panel data),
 *  - the portal API client (cookie session, see portal-api.ts),
 *  - a single 401 handler: any portal request answered 401 (session expired,
 *    revoked, customer or organization suspended) clears the portal state and
 *    goes to /portal/login once. Login itself is excluded (a wrong Access ID
 *    is a 401 too) and nothing redirects while already on the login page.
 */

export const PORTAL_LOGIN_PATH = "/portal/login";

const PortalApiContext = createContext<PortalApi | null>(null);

export function usePortalApi(): PortalApi {
  const api = useContext(PortalApiContext);
  if (!api) throw new Error("usePortalApi must be used inside PortalProvider");
  return api;
}

/** Mutations with this meta never trigger the session-expired redirect (portal login). */
export const PUBLIC_MUTATION = { portalPublic: true } as const;

export function createPortalQueryClient(onUnauthorized: () => void): QueryClient {
  const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isUnauthorized(error)) onUnauthorized();
      }
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isUnauthorized(error) && mutation.meta?.portalPublic !== true) onUnauthorized();
      }
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2
      },
      mutations: { retry: false }
    }
  });
}

export function PortalProvider({ api, children }: { api: PortalApi; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const clientRef = useRef<QueryClient | null>(null);

  const [client] = useState(() =>
    createPortalQueryClient(() => {
      if (pathRef.current === PORTAL_LOGIN_PATH) return;
      clientRef.current?.clear();
      navigate(`${PORTAL_LOGIN_PATH}?expired=1`, { replace: true });
    })
  );
  clientRef.current = client;

  return (
    <QueryClientProvider client={client}>
      <PortalApiContext.Provider value={api}>{children}</PortalApiContext.Provider>
    </QueryClientProvider>
  );
}

/** Clears every portal query (logout). */
export function usePortalReset() {
  const client = useQueryClient();
  return () => client.clear();
}
