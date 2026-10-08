import type { MailOutcome, TransactionalMailer } from "../deps.js";

/*
 * Transactional e-mail through Resend's HTTP API (POST https://api.resend.com/emails), the provider that
 * already sends EmailBot's authentication e-mails (Supabase SMTP). Only used by the API for the Libro de
 * Reclamaciones e-mails.
 *
 * - Idempotency-Key: the same key with the same payload within 24 hours returns the first result instead of
 *   sending again. The callers guarantee byte-identical content for the same key.
 * - Outcomes:
 *     SENT      2xx: the provider accepted the e-mail (accepted, not necessarily delivered).
 *     REJECTED  the provider answered that it did NOT accept it: 400 / 422 (validation), 401 / 403 (key),
 *               429 (rate limit; nothing was sent). Safe to retry later with a new key.
 *     UNKNOWN   timeout, network error, 5xx, 409 (concurrent request with this key, or the key was already
 *               used): it may have been accepted, so the caller must retry with the SAME key and content.
 * - Never throws and never logs: the caller gets the provider's message id or a short error code. Request and
 *   response bodies (addresses, content) are not kept anywhere.
 */

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export interface ResendMailerOptions {
  apiKey: string;
  /** Sender on a domain verified in Resend, e.g. "EmailBot <no-reply@emailbot.app>". */
  from: string;
  /** Where the consumer's replies go (the support mailbox). */
  replyTo: string;
  fetch: typeof fetch;
}

function outcomeFor(status: number): Exclude<MailOutcome, { outcome: "SENT" }> {
  if (status === 401 || status === 403) return { outcome: "REJECTED", errorCode: "PROVIDER_AUTH" };
  if (status === 429) return { outcome: "REJECTED", errorCode: "PROVIDER_RATE_LIMITED" };
  if (status === 409) return { outcome: "UNKNOWN", errorCode: "PROVIDER_CONFLICT" };
  if (status >= 500) return { outcome: "UNKNOWN", errorCode: "PROVIDER_UNAVAILABLE" };
  if (status >= 400) return { outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" };
  // 1xx / 3xx: not a documented answer of the API.
  return { outcome: "UNKNOWN", errorCode: "PROVIDER_ERROR" };
}

/** Timeouts of fetchWithTimeout (HttpTimeoutError) and of a bare AbortSignal.timeout (TimeoutError). */
const isTimeout = (error: unknown) => error instanceof Error && (error.name === "HttpTimeoutError" || error.name === "TimeoutError");

export function createResendMailer(options: ResendMailerOptions): TransactionalMailer {
  return {
    async send(email) {
      let response: Response;
      try {
        response = await options.fetch(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": email.idempotencyKey
          },
          body: JSON.stringify({
            from: options.from,
            to: [email.to],
            reply_to: options.replyTo,
            subject: email.subject,
            html: email.html,
            text: email.text,
            tags: [{ name: "category", value: email.category }]
          })
        });
      } catch (error) {
        // The request may have reached the provider: never a confirmed failure.
        return { outcome: "UNKNOWN", errorCode: isTimeout(error) ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK" };
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return outcomeFor(response.status);
      }
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      const id = typeof body?.id === "string" && body.id.length > 0 && body.id.length <= 200 ? body.id : null;
      // 2xx = accepted by the provider, even if the id cannot be read (never report it as not sent).
      return { outcome: "SENT", providerMessageId: id };
    }
  };
}
