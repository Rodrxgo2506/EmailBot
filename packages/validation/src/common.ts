import { z } from "zod";

/**
 * Any PostgreSQL uuid. `z.guid()` is used instead of `z.uuid()` because the
 * latter enforces RFC 9562 version bits, which is stricter than Postgres.
 */
export const idSchema = z.guid();

export const idParamsSchema = z.object({ id: idSchema });

/** Same format enforced by the organizations/categories slug check constraints. */
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must contain lowercase letters, digits and single dashes");

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

/** Query-string boolean: only the literal strings "true" / "false" are accepted. */
export const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/**
 * Converts free text into a slug compatible with the database constraints.
 * "Códigos Temporales" -> "codigos-temporales".
 */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

  return slug;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
