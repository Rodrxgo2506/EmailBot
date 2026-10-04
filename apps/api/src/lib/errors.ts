/** Error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to perform this action", code = "FORBIDDEN") =>
  new AppError(403, code, message);
export const notFound = (resource = "Resource") => new AppError(404, "NOT_FOUND", `${resource} not found`);
export const conflict = (message: string, code = "CONFLICT") => new AppError(409, code, message);
export const unprocessable = (message: string, code = "UNPROCESSABLE") => new AppError(422, code, message);
export const serviceUnavailable = (message: string, code = "SERVICE_UNAVAILABLE") =>
  new AppError(503, code, message);

/** Shape of errors returned by supabase-js / PostgREST. */
export interface DatabaseErrorLike {
  code?: string | undefined;
  message: string;
  details?: string | null | undefined;
  hint?: string | null | undefined;
}

/**
 * Maps PostgreSQL / PostgREST errors to HTTP errors. Messages raised by our
 * own SQL functions (P0001) are authored by us and safe to return; other
 * database messages are replaced by generic text to avoid leaking schema
 * details.
 */
export function fromDatabaseError(error: DatabaseErrorLike): AppError {
  switch (error.code) {
    case "42501":
      return forbidden("The database rejected this operation for your role");
    case "23505":
      return conflict("A resource with the same unique values already exists", "ALREADY_EXISTS");
    case "23503":
      return unprocessable("A referenced resource does not exist", "INVALID_REFERENCE");
    case "23514":
    case "23502":
    case "22P02":
    case "22001":
      return badRequest("The data violates a database constraint", "CONSTRAINT_VIOLATION");
    case "P0001":
      return unprocessable(error.message, "BUSINESS_RULE_VIOLATION");
    case "PGRST116":
      return notFound();
    default: {
      const appError = new AppError(500, "DATABASE_ERROR", "Unexpected database error");
      (appError as { cause?: unknown }).cause = error;
      return appError;
    }
  }
}

/** Unwraps a supabase-js result, throwing a mapped AppError on failure. */
export function unwrap<T>(result: { data: T; error: DatabaseErrorLike | null }): T {
  if (result.error) throw fromDatabaseError(result.error);
  return result.data;
}
