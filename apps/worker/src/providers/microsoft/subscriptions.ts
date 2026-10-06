import {
  GRAPH_API_URL,
  graphSubscriptionUrl,
  isGraphSubscriptionId,
  MICROSOFT_SUBSCRIPTION_CHANGE_TYPE,
  MICROSOFT_SUBSCRIPTION_RESOURCE
} from "@emailbot/shared";
import { z } from "zod";
import { ProviderHttpError, providerDelete, providerPatch, providerPost } from "../http.js";
import type { ProviderContext } from "../types.js";

/*
 * Microsoft Graph change-notification subscriptions of one account
 * (POST / PATCH / DELETE /subscriptions), with the account's DELEGATED access
 * token through providerRequest: 401 -> one forced refresh, then
 * ProviderAuthError; 429 / 5xx / network -> ProviderTransientError; other 4xx
 * -> ProviderHttpError (a 404 on renewal means the subscription is gone).
 * No message is read here: notifications only trigger the delta sync.
 */

const subscriptionSchema = z.object({
  id: z.string().refine(isGraphSubscriptionId, "not a Graph subscription id"),
  expirationDateTime: z.string().min(1)
});
const renewalSchema = z.object({ expirationDateTime: z.string().min(1) });

export interface CreateSubscriptionInput {
  notificationUrl: string;
  lifecycleNotificationUrl: string;
  /** Random per-subscription secret; sent to Graph only, never logged or stored in plain text. */
  clientState: string;
  expirationDateTime: string;
}

export interface MicrosoftSubscriptionClient {
  create(context: ProviderContext, input: CreateSubscriptionInput): Promise<{ id: string; expirationDateTime: string }>;
  renew(context: ProviderContext, subscriptionId: string, expirationDateTime: string): Promise<{ expirationDateTime: string }>;
  /** "not_found" when Graph no longer has it (already deleted or expired): not an error. */
  remove(context: ProviderContext, subscriptionId: string): Promise<"deleted" | "not_found">;
}

function normalizeExpiration(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error("Graph returned an invalid subscription expiration");
  return new Date(time).toISOString();
}

export function createMicrosoftSubscriptionClient(fetchImpl: typeof fetch = fetch): MicrosoftSubscriptionClient {
  return {
    async create(context, input) {
      const body = subscriptionSchema.parse(
        await providerPost(
          context,
          `${GRAPH_API_URL}/subscriptions`,
          {
            changeType: MICROSOFT_SUBSCRIPTION_CHANGE_TYPE,
            notificationUrl: input.notificationUrl,
            lifecycleNotificationUrl: input.lifecycleNotificationUrl,
            resource: MICROSOFT_SUBSCRIPTION_RESOURCE,
            expirationDateTime: input.expirationDateTime,
            clientState: input.clientState
          },
          fetchImpl
        )
      );
      return { id: body.id, expirationDateTime: normalizeExpiration(body.expirationDateTime) };
    },

    async renew(context, subscriptionId, expirationDateTime) {
      const body = renewalSchema.parse(await providerPatch(context, graphSubscriptionUrl(subscriptionId), { expirationDateTime }, fetchImpl));
      return { expirationDateTime: normalizeExpiration(body.expirationDateTime) };
    },

    async remove(context, subscriptionId) {
      try {
        await providerDelete(context, graphSubscriptionUrl(subscriptionId), fetchImpl);
        return "deleted";
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return "not_found";
        throw error;
      }
    }
  };
}
