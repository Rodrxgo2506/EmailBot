import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "./crypto.js";

/*
 * Microsoft Graph change-notification subscriptions (shared by the worker,
 * which creates and renews them, and the API, which validates notifications
 * and deletes the subscription when an account is disconnected).
 *
 * One subscription per Microsoft account, on the Inbox, changeType "created",
 * with the account's delegated token (authorization code + refresh token; no
 * client credentials). Each subscription has its own random clientState:
 * only its SHA-256 is stored (provider_metadata), which is enough to validate
 * notifications; renewing (PATCH) keeps it, recreating generates a new one.
 */

export const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";
/** Same scope as the delta sync (inbox only). */
export const MICROSOFT_SUBSCRIPTION_RESOURCE = "me/mailFolders('inbox')/messages";
export const MICROSOFT_SUBSCRIPTION_CHANGE_TYPE = "created";
/**
 * Requested lifetime: 70 hours, below every maximum Graph has documented for
 * Outlook messages (4230 minutes historically, 10080 now). Graph returns the
 * effective expirationDateTime, which is what is stored.
 */
export const MICROSOFT_SUBSCRIPTION_LIFETIME_MS = 70 * 60 * 60 * 1000;

/** provider_metadata keys of a Microsoft account's subscription. */
export const MICROSOFT_SUBSCRIPTION_KEYS = { id: "subscriptionId", clientStateHash: "subscriptionClientStateHash" } as const;

/** Graph subscription ids are GUIDs; anything else is never used in a URL or a lookup. */
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGraphSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && SUBSCRIPTION_ID.test(value);
}

export function graphSubscriptionUrl(subscriptionId: string): string {
  if (!isGraphSubscriptionId(subscriptionId)) throw new Error("Invalid Graph subscription id");
  return `${GRAPH_API_URL}/subscriptions/${subscriptionId}`;
}

/** Lifecycle notifications go to `<notification URL>/lifecycle` (served by the same API). */
export function graphLifecycleUrl(notificationUrl: string): string {
  return `${notificationUrl.replace(/\/+$/, "")}/lifecycle`;
}

/** 256-bit random clientState (Graph accepts up to 128 characters). */
export function generateClientState(): string {
  return randomBytes(32).toString("base64url");
}

export function hashClientState(clientState: string): string {
  return createHash("sha256").update(clientState, "utf8").digest("hex");
}

/** Constant-time comparison of a received clientState with the stored hash. */
export function clientStateMatches(received: string | undefined, storedHash: unknown): boolean {
  if (typeof received !== "string" || received.length === 0 || typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return safeEqual(hashClientState(received), storedHash);
}

/** The subscription stored on an account (null when there is none or it is malformed). */
export function readMicrosoftSubscription(providerMetadata: Record<string, unknown> | null | undefined): { id: string; clientStateHash: string } | null {
  const id = providerMetadata?.[MICROSOFT_SUBSCRIPTION_KEYS.id];
  const clientStateHash = providerMetadata?.[MICROSOFT_SUBSCRIPTION_KEYS.clientStateHash];
  return isGraphSubscriptionId(id) && typeof clientStateHash === "string" ? { id, clientStateHash } : null;
}

/** provider_metadata with the subscription keys replaced (or removed with `null`); other keys are kept. */
export function withMicrosoftSubscription(
  providerMetadata: Record<string, unknown> | null | undefined,
  subscription: { id: string; clientStateHash: string } | null
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(providerMetadata ?? {}) };
  delete rest[MICROSOFT_SUBSCRIPTION_KEYS.id];
  delete rest[MICROSOFT_SUBSCRIPTION_KEYS.clientStateHash];
  return subscription
    ? { ...rest, [MICROSOFT_SUBSCRIPTION_KEYS.id]: subscription.id, [MICROSOFT_SUBSCRIPTION_KEYS.clientStateHash]: subscription.clientStateHash }
    : rest;
}

/** Short, non-reversible label of a subscription id for logs. */
export function subscriptionLogId(subscriptionId: string): string {
  return createHash("sha256").update(subscriptionId).digest("hex").slice(0, 12);
}
