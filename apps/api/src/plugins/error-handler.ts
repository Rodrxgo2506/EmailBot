import { serializeError } from "@emailbot/shared";
import type { ApiErrorBody } from "@emailbot/types";
import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "../lib/errors.js";
import { captureException } from "../lib/sentry.js";

/**
 * Consistent JSON error responses: { error: { code, message, requestId } }.
 * Internal errors are logged (without secrets) and returned as a generic 500.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        const cause = (error as { cause?: unknown }).cause;
        request.log.error({ err: serializeError(cause ?? error), code: error.code }, "request failed");
        captureException(cause ?? error, { requestId: request.id, code: error.code });
      } else {
        request.log.info({ code: error.code, statusCode: error.statusCode }, error.message);
      }

      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      };
      return reply.status(error.statusCode).send(body);
    }

    // Fastify's own client errors (malformed JSON, payload too large, unsupported media type...).
    const statusCode = (error as FastifyError).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const body: ApiErrorBody = {
        error: { code: (error as FastifyError).code ?? "BAD_REQUEST", message: error.message, requestId: request.id }
      };
      return reply.status(statusCode).send(body);
    }

    request.log.error({ err: serializeError(error) }, "unhandled error");
    captureException(error, { requestId: request.id });

    const body: ApiErrorBody = {
      error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId: request.id }
    };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = { error: { code: "NOT_FOUND", message: "Route not found", requestId: request.id } };
    return reply.status(404).send(body);
  });
}
