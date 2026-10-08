/*
 * Libro de Reclamaciones (Peru, D.S. 011-2011-PCM and amendments): the public
 * form of emailbot.app, the e-mails to the consumer and the platform
 * administration view.
 */

/** RECLAMO: disagreement with the products / services. QUEJA: disagreement not related to them, or with the service to the public. */
export const COMPLAINT_KINDS = ["RECLAMO", "QUEJA"] as const;
export type ComplaintKind = (typeof COMPLAINT_KINDS)[number];

export const COMPLAINT_DOCUMENT_TYPES = ["DNI", "CE", "PASAPORTE", "RUC"] as const;
export type ComplaintDocumentType = (typeof COMPLAINT_DOCUMENT_TYPES)[number];

export const COMPLAINT_GOOD_TYPES = ["PRODUCTO", "SERVICIO"] as const;
export type ComplaintGoodType = (typeof COMPLAINT_GOOD_TYPES)[number];

/** PENDING until an answer was e-mailed to the consumer (accepted by the e-mail provider). */
export const COMPLAINT_STATUSES = ["PENDING", "RESPONDED"] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/** Copy of the sheet e-mailed to the consumer. SENDING: one sender is on it right now. */
export const COMPLAINT_EMAIL_STATUSES = ["PENDING", "SENDING", "SENT", "FAILED"] as const;
export type ComplaintEmailStatus = (typeof COMPLAINT_EMAIL_STATUSES)[number];

/** Answer limits (also checked by the database). */
export const COMPLAINT_RESPONSE_MIN_LENGTH = 10;
export const COMPLAINT_RESPONSE_MAX_LENGTH = 5000;

/** Provider data printed on the sheet and on its e-mails (same values as the web's legal pages). */
export const COMPLAINTS_BOOK_PROVIDER = {
  tradeName: "EmailBot",
  holder: "REATEGUI RODRIGUEZ, RODRIGO FARID",
  ruc: "10733272231",
  address: "Jr Manco Cápac 653, Pucallpa, Ucayali, Perú",
  supportEmail: "soporte@emailbot.app",
  website: "https://emailbot.app"
} as const;

/** What the consumer receives after submitting: the correlative code to keep. */
export interface ComplaintBookReceipt {
  code: string;
  number: number;
  kind: ComplaintKind;
  createdAt: string;
  /** Copy of the sheet by e-mail: SENT, or PENDING / FAILED (the sheet is recorded anyway). */
  confirmationEmail: "SENT" | "PENDING" | "FAILED";
}

/** A complaints book sheet as the platform administrators see it. */
export interface ComplaintBookEntry {
  id: string;
  number: number;
  code: string;
  kind: ComplaintKind;
  status: ComplaintStatus;
  consumer: {
    firstNames: string;
    lastNames: string;
    documentType: ComplaintDocumentType;
    documentNumber: string;
    email: string;
    phone: string;
    address: string;
    isMinor: boolean;
    guardianName: string | null;
  };
  good: {
    type: ComplaintGoodType;
    description: string;
    claimedAmountCents: number | null;
  };
  detail: string;
  consumerRequest: string;
  confirmationEmail: {
    status: ComplaintEmailStatus;
    sentAt: string | null;
    errorCode: string | null;
    /** Unknown outcome past the provider's idempotency window: not resent automatically, an administrator decides. */
    decisionRequired: boolean;
  };
  response: {
    /** Last answer written; delivered only when emailStatus is SENT. */
    text: string | null;
    emailStatus: Exclude<ComplaintEmailStatus, "PENDING"> | null;
    errorCode: string | null;
    respondedAt: string | null;
    respondedByEmail: string | null;
    /** Unknown outcome past the provider's idempotency window: not resent automatically, an administrator decides. */
    decisionRequired: boolean;
  };
  createdAt: string;
}

/** POST /api/admin/complaints-book/:id/response */
export interface ComplaintResponseResult {
  status: ComplaintStatus;
  respondedAt: string | null;
}

/** POST /api/admin/complaints-book/:id/confirmation-email (and /confirm) */
export interface ComplaintConfirmationResendResult {
  confirmationEmail: "SENT" | "FAILED";
}

/**
 * Hours an e-mail with an unknown outcome may be retried with the same idempotency key. The provider keeps keys
 * 24 hours; 1 hour of margin. Past it nothing is resent automatically (also enforced by the database).
 */
export const COMPLAINT_EMAIL_IDEMPOTENCY_WINDOW_HOURS = 23;
