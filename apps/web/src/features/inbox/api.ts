import type { EmailDetail, EmailSummary, Paginated } from "@emailbot/types";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, buildQuery } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export function useEmails(params: Record<string, string | number | boolean | undefined>) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.emailList(organizationId, params),
    queryFn: () => api.get<Paginated<EmailSummary>>(`/api/emails${buildQuery(params)}`),
    placeholderData: keepPreviousData
  });
}

export function useEmail(id: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.email(organizationId, id ?? "none"),
    queryFn: async () => (await api.get<{ email: EmailDetail }>(`/api/emails/${id}`)).email,
    enabled: Boolean(id)
  });
}

export interface EmailPatch {
  isRead?: boolean;
  isImportant?: boolean;
  isArchived?: boolean;
  categoryId?: string | null;
}

export function useUpdateEmail() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EmailPatch }) =>
      api.patch<{ email: EmailSummary }>(`/api/emails/${id}`, patch),
    onSuccess: ({ email }) => {
      queryClient.setQueryData<EmailDetail>(queryKeys.email(organizationId, email.id), (current) =>
        current ? { ...current, ...email, attachments: current.attachments } : current
      );
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.emails(organizationId), "list"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats(organizationId) });
    }
  });
}

export function useDeleteEmail() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/emails/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.emails(organizationId) })
  });
}

/** Short-lived signed URL issued by the API after an RLS-checked lookup. */
export async function getAttachmentDownloadUrl(id: string): Promise<string> {
  const { url } = await api.get<{ url: string; expiresIn: number }>(`/api/attachments/${id}/download`);
  return url;
}
