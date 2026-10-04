import { createHash } from "node:crypto";
import { safeEqual, serializeError } from "@emailbot/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
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

    /** Google Cloud Pub/Sub push subscription for Gmail watch(). */
    app.post("/webhooks/gmail", webhookOptions, async (request, reply) => {
      const expected = deps.config.gmailPubSubVerificationToken;
      if (!expected) throw notFound("Route");

      const token = (request.query as Record<string, unknown> | undefined)?.token;
      if (typeof token !== "string" || !safeEqual(token, expected)) throw unauthorized("Invalid webhook token");

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
        request.log.warn("ignored malformed Gmail notification");
        return reply.status(204).send();
      }

      try {
        await deps.queue.enqueueEmailEvent(
          { type: "GMAIL_NOTIFICATION", emailAddress: decoded.data.emailAddress.toLowerCase(), historyId: decoded.data.historyId },
          { jobId: `gmail-${hash(decoded.data.emailAddress.toLowerCase())}-${decoded.data.historyId}` }
        );
      } catch (error) {
        request.log.error({ err: serializeError(error) }, "failed to enqueue Gmail notification");
        // Non-2xx makes Pub/Sub redeliver later.
        throw serviceUnavailable("Queue unavailable");
      }
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
