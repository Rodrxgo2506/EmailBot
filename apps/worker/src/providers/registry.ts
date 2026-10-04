import type { EmailProvider } from "@emailbot/types";
import { createGmailAdapter } from "./gmail/adapter.js";
import { createImapAdapter } from "./imap/adapter.js";
import { createMicrosoftAdapter } from "./microsoft/adapter.js";
import type { ProviderAdapter } from "./types.js";

export type ProviderRegistry = Record<EmailProvider, ProviderAdapter>;

export function createProviderRegistry(fetchImpl: typeof fetch = fetch): ProviderRegistry {
  return {
    GMAIL: createGmailAdapter(fetchImpl),
    MICROSOFT: createMicrosoftAdapter(fetchImpl),
    IMAP: createImapAdapter()
  };
}
