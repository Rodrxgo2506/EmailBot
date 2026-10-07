import type { Bot, BotStatus } from "@emailbot/types";
import type { CustomerResolutionInput } from "@emailbot/validation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export interface BotInput {
  name?: string;
  description?: string | null;
  status?: BotStatus;
  customerResolution?: CustomerResolutionInput;
}

export function useBots() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.bots(organizationId),
    queryFn: async () => (await api.get<{ items: Bot[] }>("/api/bots")).items,
    staleTime: 60_000
  });
}

export function useBot(id: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.bot(organizationId, id ?? "none"),
    queryFn: async () => (await api.get<{ bot: Bot }>(`/api/bots/${id}`)).bot,
    enabled: Boolean(id)
  });
}

export function useBotMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  // The list and every detail share the ["org", id, "bots"] prefix.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.bots(organizationId) });

  return {
    create: useMutation({
      mutationFn: (input: BotInput & { name: string }) => api.post<{ bot: Bot }>("/api/bots", input),
      onSuccess: invalidate
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: BotInput }) => api.patch<{ bot: Bot }>(`/api/bots/${id}`, input),
      onSuccess: invalidate
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/bots/${id}`),
      onSuccess: () => {
        void invalidate();
        // Rules of a deleted bot become general rules (bot_id = NULL).
        void queryClient.invalidateQueries({ queryKey: queryKeys.rules(organizationId) });
      }
    })
  };
}
