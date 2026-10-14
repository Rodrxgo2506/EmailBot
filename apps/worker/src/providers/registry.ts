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
export function createProviderRegistry(fetchImpl: typeof fetch = fetch, options: { imap?: ProviderAdapter } = {}): ProviderRegistry {
  return {
    GMAIL: createGmailAdapter(fetchImpl),
    MICROSOFT: createMicrosoftAdapter(fetchImpl),
    IMAP: options.imap ?? createImapAdapter()
  };
}
