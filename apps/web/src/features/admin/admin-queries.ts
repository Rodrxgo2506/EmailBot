import type { AdminOrganizationDetail, AdminSubscriptionActivation, OrganizationStatus, SubscriptionAction } from "@emailbot/types";
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
  subscription: (id: string) => ["admin", "organizations", "detail", id, "subscription"] as const,
  planPrices: ["admin", "plan-prices"] as const,
  activity: (params: AdminLogParams) => ["admin", "activity", params] as const,
  audit: (params: AdminLogParams) => ["admin", "audit", params] as const,
  complaints: (page: number) => ["admin", "complaints-book", page] as const
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

export function useAdminComplaints(page: number, pageSize: number) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.complaints(page), queryFn: () => api.complaints({ page, pageSize }), placeholderData: keepPreviousData });
}

/** Complaint e-mails (answer, copy sent again): refresh the book and the audit trail, whatever the outcome. */
function useComplaintMutation<TVariables, TResult>(mutationFn: (variables: TVariables) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["admin", "complaints-book"] });
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    }
  });
}

export function useRespondToComplaint() {
  const api = useAdminApi();
  return useComplaintMutation(({ id, response, forceResend = false }: { id: string; response: string; forceResend?: boolean }) =>
    api.respondToComplaint(id, response, { forceResend })
  );
}

export function useResendComplaintCopy() {
  const api = useAdminApi();
  return useComplaintMutation(({ id, forceResend = false }: { id: string; forceResend?: boolean }) => api.resendComplaintCopy(id, { forceResend }));
}

/** An e-mail with an unknown outcome recorded as sent with the Resend id the administrator found. */
export function useConfirmComplaintEmail() {
  const api = useAdminApi();
  return useComplaintMutation(({ id, kind, providerMessageId }: { id: string; kind: "response" | "copy"; providerMessageId: string }): Promise<unknown> =>
    kind === "response" ? api.confirmComplaintResponse(id, providerMessageId) : api.confirmComplaintCopy(id, providerMessageId)
  );
}

export function useAdminAudit(params: AdminLogParams) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.audit(params), queryFn: () => api.audit(params), placeholderData: keepPreviousData });
}

/** Status change: refreshes the lists, the detail, the stats, the audit trail and the activity. */
export function useUpdateOrganization() {
  const api = useAdminApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { status: OrganizationStatus } }) => api.updateOrganization(id, patch),
    onSuccess: (organization) => {
      client.setQueryData(adminKeys.organization(organization.id), organization);
      void client.invalidateQueries({ queryKey: adminKeys.organizations });
      void client.invalidateQueries({ queryKey: adminKeys.stats });
      void client.invalidateQueries({ queryKey: ["admin", "audit"] });
      void client.invalidateQueries({ queryKey: ["admin", "activity"] });
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
      void client.invalidateQueries({ queryKey: ["admin", "activity"] });
    }
  });
}

/* ------------------------------------------------------------ subscriptions (Commercial V1.1) */

export function useAdminPlanPrices() {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.planPrices, queryFn: () => api.planPrices(), staleTime: 5 * 60_000 });
}

export function useAdminSubscription(id: string) {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.subscription(id), queryFn: () => api.subscription(id) });
}

/** After any subscription change: the subscription, the organization (plan cache), the lists, the audit and the activity. */
function useSubscriptionRefresh() {
  const client = useQueryClient();
  return (organization: AdminOrganizationDetail) => {
    client.setQueryData(adminKeys.organization(organization.id), organization);
    void client.invalidateQueries({ queryKey: adminKeys.subscription(organization.id) });
    void client.invalidateQueries({ queryKey: adminKeys.organizations });
    void client.invalidateQueries({ queryKey: ["admin", "audit"] });
    void client.invalidateQueries({ queryKey: ["admin", "activity"] });
  };
}

export function useActivateSubscription() {
  const api = useAdminApi();
  const refresh = useSubscriptionRefresh();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: AdminSubscriptionActivation }) => api.activateSubscription(id, input),
    onSuccess: (result) => refresh(result.organization)
  });
}

export function useSubscriptionAction() {
  const api = useAdminApi();
  const refresh = useSubscriptionRefresh();
  return useMutation({
    mutationFn: ({ subscriptionId, action, reason }: { subscriptionId: string; action: SubscriptionAction; reason?: string }) =>
      api.subscriptionAction(subscriptionId, action, reason),
    onSuccess: (result) => refresh(result.organization)
  });
}
