import { ProviderNotImplementedError, type ProviderAdapter } from "../types.js";

/*
 * IMAP adapter — SCAFFOLD ONLY.
 *
 * The API already stores IMAP accounts (host/port/username in
 * provider_metadata, password encrypted in access_token_encrypted) and keeps
 * them PAUSED with last_error_code = IMAP_SYNC_NOT_IMPLEMENTED.
 *
 * Planned implementation:
 *   - connect with an IMAP client (e.g. imapflow) using TLS,
 *   - cursor = "<UIDVALIDITY>:<last UID>" of INBOX,
 *   - listNewMessageIds = UID SEARCH for UIDs greater than the cursor,
 *   - fetchMessage = FETCH BODY[] + MIME parsing (e.g. mailparser) -> NormalizedEmail,
 *   - IDLE or polling for change detection.
 *
 * Every method throws ProviderNotImplementedError so no caller can mistake
 * this for a working integration.
 */
export function createImapAdapter(): ProviderAdapter {
  return {
    provider: "IMAP",
    listNewMessageIds() {
      return Promise.reject(new ProviderNotImplementedError("IMAP", "synchronization"));
    },
    fetchMessage() {
      return Promise.reject(new ProviderNotImplementedError("IMAP", "message fetch"));
    },
    downloadAttachment() {
      return Promise.reject(new ProviderNotImplementedError("IMAP", "attachment download"));
    }
  };
}
