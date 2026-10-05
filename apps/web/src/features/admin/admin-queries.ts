import type { OrganizationPlan, OrganizationStatus } from "@emailbot/types";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdminApi, type AdminLogParams, type AdminOrganizationCreate, type AdminOrganizationListParams } from "./admin-api";

/*
 * Admin cache keys live under ["admin"], apart from the tenant keys
 * (["org", id]); the whole cache is cleared on sign-out.
 */
export const adminKeys = {
  all: ["admin"] as const,
  stats: ["admin", "stats"] as const,
  organizations: ["admin", "organizations"] as const,
  organizationList: (params: AdminOrganizationListParams) => ["admin", "organizations", "list", params] as const,
  organization: (id: string) => ["admin", "organizations", "detail", id] as const,
  members: (id: string) => ["admin", "organizations", "detail", id, "members"] as const,
  bots: (id: string) => ["admin", "organizations", "detail", id, "bots"] as const,
  customers: (id: string, page: number) => ["admin", "organizations", "detail", id, "customers", page] as const,
  emailAccounts: (id: string) => ["admin", "organizations", "detail", id, "email-accounts"] as const,
  activity: (params: AdminLogParams) => ["admin", "activity", params] as const,
  audit: (params: AdminLogParams) => ["admin", "audit", params] as const
};

export function useAdminStats() {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.stats, queryFn: () => api.stats() });
}

export function useAdminOrganizations(params: AdminOrganizationListParams) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.organizationList(params), queryFn: () => api.listOrganizations(params), placeholderData: keepPreviousData });
}

export function useAdminOrganization(id: string) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.organization(id), queryFn: () => api.getOrganization(id) });
}

export function useAdminMembers(id: string) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.members(id), queryFn: () => api.members(id) });
}

export function useAdminBots(id: string) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.bots(id), queryFn: () => api.bots(id) });
}

export function useAdminCustomers(id: string, page: number, pageSize: number) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.customers(id, page), queryFn: () => api.customers(id, page, pageSize), placeholderData: keepPreviousData });
}

export function useAdminEmailAccounts(id: string) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.emailAccounts(id), queryFn: () => api.emailAccounts(id) });
}

export function useAdminActivity(params: AdminLogParams) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.activity(params), queryFn: () => api.activity(params), placeholderData: keepPreviousData });
}

export function useAdminAudit(params: AdminLogParams) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.audit(params), queryFn: () => api.audit(params), placeholderData: keepPreviousData });
}

/** Plan / status change: refreshes the lists, the detail, the stats and the audit trail. */
export function useUpdateOrganization() {
  const api = useAdminApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { plan?: OrganizationPlan; status?: OrganizationStatus } }) => api.updateOrganization(id, patch),
    onSuccess: (organization) => {
      client.setQueryData(adminKeys.organization(organization.id), organization);
      void client.invalidateQueries({ queryKey: adminKeys.organizations });
      void client.invalidateQueries({ queryKey: adminKeys.stats });
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    }
  });
}

export function useCreateOrganization() {
  const api = useAdminApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminOrganizationCreate) => api.createOrganization(input),
    onSuccess: (organization) => {
      client.setQueryData(adminKeys.organization(organization.id), organization);
      void client.invalidateQueries({ queryKey: adminKeys.organizations });
      void client.invalidateQueries({ queryKey: adminKeys.stats });
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    }
  });
}
