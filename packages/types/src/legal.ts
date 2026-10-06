/**
 * Current versions of the legal documents (EmailBot V2 phase 7). Single
 * source for the web app (pages, sign-up, re-acceptance screen) and the API
 * (which records the acceptance and decides whether a user must accept
 * again). Change a version only when the text of that document changes; every
 * user is then asked to accept it again.
 */
export const LEGAL_DOCUMENTS = ["terms", "privacy"] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

export const CURRENT_LEGAL_VERSIONS: Readonly<Record<LegalDocument, string>> = Object.freeze({
  terms: "2.0",
  privacy: "2.0"
});

/** A recorded acceptance (public.legal_acceptances). */
export interface LegalAcceptanceRecord {
  document: LegalDocument;
  version: string;
}

/** GET /api/me `legal` and POST /api/me/legal-acceptance response. */
export interface LegalAcceptanceStatus {
  termsVersion: string;
  privacyVersion: string;
  /** Both CURRENT versions are accepted; any older (or other) version does not count. */
  accepted: boolean;
}

/** Exact match per document: accepting 2.0 does not cover 2.1, and 1.0 does not cover 2.0. */
export function legalAcceptanceStatus(
  records: readonly LegalAcceptanceRecord[],
  current: Readonly<Record<LegalDocument, string>> = CURRENT_LEGAL_VERSIONS
): LegalAcceptanceStatus {
  const accepted = LEGAL_DOCUMENTS.every((document) =>
    records.some((record) => record.document === document && record.version === current[document])
  );
  return { termsVersion: current.terms, privacyVersion: current.privacy, accepted };
}
