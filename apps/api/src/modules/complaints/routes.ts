import { randomUUID } from "node:crypto";
import { serializeError } from "@emailbot/shared";
import type {
  ComplaintBookEntry,
  ComplaintBookReceipt,
  ComplaintConfirmationResendResult,
  ComplaintResponseResult,
  OffsetPage
} from "@emailbot/types";
import {
  complaintAmountToCents,
  complaintBookSubmissionSchema,
  complaintCopyResendSchema,
  complaintEmailConfirmationSchema,
  complaintResponseSchema,
  idParamsSchema,
  paginationQuerySchema
} from "@emailbot/validation";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppDeps, MailOutcome, OutgoingEmail, TransactionalMailer } from "../../deps.js";
import { AppError, conflict, notFound, serviceUnavailable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import type { ComplaintCopy, ComplaintEmailOutcome } from "../../repositories/types.js";
import { complaintCopyEmail, complaintResponseEmail } from "./emails.js";

/*
 * Libro de Reclamaciones (Peru, D.S. 011-2011-PCM and amendments), /api/*.
 *
 * - POST /complaints-book: the public form of emailbot.app. No session (any consumer may file a sheet);
 *   validated here and again by public.submit_complaint_book_entry, which assigns the correlative number
 *   atomically (sequence). Rate limited per IP. A retried submission (same submissionId) returns the sheet
 *   already recorded. Once the sheet is stored, the consumer's copy is e-mailed. The e-mail never decides the
 *   answer: whatever the provider says, the sheet stays recorded and the response confirms it, with the state
 *   of the copy (SENT, PENDING or FAILED).
 * - GET /admin/complaints-book: platform administrators only (requirePlatformAdmin here, and every admin.*
 *   function checks the actor again in the database).
 * - POST /admin/complaints-book/:id/response: an administrator answers by e-mail. The case becomes RESPONDED
 *   only when the provider accepted the e-mail. Every outcome is audited (platform_audit_logs).
 * - POST /admin/complaints-book/:id/confirmation-email: sends the consumer's copy again (audited).
 *
 * E-mail outcomes: SENT (accepted), REJECTED (the provider confirmed it did not accept it: retryable with a
 * new idempotency key) and UNKNOWN (timeout, network error, 5xx, 409: it may have been accepted). UNKNOWN is
 * never treated as a failure: the claim expires and the next attempt repeats the same operation (same key,
 * byte-identical content, built only from stored data), so the provider never sends it twice.
 *
 * The provider keeps idempotency keys 24 hours. Past 23 hours (1 h margin) an attempt with an unknown outcome is
 * never repeated automatically (the database refuses it): an administrator records it as sent with the
 * provider's message id (POST .../confirm, found in the provider's dashboard or in these logs: every accepted
 * e-mail logs its providerMessageId) or forces a new attempt knowing it may duplicate it (forceResend). Both
 * are audited. Exactly-once cannot be guaranteed past the provider's window; a silent duplicate can.
 *
 * Logs carry the code, the outcome and the provider message id; never the consumer's data, the sheet or the
 * answer.
 */

/** The mailer never throws by contract; if it did, nothing is known about the e-mail: UNKNOWN. */
async function deliver(mailer: TransactionalMailer, email: OutgoingEmail): Promise<MailOutcome> {
  try {
    return await mailer.send(email);
  } catch {
    return { outcome: "UNKNOWN", errorCode: "PROVIDER_ERROR" };
  }
}

const toRecord = (result: MailOutcome): ComplaintEmailOutcome =>
  result.outcome === "SENT" ? { outcome: "SENT", providerMessageId: result.providerMessageId } : { outcome: result.outcome, errorCode: result.errorCode };

/**
 * Claims, sends and records the consumer's copy. Never throws: the sheet is already recorded, so any failure
 * here only leaves the copy PENDING / FAILED / uncertain (visible to administrators, who can send it again).
 * The consumer sees SENT only when the provider accepted it.
 */
async function sendConsumerCopy(
  deps: AppDeps,
  log: FastifyBaseLogger,
  code: string,
  claim: () => Promise<ComplaintCopy | null>,
  record: (outcome: ComplaintEmailOutcome) => Promise<unknown>
): Promise<"SENT" | "PENDING" | "FAILED"> {
  if (!deps.mailer) {
    log.warn({ event: "complaints_book.copy_not_configured", code }, "complaints book copy pending: transactional e-mail is not configured");
    return "PENDING";
  }
  let copy: ComplaintCopy | null;
  try {
    copy = await claim();
  } catch (error) {
    log.error({ event: "complaints_book.copy_claim_failed", code, err: serializeError(error) }, "complaints book copy could not be claimed");
    return "PENDING";
  }
  // Already sent, or another request is sending it right now.
  if (!copy) return "PENDING";

  const result = await deliver(deps.mailer, complaintCopyEmail(copy));
  try {
    await recordWithRetries(() => record(toRecord(result)));
  } catch (error) {
    // The provider's answer stands; the claim expires and the retry reuses the same key and content.
    log.error(
      { event: "complaints_book.copy_record_failed", code, outcome: result.outcome, err: serializeError(error) },
      "complaints book copy outcome not recorded"
    );
  }
  if (result.outcome === "SENT") {
    log.info({ event: "complaints_book.copy_sent", code, providerMessageId: result.providerMessageId }, "complaints book copy e-mailed");
    return "SENT";
  }
  if (result.outcome === "UNKNOWN") {
    log.warn({ event: "complaints_book.copy_uncertain", code, errorCode: result.errorCode }, "complaints book copy outcome unknown");
    return "PENDING";
  }
  log.warn({ event: "complaints_book.copy_failed", code, errorCode: result.errorCode }, "complaints book copy not sent");
  return "FAILED";
}

function requireMailer(deps: AppDeps): TransactionalMailer {
  if (!deps.mailer) throw serviceUnavailable("Transactional e-mail is not configured", "EMAIL_NOT_CONFIGURED");
  return deps.mailer;
}

/**
 * Records an outcome, retrying briefly: when the provider accepted an e-mail, losing that fact to a transient
 * database error is what could later lead to a duplicate.
 */
async function recordWithRetries<T>(record: () => Promise<T>): Promise<T> {
  const delays = [100, 400];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await record();
    } catch (error) {
      if (attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** 502 for an e-mail the provider rejected, or whose outcome is unknown (never reported as sent or as failed). */
function emailNotConfirmed(result: Exclude<MailOutcome, { outcome: "SENT" }>, what: string): AppError {
  return result.outcome === "UNKNOWN"
    ? new AppError(
        502,
        "EMAIL_OUTCOME_UNKNOWN",
        `The e-mail provider did not confirm the ${what}; it may have been sent. Try again in two minutes: it will not be sent twice`,
        { errorCode: result.errorCode }
      )
    : new AppError(502, "EMAIL_NOT_SENT", `The e-mail provider did not accept the ${what}`, { errorCode: result.errorCode });
}

export function complaintsBookRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    app.post("/complaints-book", { config: { rateLimit: RATE_LIMITS.complaintSubmit } }, async (request, reply): Promise<ComplaintBookReceipt> => {
      const input = parseWith(complaintBookSubmissionSchema, request.body);
      const sheet = await deps.privileged.submitComplaintBookEntry({
        submissionId: input.submissionId ?? randomUUID(),
        kind: input.kind,
        firstNames: input.firstNames,
        lastNames: input.lastNames,
        documentType: input.documentType,
        documentNumber: input.documentNumber,
        email: input.email,
        phone: input.phone,
        address: input.address,
        isMinor: input.isMinor,
        guardianName: input.isMinor ? input.guardianName : null,
        goodType: input.goodType,
        goodDescription: input.goodDescription,
        claimedAmountCents: complaintAmountToCents(input.claimedAmount),
        detail: input.detail,
        consumerRequest: input.consumerRequest,
        requestId: request.id
      });
      request.log.info(
        { event: "complaints_book.submitted", code: sheet.code, kind: sheet.kind, replayed: sheet.replayed },
        sheet.replayed ? "complaints book sheet already recorded (retried submission)" : "complaints book sheet recorded"
      );

      const confirmationEmail =
        sheet.confirmationEmailStatus === "SENT"
          ? "SENT"
          : await sendConsumerCopy(
              deps,
              request.log,
              sheet.code,
              () => deps.privileged.claimComplaintConfirmationEmail(sheet.id),
              (outcome) => deps.privileged.recordComplaintConfirmationEmail(sheet.id, outcome)
            );

      const receipt: ComplaintBookReceipt = { code: sheet.code, number: sheet.number, kind: sheet.kind, createdAt: sheet.createdAt, confirmationEmail };
      return reply.status(sheet.replayed ? 200 : 201).send(receipt);
    });

    app.get("/admin/complaints-book", { preHandler: [app.authenticate, app.requirePlatformAdmin] }, async (request): Promise<OffsetPage<ComplaintBookEntry>> => {
      const query = parseWith(paginationQuerySchema, request.query, "query");
      const rows = await deps.admin.listComplaintBookEntries(getAuth(request).user.id, {
        limit: query.pageSize + 1,
        offset: (query.page - 1) * query.pageSize
      });
      return { items: rows.slice(0, query.pageSize), page: query.page, pageSize: query.pageSize, hasMore: rows.length > query.pageSize };
    });

    app.post(
      "/admin/complaints-book/:id/response",
      { preHandler: [app.authenticate, app.requirePlatformAdmin], config: { rateLimit: RATE_LIMITS.complaintEmail } },
      async (request): Promise<ComplaintResponseResult> => {
        const { id } = parseWith(idParamsSchema, request.params, "params");
        const { response, forceResend } = parseWith(complaintResponseSchema, request.body);
        const mailer = requireMailer(deps);
        const actorId = getAuth(request).user.id;

        const claim = await deps.admin.beginComplaintResponse(actorId, id, response, forceResend === true);
        if (claim.outcome !== "READY") {
          if (claim.outcome === "NOT_FOUND") throw notFound("Complaint");
          if (claim.outcome === "ALREADY_RESPONDED") throw conflict("This complaint was already answered", "COMPLAINT_ALREADY_RESPONDED");
          if (claim.outcome === "TEXT_LOCKED") {
            throw conflict("The previous answer may have been sent; only the same text can be sent again", "COMPLAINT_RESPONSE_TEXT_LOCKED");
          }
          if (claim.outcome === "NEEDS_DECISION") {
            throw conflict(
              "The previous answer may have been sent and the provider no longer deduplicates it: confirm it was sent, or force a resend",
              "COMPLAINT_RESPONSE_DECISION_REQUIRED"
            );
          }
          throw conflict("Another answer to this complaint is being sent, or its outcome is still unknown", "COMPLAINT_RESPONSE_IN_PROGRESS");
        }

        // Built only from the stored operation (text, date, key): every retry sends the same e-mail.
        const target = claim.target;
        const result = await deliver(mailer, complaintResponseEmail(target));
        const recorded = await recordWithRetries(() => deps.admin.recordComplaintResponse(actorId, id, toRecord(result), request.id)).catch((error: unknown) => {
          request.log.error(
            { event: "complaints_book.response_record_failed", code: target.code, outcome: result.outcome, err: serializeError(error) },
            "complaint answer outcome not recorded"
          );
          return null;
        });

        if (result.outcome !== "SENT") {
          request.log.warn(
            { event: result.outcome === "UNKNOWN" ? "complaints_book.response_uncertain" : "complaints_book.response_failed", code: target.code, errorCode: result.errorCode },
            result.outcome === "UNKNOWN" ? "complaint answer outcome unknown" : "complaint answer not sent"
          );
          throw emailNotConfirmed(result, "answer");
        }
        request.log.info({ event: "complaints_book.response_sent", code: target.code, providerMessageId: result.providerMessageId }, "complaint answer e-mailed");
        if (!recorded) {
          // Sent but not recorded: the same operation is retried after the claim expires (same key, same content).
          throw new AppError(
            500,
            "COMPLAINT_RESPONSE_NOT_RECORDED",
            "The answer was sent but could not be recorded; send the same text again in two minutes (it will not be sent twice)"
          );
        }
        return { status: recorded.status, respondedAt: recorded.respondedAt };
      }
    );

    app.post(
      "/admin/complaints-book/:id/response/confirm",
      { preHandler: [app.authenticate, app.requirePlatformAdmin], config: { rateLimit: RATE_LIMITS.adminWrite } },
      async (request): Promise<ComplaintResponseResult> => {
        const { id } = parseWith(idParamsSchema, request.params, "params");
        const { providerMessageId } = parseWith(complaintEmailConfirmationSchema, request.body);
        const result = await deps.admin.confirmComplaintResponse(getAuth(request).user.id, id, providerMessageId, request.id);
        if (result.outcome !== "CONFIRMED") {
          throw conflict("Only an answer whose outcome is unknown (and that nobody is sending) can be confirmed", "COMPLAINT_EMAIL_NOT_UNCERTAIN");
        }
        request.log.info({ event: "complaints_book.response_confirmed_manually", providerMessageId }, "complaint answer recorded as sent by an administrator");
        return { status: result.status, respondedAt: result.respondedAt };
      }
    );

    app.post(
      "/admin/complaints-book/:id/confirmation-email/confirm",
      { preHandler: [app.authenticate, app.requirePlatformAdmin], config: { rateLimit: RATE_LIMITS.adminWrite } },
      async (request): Promise<ComplaintConfirmationResendResult> => {
        const { id } = parseWith(idParamsSchema, request.params, "params");
        const { providerMessageId } = parseWith(complaintEmailConfirmationSchema, request.body);
        const outcome = await deps.admin.confirmComplaintConfirmationEmail(getAuth(request).user.id, id, providerMessageId, request.id);
        if (outcome !== "CONFIRMED") {
          throw conflict("Only a copy whose outcome is unknown (and that nobody is sending) can be confirmed", "COMPLAINT_EMAIL_NOT_UNCERTAIN");
        }
        request.log.info({ event: "complaints_book.copy_confirmed_manually", providerMessageId }, "complaints book copy recorded as sent by an administrator");
        return { confirmationEmail: "SENT" };
      }
    );

    app.post(
      "/admin/complaints-book/:id/confirmation-email",
      { preHandler: [app.authenticate, app.requirePlatformAdmin], config: { rateLimit: RATE_LIMITS.complaintEmail } },
      async (request): Promise<ComplaintConfirmationResendResult> => {
        const { id } = parseWith(idParamsSchema, request.params, "params");
        const { forceResend } = parseWith(complaintCopyResendSchema, request.body ?? {});
        const mailer = requireMailer(deps);
        const actorId = getAuth(request).user.id;

        const copy = await deps.admin.claimComplaintConfirmationEmail(actorId, id, forceResend === true);
        if (!copy) {
          throw conflict(
            "The copy was already sent, is being sent, its outcome is still unknown, or it needs a decision (confirm it or force a resend)",
            "COMPLAINT_COPY_NOT_PENDING"
          );
        }

        const result = await deliver(mailer, complaintCopyEmail(copy));
        await recordWithRetries(() => deps.admin.recordComplaintConfirmationEmail(actorId, id, toRecord(result), request.id)).catch((error: unknown) => {
          request.log.error(
            { event: "complaints_book.copy_record_failed", code: copy.code, outcome: result.outcome, err: serializeError(error) },
            "complaints book copy outcome not recorded"
          );
        });

        if (result.outcome !== "SENT") {
          request.log.warn(
            { event: result.outcome === "UNKNOWN" ? "complaints_book.copy_uncertain" : "complaints_book.copy_failed", code: copy.code, errorCode: result.errorCode },
            result.outcome === "UNKNOWN" ? "complaints book copy outcome unknown" : "complaints book copy not sent"
          );
          throw emailNotConfirmed(result, "copy");
        }
        request.log.info({ event: "complaints_book.copy_sent", code: copy.code, providerMessageId: result.providerMessageId }, "complaints book copy e-mailed");
        return { confirmationEmail: "SENT" };
      }
    );
  };
}
