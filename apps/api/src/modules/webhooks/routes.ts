import { createHash } from "node:crypto";
import { clientStateMatches, safeEqual, serializeError, subscriptionLogId } from "@emailbot/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { createGoogleOidcVerifier } from "../../lib/google-oidc.js";
import { notFound, serviceUnavailable, unauthorized } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";

/*
 * Provider push endpoints. They ONLY authenticate the notification and
 * enqueue a job; fetching/processing mail happens in the worker. They must
 * answer fast, otherwise providers retry or drop the subscription.
 */

const pubSubPushSchema = z.object({
  message: z.object({
    data: z.string().max(10_000),
    messageId: z.string().optional()
  }),
  subscription: z.string().optional()
});

const gmailNotificationSchema = z.object({
  emailAddress: z.string().min(3).max(320),
  historyId: z.union([z.string(), z.number()]).transform(String)
});

const graphNotificationSchema = z.object({
  value: z
    .array(
      z.object({
        subscriptionId: z.string().max(200),
        clientState: z.string().max(500).optional(),
        changeType: z.string().max(100).optional(),
        resource: z.string().max(1000).optional(),
        resourceData: z.object({ id: z.string().max(1000).optional() }).partial().optional(),
        tenantId: z.string().max(100).optional()
      })
    )
    .max(1000)
});

const LIFECYCLE_EVENTS = ["reauthorizationRequired", "subscriptionRemoved", "missed"] as const;

const graphLifecycleSchema = z.object({
  value: z
    .array(
      z.object({
        subscriptionId: z.string().max(200),
        clientState: z.string().max(500).optional(),
        lifecycleEvent: z.string().max(100),
        subscriptionExpirationDateTime: z.string().max(100).optional(),
        tenantId: z.string().max(100).optional()
      })
    )
    .max(1000)
});

/** Graph validation tokens are opaque strings; anything longer is rejected (never truncated). */
const MAX_VALIDATION_TOKEN_LENGTH = 4096;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function webhookRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const webhookOptions = { config: { rateLimit: RATE_LIMITS.webhook } };

    const pubsubVerifier = deps.pubsubVerifier ?? createGoogleOidcVerifier({ fetch: deps.fetch });

    /**
     * Google Cloud Pub/Sub push subscription for Gmail users.watch().
     *
     * Authentication (configurable, at least one required, both when both are set):
     *  - OIDC (recommended): `Authorization: Bearer <Google-signed JWT>` for the
     *    configured audience and push service account (lib/google-oidc.ts);
     *  - legacy shared token in the push URL (?token=...).
     * Then: validate the envelope, decode {emailAddress, historyId}, ignore
     * unknown mailboxes, enqueue ONE deduplicated job and answer 204. No Gmail
     * call, no message fetch, no processing here: the worker resolves the
     * account(s) and syncs from its own stored cursor (the historyId is only a trigger).
     */
    app.post("/webhooks/gmail", webhookOptions, async (request, reply) => {
      const oidc = deps.config.gmailPubSubOidc;
      const expectedToken = deps.config.gmailPubSubVerificationToken;
      if (!oidc && !expectedToken) throw notFound("Route");

      if (oidc) {
        const header = request.headers.authorization;
        const bearer = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header)?.[1] : undefined;
        let valid = false;
        try {
          valid = bearer !== undefined && (await pubsubVerifier.verify(bearer, { audience: oidc.audience, email: oidc.serviceAccount }));
        } catch (error) {
          // Google's keys could not be fetched: Pub/Sub retries later (never accept unverified pushes).
          request.log.error({ err: serializeError(error) }, "Pub/Sub token verification unavailable");
          throw serviceUnavailable("Push verification unavailable");
        }
        if (!valid) {
          request.log.warn({ event: "gmail.pubsub.rejected", reason: "invalid_oidc_token" }, "Gmail push rejected");
          throw unauthorized("Invalid push authentication");
        }
      }
      if (expectedToken) {
        const token = (request.query as Record<string, unknown> | undefined)?.token;
        if (typeof token !== "string" || !safeEqual(token, expectedToken)) {
          request.log.warn({ event: "gmail.pubsub.rejected", reason: "invalid_token" }, "Gmail push rejected");
          throw unauthorized("Invalid webhook token");
        }
      }

      const envelope = pubSubPushSchema.safeParse(request.body);
      const decoded = envelope.success
        ? gmailNotificationSchema.safeParse(
            (() => {
              try {
                return JSON.parse(Buffer.from(envelope.data.message.data, "base64").toString("utf8"));
              } catch {
                return null;
              }
            })()
          )
        : null;

      // Malformed messages are acknowledged (2xx) so Pub/Sub does not retry them forever.
      if (!decoded?.success) {
        request.log.warn({ event: "gmail.pubsub.rejected", reason: "malformed" }, "ignored malformed Gmail notification");
        return reply.status(204).send();
      }

      const emailAddress = decoded.data.emailAddress.toLowerCase();
      const mailbox = hash(emailAddress);
      const pubsubMessageId = envelope?.success ? envelope.data.message.messageId : undefined;

      // Pushes for mailboxes nobody connected (or disconnected) are acknowledged and dropped.
      const known = await deps.privileged.hasActiveMailbox("GMAIL", emailAddress).catch((error: unknown) => {
        request.log.warn({ err: serializeError(error) }, "mailbox lookup failed; the worker will resolve the account");
        return true;
      });
      if (!known) {
        request.log.info({ event: "gmail.pubsub.rejected", reason: "unknown_mailbox", mailbox }, "Gmail push for an unknown mailbox ignored");
        return reply.status(204).send();
      }

      try {
        await deps.queue.enqueueEmailEvent(
          { type: "GMAIL_NOTIFICATION", emailAddress, historyId: decoded.data.historyId },
          // Duplicates / redeliveries of the same notification are the same job.
          { jobId: `gmail-${mailbox}-${decoded.data.historyId}` }
        );
      } catch (error) {
        request.log.error({ err: serializeError(error) }, "failed to enqueue Gmail notification");
        // Non-2xx makes Pub/Sub redeliver later.
        throw serviceUnavailable("Queue unavailable");
      }
      request.log.info({ event: "gmail.pubsub.received", mailbox, historyId: decoded.data.historyId, pubsubMessageId }, "Gmail push queued");
      return reply.status(204).send();
    });

    /*
     * Microsoft Graph change notifications (F9). Same contract as the Gmail
     * push: authenticate, validate, enqueue ONE job per notification and
     * answer fast (Graph expects a response within a few seconds). No Graph
     * call and no message fetch here: the worker only syncs the account from
     * its delta cursor.
     *
     *   POST /webhooks/microsoft            created messages -> MICROSOFT_NOTIFICATION
     *   POST /webhooks/microsoft/lifecycle  reauthorizationRequired | subscriptionRemoved | missed
     *                                       -> MICROSOFT_LIFECYCLE
     *
     * Both answer the subscription validation handshake (?validationToken=:
     * echoed as text/plain, nothing else done). Notifications are accepted only
     * for a known subscription whose clientState matches the stored SHA-256
     * (constant time); each subscription has its own random clientState.
     * Disabled (404) unless MICROSOFT_GRAPH_PUSH_ENABLED.
     */
    const graphPushEnabled = () => deps.config.microsoftGraphPushEnabled && deps.config.microsoft !== null;

    /** The handshake reply, or null when the request is not a validation request. */
    const validationReply = (request: FastifyRequest, reply: FastifyReply) => {
      const validationToken = (request.query as Record<string, unknown> | undefined)?.validationToken;
      if (validationToken === undefined) return null;
      if (typeof validationToken !== "string" || validationToken.length === 0 || validationToken.length > MAX_VALIDATION_TOKEN_LENGTH) {
        return reply.status(400).type("text/plain; charset=utf-8").send("Invalid validationToken");
      }
      // Echoed exactly (decoded), as Graph requires; no other processing.
      return reply.status(200).type("text/plain; charset=utf-8").send(validationToken);
    };

    /** Known, active subscription with a matching clientState (lookups cached per request). */
    const verifiedSubscription = async (
      cache: Map<string, Promise<Awaited<ReturnType<AppDeps["privileged"]["findMicrosoftSubscription"]>>>>,
      subscriptionId: string,
      clientState: string | undefined
    ): Promise<"ok" | "unknown" | "inactive"> => {
      let lookup = cache.get(subscriptionId);
      if (!lookup) {
        lookup = deps.privileged.findMicrosoftSubscription(subscriptionId);
        cache.set(subscriptionId, lookup);
      }
      const subscription = await lookup;
      if (!subscription || !clientStateMatches(clientState, subscription.clientStateHash)) return "unknown";
      if (subscription.accountStatus !== "ACTIVE" || subscription.organizationStatus !== "ACTIVE") return "inactive";
      return "ok";
    };

    app.post("/webhooks/microsoft", webhookOptions, async (request, reply) => {
      if (!graphPushEnabled()) throw notFound("Route");
      const handshake = validationReply(request, reply);
      if (handshake) return handshake;

      const parsed = graphNotificationSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn({ event: "microsoft.graph.rejected", reason: "malformed" }, "ignored malformed Graph notification");
        return reply.status(202).send();
      }

      const cache = new Map();
      let accepted = 0;
      let ignored = 0;
      try {
        for (const notification of parsed.data.value) {
          const verdict = await verifiedSubscription(cache, notification.subscriptionId, notification.clientState);
          if (verdict !== "ok") {
            ignored += 1;
            request.log.warn(
              { event: "microsoft.graph.rejected", reason: verdict === "unknown" ? "unknown_subscription_or_client_state" : "inactive_account", subscription: subscriptionLogId(notification.subscriptionId) },
              "Graph notification ignored"
            );
            continue;
          }
          const messageId = notification.resourceData?.id ?? null;
          await deps.queue.enqueueEmailEvent(
            { type: "MICROSOFT_NOTIFICATION", subscriptionId: notification.subscriptionId, resource: notification.resource ?? "", messageId },
            // A redelivered notification (same subscription + message) is the same job.
            { jobId: `graph-${hash(`${notification.subscriptionId}|${messageId ?? notification.resource ?? ""}`)}` }
          );
          accepted += 1;
        }
      } catch (error) {
        request.log.error({ err: serializeError(error) }, "failed to verify or enqueue Graph notifications");
        // Non-2xx makes Graph redeliver later (never accept unverified notifications).
        throw serviceUnavailable("Notification processing unavailable");
      }

      request.log.info({ event: "microsoft.graph.received", accepted, ignored }, "Graph notifications processed");
      return reply.status(202).send();
    });

    app.post("/webhooks/microsoft/lifecycle", webhookOptions, async (request, reply) => {
      if (!graphPushEnabled()) throw notFound("Route");
      const handshake = validationReply(request, reply);
      if (handshake) return handshake;

      const parsed = graphLifecycleSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn({ event: "microsoft.lifecycle.rejected", reason: "malformed" }, "ignored malformed Graph lifecycle notification");
        return reply.status(202).send();
      }

      const cache = new Map();
      let accepted = 0;
      let ignored = 0;
      try {
        for (const notification of parsed.data.value) {
          const lifecycleEvent = LIFECYCLE_EVENTS.find((event) => event === notification.lifecycleEvent);
          const verdict = lifecycleEvent ? await verifiedSubscription(cache, notification.subscriptionId, notification.clientState) : "unknown";
          if (!lifecycleEvent || verdict !== "ok") {
            ignored += 1;
            request.log.warn(
              { event: "microsoft.lifecycle.rejected", reason: lifecycleEvent ? verdict : "unsupported_event", subscription: subscriptionLogId(notification.subscriptionId) },
              "Graph lifecycle notification ignored"
            );
            continue;
          }
          await deps.queue.enqueueEmailEvent({ type: "MICROSOFT_LIFECYCLE", subscriptionId: notification.subscriptionId, lifecycleEvent });
          accepted += 1;
          request.log.info({ event: "microsoft.lifecycle.received", lifecycleEvent, subscription: subscriptionLogId(notification.subscriptionId) }, "Graph lifecycle notification queued");
        }
      } catch (error) {
        request.log.error({ err: serializeError(error) }, "failed to verify or enqueue Graph lifecycle notifications");
        throw serviceUnavailable("Notification processing unavailable");
      }

      request.log.info({ event: "microsoft.lifecycle.processed", accepted, ignored }, "Graph lifecycle notifications processed");
      return reply.status(202).send();
    });
  };
}
