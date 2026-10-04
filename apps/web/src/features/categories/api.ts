import type { Category } from "@emailbot/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export interface CategoryInput {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
}

export function useCategories() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: async () => (await api.get<{ items: Category[] }>("/api/categories")).items,
    staleTime: 60_000
  });
}

export function useCategoryMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.categories(organizationId) });

  return {
    create: useMutation({
      mutationFn: (input: CategoryInput) => api.post<{ category: Category }>("/api/categories", input),
      onSuccess: invalidate
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: CategoryInput }) =>
        api.patch<{ category: Category }>(`/api/categories/${id}`, input),
      onSuccess: invalidate
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/categories/${id}`),
      onSuccess: () => {
        void invalidate();
        // Emails and rules referencing it now have category_id = NULL.
        void queryClient.invalidateQueries({ queryKey: queryKeys.emails(organizationId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.rules(organizationId) });
      }
    })
  };
}
