import { z } from "zod";
import { encryptionKeyProblem } from "./crypto.js";

/** Treats "" as undefined so optional variables can be left blank in .env. */
export function optionalEnv<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

/** Comma separated list -> string[] (blank entries removed). */
export const csvEnv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Parses environment variables. Error messages contain variable names and
 * the reason only — never the received values, which may be secrets.
 */
export function parseEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    );
  }
  return result.data;
}

/**
 * TOKEN_ENCRYPTION_KEY, validated identically by the API and the worker
 * (always, not only in production: a weak key must never encrypt real data).
 */
export const encryptionKeyEnv = z.string().optional().superRefine((value, ctx) => {
  const problem = encryptionKeyProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
}).transform((value) => value as string);
