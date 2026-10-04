import { createHash } from "node:crypto";

/** Private Supabase Storage bucket created by migration 5. */
export const DEFAULT_ATTACHMENTS_BUCKET = "email-attachments";

/** Signed download URLs are short-lived. */
export const ATTACHMENT_URL_TTL_SECONDS = 60;

/**
 * Human-readable cleanup of a filename (Unicode letters are kept). NOT valid
 * as a Storage object key: Supabase Storage only accepts a subset of ASCII
 * (see storageObjectName).
 */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .normalize("NFKC")
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);

  return cleaned.length > 0 ? cleaned : "attachment";
}

/** Letters that Unicode NFKD does not decompose into ASCII. */
const TRANSLITERATIONS: Record<string, string> = {
  ß: "ss",
  Æ: "AE",
  æ: "ae",
  Ø: "O",
  ø: "o",
  Œ: "OE",
  œ: "oe",
  Đ: "D",
  đ: "d",
  Ð: "D",
  ð: "d",
  Ł: "L",
  ł: "l",
  Þ: "Th",
  þ: "th",
  ı: "i"
};

const MAX_OBJECT_STEM_LENGTH = 100;
const OBJECT_NAME_HASH_LENGTH = 12;

/**
 * Physical name of an attachment object in Storage.
 *
 * Supabase Storage rejects object keys outside /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/
 * ("Invalid key"), so a raw name such as "Cotización.xlsx" or "报告.pdf" can
 * never be uploaded. The key uses only [A-Za-z0-9._-]:
 *
 *  - accents are transliterated ("Cotización" -> "Cotizacion"), anything
 *    else becomes "_", and a safe extension (".pdf") is preserved;
 *  - when that changes the name, a hash of the ORIGINAL name is appended
 *    ("Cotizacion-<12 hex>.xlsx"), so different originals never share a key
 *    and names with no ASCII left still get one ("attachment-<hash>.pdf");
 *  - names that are already safe stay unchanged ("factura.pdf").
 *
 * Deterministic (same input, same key) so a retried upload overwrites the
 * same object. The original filename is kept in email_attachments.filename
 * and is the name the user sees and downloads.
 */
export function storageObjectName(filename: string): string {
  const ascii = filename
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ßÆæØøŒœĐđÐðŁłÞþı]/g, (letter) => TRANSLITERATIONS[letter] ?? "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_");

  const dot = ascii.lastIndexOf(".");
  const candidate = dot > 0 ? ascii.slice(dot) : "";
  const extension = /^\.[A-Za-z0-9]{1,16}$/.test(candidate) ? candidate : "";
  const stem = (extension ? ascii.slice(0, dot) : ascii)
    .replace(/_{2,}/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .slice(0, MAX_OBJECT_STEM_LENGTH)
    .replace(/[._-]+$/, "");

  if (stem.length > 0 && `${stem}${extension}` === filename) return filename;

  const hash = createHash("sha256").update(filename, "utf8").digest("hex").slice(0, OBJECT_NAME_HASH_LENGTH);
  return `${stem || "attachment"}-${hash}${extension}`;
}

/**
 * Storage object path: <organization>/<email>/<attachment>/<object name>.
 * The organization id is always the first segment so objects are
 * partitioned by tenant (and could be protected by storage RLS using
 * storage.foldername(name)[1] if direct client access is ever added).
 */
export function buildAttachmentPath(params: {
  organizationId: string;
  emailId: string;
  attachmentId: string;
  filename: string;
}): string {
  return [params.organizationId, params.emailId, params.attachmentId, storageObjectName(params.filename)].join("/");
}
