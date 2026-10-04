import type { z } from "zod";
import { badRequest } from "./errors.js";

/** Parses params/query/body with a Zod schema, producing a 400 on failure. */
export function parseWith<T extends z.ZodType>(schema: T, data: unknown, part = "body"): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw badRequest(
      `Invalid request ${part}`,
      "VALIDATION_ERROR",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    );
  }
  return result.data;
}

/**
 * Removes keys whose value is undefined. Needed because the codebase uses
 * `exactOptionalPropertyTypes`, and handy before building update payloads.
 */
export function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
