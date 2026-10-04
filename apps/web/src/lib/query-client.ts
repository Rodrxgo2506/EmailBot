import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

export function createQueryClient(): QueryClient {
  return new QueryClient({
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
}
