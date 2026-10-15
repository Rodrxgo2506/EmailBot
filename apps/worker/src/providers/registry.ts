import type { EmailProvider } from "@emailbot/types";
import { createGmailAdapter } from "./gmail/adapter.js";
import { createImapAdapter } from "./imap/adapter.js";
import { createMicrosoftAdapter } from "./microsoft/adapter.js";
import type { ProviderAdapter } from "./types.js";

export type ProviderRegistry = Record<EmailProvider, ProviderAdapter>;

/**
 * `imap`: the real IMAP adapter, passed only when IMAP synchronization is
 * enabled (index.ts). Otherwise IMAP keeps the scaffold that refuses everything.
 */
/** `options.attachmentFetch` (F5.5): Gmail / Microsoft attachment downloads; every other call uses `fetchImpl`. */
export function createProviderRegistry(fetchImpl: typeof fetch = fetch, options: { imap?: ProviderAdapter; attachmentFetch?: typeof fetch } = {}): ProviderRegistry {
  return {
    GMAIL: createGmailAdapter(fetchImpl, options.attachmentFetch),
    MICROSOFT: createMicrosoftAdapter(fetchImpl, options.attachmentFetch),
    IMAP: options.imap ?? createImapAdapter()
  };
}
