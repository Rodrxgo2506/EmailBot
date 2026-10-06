import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/** API refusal for users without an acceptance of the current legal versions (EmailBot V2 phase 7). */
export const LEGAL_ACCEPTANCE_REQUIRED = "LEGAL_ACCEPTANCE_REQUIRED";

export function createQueryClient(): QueryClient {
  // If the API refuses because the current legal versions are not accepted (for example, new versions were
  // published while the panel was open), /api/me is read again so RequireLegalAcceptance shows the acceptance screen.
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.code === LEGAL_ACCEPTANCE_REQUIRED) void client.invalidateQueries({ queryKey: ["me"] });
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Client errors (403, 404, validation) will not change on retry.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: false
      },
      mutations: { retry: false }
    }
  });
  return client;
}
