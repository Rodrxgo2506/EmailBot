import {
  hasPermission,
  type Organization,
  type OrganizationMembership,
  type OrganizationRole,
  type Permission
} from "@emailbot/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { consumePendingLoginEvent } from "@/lib/login-event";
import { getStoredOrganizationId, setStoredOrganizationId } from "@/lib/organization-storage";
import { useAuth } from "./auth-provider";

export interface MeResponse {
  user: { id: string; email: string | null };
  memberships: OrganizationMembership[];
}

interface OrganizationContextValue {
  me: MeResponse | undefined;
  loading: boolean;
  error: unknown;
  memberships: OrganizationMembership[];
  organization: Organization | null;
  role: OrganizationRole | null;
  can(permission: Permission): boolean;
  switchOrganization(organizationId: string): void;
  refresh(): Promise<unknown>;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

export const meQueryKey = (userId: string | undefined) => ["me", userId] as const;

/**
 * Resolves the active organization from GET /api/me and keeps it in the
 * existing storage that the API client sends as X-Organization-Id. The
 * role is only used to adapt the UI; the API and RLS enforce permissions.
 */
export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const userId = session?.user.id;
  const [selectedId, setSelectedId] = useState<string | null>(() => getStoredOrganizationId());

  const meQuery = useQuery({
    queryKey: meQueryKey(userId),
    queryFn: () => api.get<MeResponse>("/api/me"),
    enabled: Boolean(userId)
  });

  const memberships = useMemo(() => meQuery.data?.memberships ?? [], [meQuery.data]);
  const active =
    memberships.find((membership) => membership.organization.id === selectedId) ?? memberships[0] ?? null;
  const activeId = active?.organization.id ?? null;

  // Keep the header source in sync before any organization-scoped query runs.
  if (meQuery.data && getStoredOrganizationId() !== activeId) {
    setStoredOrganizationId(activeId);
  }

  useEffect(() => {
    if (activeId && consumePendingLoginEvent()) {
      void api.post("/api/me/login-event").catch(() => undefined);
    }
  }, [activeId]);

  const switchOrganization = useCallback(
    (organizationId: string) => {
      setStoredOrganizationId(organizationId);
      setSelectedId(organizationId);
      // Never reuse cached data from another tenant.
      queryClient.removeQueries({ queryKey: ["org"] });
    },
    [queryClient]
  );

  const value = useMemo<OrganizationContextValue>(
    () => ({
      me: meQuery.data,
      loading: meQuery.isPending && Boolean(userId),
      error: meQuery.error,
      memberships,
      organization: active?.organization ?? null,
      role: active?.role ?? null,
      can: (permission) => hasPermission(active?.role, permission),
      switchOrganization,
      refresh: () => meQuery.refetch()
    }),
    [meQuery, memberships, active, switchOrganization, userId]
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization(): OrganizationContextValue {
  const context = useContext(OrganizationContext);
  if (!context) throw new Error("useOrganization must be used inside OrganizationProvider");
  return context;
}

/** Active organization id (guaranteed inside RequireOrganization). */
export function useOrganizationId(): string {
  const { organization } = useOrganization();
  return organization?.id ?? "none";
}
