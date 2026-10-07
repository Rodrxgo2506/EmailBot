import type {
  AdminActivityItem,
  AdminAuditEntry,
  AdminBot,
  AdminCustomer,
  AdminEmailAccount,
  AdminMember,
  AdminOrganizationDetail,
  AdminOrganizationSort,
  AdminOrganizationSummary,
  AdminPaymentEvent,
  AdminPlanPrice,
  AdminStats,
  AdminSubscription,
  AdminSubscriptionActivation,
  OffsetPage,
  OrganizationPlan,
  OrganizationStatus,
  Paginated,
  SubscriptionAction,
  SubscriptionActivationOutcome
} from "@emailbot/types";
import { createContext, useContext } from "react";
import { buildQuery, type ApiClient } from "@/lib/api-client";

/*
 * Platform administration API (/api/admin/*, EmailBot V2 phase 6). Uses the
 * panel's authenticated client (Supabase JWT); the API checks platform admin
 * rights on every request, so hiding the UI is never the protection.
 */

export interface AdminOrganizationListParams {
  search: string;
  status: OrganizationStatus | "";
  plan: OrganizationPlan | "";
  sort: AdminOrganizationSort;
  page: number;
  pageSize: number;
}

export interface AdminLogParams {
  organizationId?: string | undefined;
  page: number;
  pageSize: number;
}

/** Organizations are created without a plan: it comes from a subscription (Commercial V1.1). */
export interface AdminOrganizationCreate {
  name: string;
  ownerEmail: string;
  slug?: string;
}

export interface AdminSubscriptionView {
  subscriptions: AdminSubscription[];
  paymentEvents: AdminPaymentEvent[];
}

export interface AdminApi {
  stats(): Promise<AdminStats>;
  listOrganizations(params: AdminOrganizationListParams): Promise<Paginated<AdminOrganizationSummary>>;
  getOrganization(id: string): Promise<AdminOrganizationDetail>;
  createOrganization(input: AdminOrganizationCreate): Promise<AdminOrganizationDetail>;
  updateOrganization(id: string, patch: { status: OrganizationStatus }): Promise<AdminOrganizationDetail>;
  planPrices(): Promise<AdminPlanPrice[]>;
  subscription(id: string): Promise<AdminSubscriptionView>;
  activateSubscription(
    id: string,
    input: AdminSubscriptionActivation
  ): Promise<{ subscriptionId: string; outcome: SubscriptionActivationOutcome; organization: AdminOrganizationDetail }>;
  subscriptionAction(subscriptionId: string, action: SubscriptionAction, reason?: string): Promise<{ organization: AdminOrganizationDetail }>;
  members(id: string): Promise<AdminMember[]>;
  bots(id: string): Promise<AdminBot[]>;
  customers(id: string, page: number, pageSize: number): Promise<Paginated<AdminCustomer>>;
  emailAccounts(id: string): Promise<AdminEmailAccount[]>;
  activity(params: AdminLogParams): Promise<OffsetPage<AdminActivityItem>>;
  audit(params: AdminLogParams): Promise<OffsetPage<AdminAuditEntry>>;
}

export function createAdminApi(client: Pick<ApiClient, "get" | "post" | "patch">): AdminApi {
  const organization = (id: string) => `/api/admin/organizations/${encodeURIComponent(id)}`;

  return {
    stats: async () => (await client.get<{ stats: AdminStats }>("/api/admin/stats")).stats,
    listOrganizations: (params) =>
      client.get<Paginated<AdminOrganizationSummary>>(
        `/api/admin/organizations${buildQuery({
          search: params.search.trim(),
          status: params.status,
          plan: params.plan,
          sort: params.sort,
          page: params.page,
          pageSize: params.pageSize
        })}`
      ),
    getOrganization: async (id) => (await client.get<{ organization: AdminOrganizationDetail }>(organization(id))).organization,
    createOrganization: async (input) =>
      (await client.post<{ organization: AdminOrganizationDetail }>("/api/admin/organizations", input)).organization,
    updateOrganization: async (id, patch) => (await client.patch<{ organization: AdminOrganizationDetail }>(organization(id), patch)).organization,
    planPrices: async () => (await client.get<{ items: AdminPlanPrice[] }>("/api/admin/plan-prices")).items,
    subscription: (id) => client.get<AdminSubscriptionView>(`${organization(id)}/subscription`),
    activateSubscription: (id, input) =>
      client.post<{ subscriptionId: string; outcome: SubscriptionActivationOutcome; organization: AdminOrganizationDetail }>(`${organization(id)}/subscription/activate`, input),
    subscriptionAction: (subscriptionId, action, reason) =>
      client.post<{ organization: AdminOrganizationDetail }>(
        `/api/admin/subscriptions/${encodeURIComponent(subscriptionId)}/${action}`,
        reason ? { reason } : {}
      ),
    members: async (id) => (await client.get<{ items: AdminMember[] }>(`${organization(id)}/members`)).items,
    bots: async (id) => (await client.get<{ items: AdminBot[] }>(`${organization(id)}/bots`)).items,
    customers: (id, page, pageSize) => client.get<Paginated<AdminCustomer>>(`${organization(id)}/customers${buildQuery({ page, pageSize })}`),
    emailAccounts: async (id) => (await client.get<{ items: AdminEmailAccount[] }>(`${organization(id)}/email-accounts`)).items,
    activity: (params) => client.get<OffsetPage<AdminActivityItem>>(`/api/admin/activity${buildQuery({ ...params })}`),
    audit: (params) => client.get<OffsetPage<AdminAuditEntry>>(`/api/admin/audit${buildQuery({ ...params })}`)
  };
}

export const AdminApiContext = createContext<AdminApi | null>(null);

export function useAdminApi(): AdminApi {
  const api = useContext(AdminApiContext);
  if (!api) throw new Error("useAdminApi must be used inside AdminApiContext");
  return api;
}
