import { IMAP_PORT_BY_SECURITY, IMAP_SECURITY_MODES, type ImapSecurity } from "@emailbot/types";
import type { ImapAccountInput } from "./api";

/** What the IMAP dialog collects (the address is fixed when reconnecting). */
export interface ImapDialogValues {
  emailAddress: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

/** The API's only transports: 993 -> TLS, 143 -> STARTTLS (IMAP_PORT_BY_SECURITY). Any other port: null, never plaintext. */
export function imapSecurityForPort(port: number): ImapSecurity | null {
  return IMAP_SECURITY_MODES.find((mode) => IMAP_PORT_BY_SECURITY[mode] === port) ?? null;
}

/**
 * Body of POST /api/email-accounts/imap: exactly the fields of the API's strict imapAccountCreateSchema
 * (@emailbot/validation), built field by field so nothing else is ever sent.
 */
export function imapAccountPayload(values: ImapDialogValues): ImapAccountInput {
  const security = imapSecurityForPort(values.port);
  if (!security) throw new Error("Usa el puerto 993 (TLS) o 143 (STARTTLS).");
  const displayName = values.displayName.trim();
  return {
    emailAddress: values.emailAddress,
    ...(displayName ? { displayName } : {}),
    host: values.host,
    port: values.port,
    security,
    username: values.username,
    password: values.password
  };
}
