import type { PlanCatalogEntry } from "@emailbot/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** Commercial V1: the public plan catalog (GET /api/plans; no session needed). */
export function usePlanCatalog() {
  return useQuery({
    queryKey: queryKeys.planCatalog(),
    queryFn: async () => (await api.get<{ items: PlanCatalogEntry[] }>("/api/plans")).items,
    staleTime: 5 * 60_000
  });
}
