import type { BillingCheckoutOptions, BillingCheckoutResult, BillingConfig, BillingPeriod, BillingSubscriptionSummary, CommercialPlan } from "@emailbot/types";
import type { BillingCustomerInput } from "@emailbot/validation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrganizationId } from "@/providers/organization-provider";

/*
 * Commercial V1 phase 2: card checkout (Culqi, sandbox in this phase). The
 * browser sends plan + period + Culqi's card token; the API resolves the price.
 */

/** Whether card checkout is available; only asked when a plan is being chosen. */
export function useBillingConfig(enabled: boolean) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.billingConfig(organizationId),
    queryFn: () => api.get<BillingConfig>("/api/billing/config"),
    enabled,
    staleTime: 5 * 60_000,
    retry: false
  });
}

export const getCheckoutOptions = (plan: CommercialPlan, billingPeriod: BillingPeriod) =>
  api.get<BillingCheckoutOptions>(`/api/billing/checkout?plan=${plan}&billingPeriod=${billingPeriod}`);

export interface CreateBillingSubscriptionInput {
  plan: CommercialPlan;
  billingPeriod: BillingPeriod;
  tokenId: string;
  acceptTerms: true;
  customer: BillingCustomerInput;
}

/** Only what the API accepts: never an amount, a currency or card data. */
export const createBillingSubscription = (input: CreateBillingSubscriptionInput) =>
  api.post<BillingCheckoutResult>("/api/billing/subscriptions", {
    plan: input.plan,
    billingPeriod: input.billingPeriod,
    tokenId: input.tokenId,
    acceptTerms: input.acceptTerms,
    customer: input.customer
  });

/** Polls the latest Culqi subscription while a payment is being confirmed. */
export function useCurrentBillingSubscription(polling: boolean) {
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.billingCurrent(organizationId),
    queryFn: async () => (await api.get<{ billingSubscription: BillingSubscriptionSummary | null }>("/api/billing/subscriptions/current")).billingSubscription,
    enabled: polling,
    refetchInterval: polling ? 3000 : false
  });
}
