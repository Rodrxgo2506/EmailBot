import { graphSubscriptionUrl, refreshAccessToken, serializeError, subscriptionLogId } from "@emailbot/shared";
import type { FastifyBaseLogger } from "fastify";
import type { AppDeps } from "../../deps.js";

/** An access token expiring within this margin is refreshed before use. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export type SubscriptionRemoval = "none" | "deleted" | "not_found" | "failed";

/**
 * F9: removes the Graph change-notification subscription of a Microsoft
 * account BEFORE a disconnection wipes its tokens (the worker could not do it
 * afterwards). Best effort: the DELETE uses the account's delegated token
 * (refreshed if needed, never persisted: the account is being disconnected);
 * 404 means it was already gone. Whatever Graph answers, the subscription is
 * forgotten locally, so any later notification for it is rejected by the
 * webhook, and an undeleted one simply expires (~70 h at most).
 */
export async function removeMicrosoftSubscription(deps: AppDeps, organizationId: string, emailAccountId: string, log: FastifyBaseLogger): Promise<SubscriptionRemoval> {
  const stored = await deps.privileged.getMicrosoftSubscriptionCredentials(organizationId, emailAccountId);
  if (!stored?.subscriptionId) return "none";

  let outcome: SubscriptionRemoval = "failed";
  try {
    const accessToken = await currentAccessToken(deps, stored);
    if (accessToken) {
      const response = await deps.fetch(graphSubscriptionUrl(stored.subscriptionId), {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      outcome = response.ok ? "deleted" : response.status === 404 ? "not_found" : "failed";
    }
  } catch (error) {
    log.warn({ err: serializeError(error), emailAccountId }, "Microsoft subscription could not be deleted at Graph");
  }

  await deps.privileged.clearMicrosoftSubscription(organizationId, emailAccountId);
  log.info({ event: "microsoft.subscription.removed", emailAccountId, subscription: subscriptionLogId(stored.subscriptionId), outcome }, "Microsoft subscription removed");
  return outcome;
}

async function currentAccessToken(
  deps: AppDeps,
  stored: { accessTokenEncrypted: string | null; refreshTokenEncrypted: string | null; tokenExpiresAt: string | null }
): Promise<string | null> {
  const expiresAt = stored.tokenExpiresAt ? Date.parse(stored.tokenExpiresAt) : Number.NaN;
  if (stored.accessTokenEncrypted && Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
    return deps.secretBox.decrypt(stored.accessTokenEncrypted);
  }
  if (!stored.refreshTokenEncrypted || !deps.config.microsoft) return null;
  const tokens = await refreshAccessToken("MICROSOFT", deps.config.microsoft, deps.secretBox.decrypt(stored.refreshTokenEncrypted), deps.fetch);
  return tokens.accessToken;
}
