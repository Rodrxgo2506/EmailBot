import type { EmailRuleRecord } from "@emailbot/types";
import type { RuleAction, RuleCondition, RuleCreateInput, RuleTestEmail } from "@emailbot/validation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

export type EmailRule = EmailRuleRecord<RuleCondition, RuleAction>;

/** Response of POST /api/rules/test and /api/rules/:id/test (computed by the backend engine). */
export interface RuleTestResult {
  matched: boolean;
  enabled: boolean;
  /** A regex of the rule was stopped for exceeding its time limit (counted as "no match"). */
  regexTimedOut: boolean;
  conditionResults: Array<{ condition: RuleCondition; matched: boolean }>;
  actions: {
    categoryId: string | null;
    markImportant: boolean;
    markRead: boolean;
    archive: boolean;
    notify: boolean;
    extracted: Record<string, string>;
  } | null;
}

/** Sample email sent to the test endpoints (input shape of ruleTestEmailSchema). */
export type RuleTestSample = Partial<RuleTestEmail> & { sender: string };

export function useRules() {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.rules(organizationId),
    queryFn: async () => (await api.get<{ items: EmailRule[] }>("/api/rules")).items
  });
}

export function useRule(id: string | undefined) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.rule(organizationId, id ?? "none"),
    queryFn: async () => (await api.get<{ rule: EmailRule }>(`/api/rules/${id}`)).rule,
    enabled: Boolean(id)
  });
}

export function useRuleMutations() {
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.rules(organizationId) });

  return {
    create: useMutation({
      mutationFn: (input: RuleCreateInput) => api.post<{ rule: EmailRule }>("/api/rules", input),
      onSuccess: invalidate
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: Partial<RuleCreateInput> }) =>
        api.patch<{ rule: EmailRule }>(`/api/rules/${id}`, patch),
      onSuccess: invalidate
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/api/rules/${id}`),
      onSuccess: invalidate
    }),
    testDraft: useMutation({
      mutationFn: (body: { rule: RuleCreateInput; email: RuleTestSample }) =>
        api.post<RuleTestResult>("/api/rules/test", body)
    }),
    testSaved: useMutation({
      mutationFn: ({ id, email }: { id: string; email: RuleTestSample }) =>
        api.post<RuleTestResult>(`/api/rules/${id}/test`, { email })
    })
  };
}
