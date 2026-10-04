import type { BotCustomerAssignment, Customer, CustomerIdentifier, CustomerIdentifierType, CustomerStatus, Paginated } from "@emailbot/types";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, buildQuery } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export interface CustomerInput {
  displayName?: string;
  externalRef?: string | null;
  notes?: string | null;
  status?: CustomerStatus;
}

export function useCustomers(params: Record<string, string | number | undefined>) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.customerList(organizationId, params),
    queryFn: () => api.get<Paginated<Customer>>(`/api/customers${buildQuery(params)}`),
    placeholderData: keepPreviousData
  });
}

export function useCustomer(id: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.customer(organizationId, id ?? "none"),
    queryFn: async () => (await api.get<{ customer: Customer }>(`/api/customers/${id}`)).customer,
    enabled: Boolean(id)
  });
}

export function useCustomerMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.customers(organizationId) });
  return {
    create: useMutation({
      mutationFn: (input: CustomerInput & { displayName: string }) => api.post<{ customer: Customer }>("/api/customers", input),
      onSuccess: invalidate
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: CustomerInput }) => api.patch<{ customer: Customer }>(`/api/customers/${id}`, input),
      onSuccess: () => {
        void invalidate();
        // Customer summaries embedded in bot assignments.
        void queryClient.invalidateQueries({ queryKey: queryKeys.bots(organizationId) });
      }
    })
  };
}

export function useCustomerIdentifiers(customerId: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.customerIdentifiers(organizationId, customerId ?? "none"),
    queryFn: async () => (await api.get<{ items: CustomerIdentifier[] }>(`/api/customers/${customerId}/identifiers`)).items,
    enabled: Boolean(customerId)
  });
}

export function useIdentifierMutations(customerId: string) {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.customerIdentifiers(organizationId, customerId) });
  return {
    create: useMutation({
      mutationFn: (input: { type: CustomerIdentifierType; value: string; botId: string | null }) =>
        api.post<{ identifier: CustomerIdentifier }>(`/api/customers/${customerId}/identifiers`, input),
      onSuccess: invalidate
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: { value?: string; botId?: string | null; active?: boolean } }) =>
        api.patch<{ identifier: CustomerIdentifier }>(`/api/customers/${customerId}/identifiers/${id}`, input),
      onSuccess: invalidate
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/customers/${customerId}/identifiers/${id}`),
      onSuccess: invalidate
    })
  };
}

export function useCustomerBots(customerId: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.customerBots(organizationId, customerId ?? "none"),
    queryFn: async () => (await api.get<{ items: BotCustomerAssignment[] }>(`/api/customers/${customerId}/bots`)).items,
    enabled: Boolean(customerId)
  });
}

export function useBotCustomers(botId: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.botCustomers(organizationId, botId ?? "none"),
    queryFn: async () => (await api.get<{ items: BotCustomerAssignment[] }>(`/api/bots/${botId}/customers`)).items,
    enabled: Boolean(botId)
  });
}

export function useAssignmentMutations(botId: string) {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.botCustomers(organizationId, botId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.customers(organizationId) });
  };
  return {
    assign: useMutation({
      mutationFn: (customerId: string) => api.post<{ assignment: BotCustomerAssignment }>(`/api/bots/${botId}/customers`, { customerId }),
      onSuccess: invalidate
    }),
    setActive: useMutation({
      mutationFn: ({ customerId, active }: { customerId: string; active: boolean }) =>
        api.patch<{ assignment: BotCustomerAssignment }>(`/api/bots/${botId}/customers/${customerId}`, { active }),
      onSuccess: invalidate
    }),
    unassign: useMutation({
      mutationFn: (customerId: string) => api.delete(`/api/bots/${botId}/customers/${customerId}`),
      onSuccess: invalidate
    })
  };
}
