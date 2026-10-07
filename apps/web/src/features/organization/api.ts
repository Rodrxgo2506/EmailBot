import type {
  AuditAction,
  AuditLogEntry,
  Organization,
  OrganizationMember,
  OrganizationPlanOverview,
  OrganizationRole,
  OrganizationSettings,
  Paginated
} from "@emailbot/types";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, buildQuery } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { meQueryKey, useOrganization, useOrganizationId } from "@/providers/organization-provider";
import { useAuth } from "@/providers/auth-provider";

export interface CurrentOrganization {
  organization: Organization;
  role: OrganizationRole;
  settings: OrganizationSettings | null;
}

export type AssignableRole = Exclude<OrganizationRole, "OWNER">;
export type SettingsPatch = Partial<Omit<OrganizationSettings, "organizationId" | "updatedAt">>;

export function useCurrentOrganization() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.current(organizationId),
    queryFn: () => api.get<CurrentOrganization>("/api/organizations/current"),
    staleTime: 60_000
  });
}

/** Commercial V1: plan, entitlements and usage of the active organization (every member). */
export function usePlanOverview() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.plan(organizationId),
    queryFn: () => api.get<OrganizationPlanOverview>("/api/organizations/current/plan"),
    staleTime: 30_000
  });
}

export function useOrganizationMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const { refresh } = useOrganization();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.current(organizationId) });

  return {
    update: useMutation({
      mutationFn: (patch: { name?: string; slug?: string }) =>
        api.patch<{ organization: Organization }>("/api/organizations/current", patch),
      onSuccess: () => {
        void invalidate();
        void refresh();
      }
    }),
    updateSettings: useMutation({
      mutationFn: (patch: SettingsPatch) =>
        api.patch<{ settings: OrganizationSettings }>("/api/organizations/current/settings", patch),
      onSuccess: invalidate
    }),
    transferOwnership: useMutation({
      mutationFn: (newOwnerUserId: string) =>
        api.post("/api/organizations/current/transfer-ownership", { newOwnerUserId }),
      onSuccess: () => {
        void invalidate();
        void refresh();
        void queryClient.invalidateQueries({ queryKey: queryKeys.members(organizationId) });
      }
    })
  };
}

/** Creating an organization does not need an active one (onboarding). */
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: (input: { name: string; slug?: string }) =>
      api.post<{ organization: Organization; role: OrganizationRole }>("/api/organizations", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryKey(session?.user.id) })
  });
}

export function useMembers() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: async () => (await api.get<{ items: OrganizationMember[] }>("/api/organizations/current/members")).items,
    staleTime: 60_000
  });
}

export function useMemberMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.members(organizationId) });

  return {
    add: useMutation({
      mutationFn: (input: { email: string; role: AssignableRole }) =>
        api.post<{ member: OrganizationMember }>("/api/organizations/current/members", input),
      onSuccess: invalidate
    }),
    updateRole: useMutation({
      mutationFn: ({ id, role }: { id: string; role: AssignableRole }) =>
        api.patch<{ member: OrganizationMember }>(`/api/organizations/current/members/${id}`, { role }),
      onSuccess: invalidate
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/organizations/current/members/${id}`),
      onSuccess: invalidate
    })
  };
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: AuditAction | undefined;
  entityType?: string | undefined;
}

export function useAuditLogs(query: AuditQuery, enabled = true) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.audit(organizationId, { ...query }),
    queryFn: () => api.get<Paginated<AuditLogEntry>>(`/api/audit-logs${buildQuery({ ...query })}`),
    placeholderData: keepPreviousData,
    enabled
  });
}
