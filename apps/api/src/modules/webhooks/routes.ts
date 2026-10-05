import { createHash } from "node:crypto";
import { safeEqual, serializeError } from "@emailbot/shared";
import type { FastifyInstance } from "fastify";
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
        resource: z.string().max(1000),
        resourceData: z.object({ id: z.string().max(1000).optional() }).partial().optional()
      })
    )
    .max(1000)
});

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

    /** Microsoft Graph change notifications (subscription validation + delivery). */
    app.post("/webhooks/microsoft", webhookOptions, async (request, reply) => {
      const expected = deps.config.microsoftWebhookClientState;
      if (!expected) throw notFound("Route");

      // Subscription validation handshake: echo the token as text/plain within 10s.
      const validationToken = (request.query as Record<string, unknown> | undefined)?.validationToken;
      if (typeof validationToken === "string") {
        return reply.status(200).type("text/plain; charset=utf-8").send(validationToken.slice(0, 1024));
      }

      const parsed = graphNotificationSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(202).send();

      let accepted = 0;
      try {
        for (const notification of parsed.data.value) {
          if (!notification.clientState || !safeEqual(notification.clientState, expected)) {
            request.log.warn({ subscriptionId: notification.subscriptionId }, "ignored Graph notification with bad clientState");
            continue;
          }

          const messageId = notification.resourceData?.id ?? null;
          await deps.queue.enqueueEmailEvent(
            {
              type: "MICROSOFT_NOTIFICATION",
              subscriptionId: notification.subscriptionId,
              resource: notification.resource,
              messageId
            },
            { jobId: `graph-${hash(`${notification.subscriptionId}|${messageId ?? notification.resource}`)}` }
          );
          accepted += 1;
        }
      } catch (error) {
        request.log.error({ err: serializeError(error) }, "failed to enqueue Graph notification");
        throw serviceUnavailable("Queue unavailable");
      }

      request.log.info({ accepted }, "Graph notifications enqueued");
      return reply.status(202).send();
    });
  };
}
