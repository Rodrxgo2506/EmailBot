import type { EmailAccount } from "@emailbot/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export type OAuthProviderSlug = "gmail" | "microsoft";

export interface ImapAccountInput {
  emailAddress: string;
  displayName?: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export function useEmailAccounts() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.accounts(organizationId),
    queryFn: async () => (await api.get<{ items: EmailAccount[] }>("/api/email-accounts")).items
  });
}

export function useEmailAccountMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.accounts(organizationId) });

  return {
    /** Returns the provider consent URL; the browser is then redirected to it. */
    startOAuth: useMutation({
      mutationFn: (provider: OAuthProviderSlug) =>
        api.post<{ authorizationUrl: string }>(`/api/email-accounts/oauth/${provider}/start`)
    }),
    createImap: useMutation({
      mutationFn: (input: ImapAccountInput) => api.post<{ account: EmailAccount }>("/api/email-accounts/imap", input),
      onSuccess: invalidate
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: { status?: "ACTIVE" | "PAUSED"; displayName?: string | null } }) =>
        api.patch<{ account: EmailAccount }>(`/api/email-accounts/${id}`, patch),
      onSuccess: invalidate
    }),
    disconnect: useMutation({
      mutationFn: (id: string) => api.post<{ account: EmailAccount }>(`/api/email-accounts/${id}/disconnect`),
      onSuccess: invalidate
    }),
    sync: useMutation({
      mutationFn: (id: string) => api.post<{ queued: boolean }>(`/api/email-accounts/${id}/sync`),
      onSuccess: invalidate
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/email-accounts/${id}`),
      onSuccess: () => {
        void invalidate();
        void queryClient.invalidateQueries({ queryKey: queryKeys.emails(organizationId) });
      }
    })
  };
}
