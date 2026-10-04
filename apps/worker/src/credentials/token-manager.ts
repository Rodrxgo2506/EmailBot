import { OAuthError, refreshAccessToken, type OAuthClientConfig, type SecretBox } from "@emailbot/shared";
import type { AccountStore } from "../pipeline/ports.js";
import { ProviderAuthError, type ProviderContext, type WorkerAccount } from "../providers/types.js";

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface TokenManagerDeps {
  secretBox: SecretBox;
  accounts: AccountStore;
  oauth: { GMAIL: OAuthClientConfig | null; MICROSOFT: OAuthClientConfig | null };
  fetch: typeof fetch;
  now?: () => number;
}

/**
 * Builds the ProviderContext for an account: decrypts the access token and
 * refreshes it (persisting the new encrypted tokens) when it is about to
 * expire. Plaintext tokens only live in memory for the duration of a job.
 */
export function createProviderContext(account: WorkerAccount, deps: TokenManagerDeps): ProviderContext {
  const now = deps.now ?? Date.now;
  let cached: { token: string; expiresAt: number | null } | null = null;

  async function refresh(): Promise<string> {
    if (account.provider === "IMAP") {
      throw new ProviderAuthError("IMAP accounts do not use OAuth tokens", "NOT_OAUTH");
    }
    const config = deps.oauth[account.provider];
    if (!config) throw new ProviderAuthError(`${account.provider} OAuth is not configured`, "PROVIDER_NOT_CONFIGURED");
    if (!account.refreshTokenEncrypted) throw new ProviderAuthError("No refresh token stored", "MISSING_REFRESH_TOKEN");

    try {
      const tokens = await refreshAccessToken(
        account.provider,
        config,
        deps.secretBox.decrypt(account.refreshTokenEncrypted),
        deps.fetch
      );

      const accessTokenEncrypted = deps.secretBox.encrypt(tokens.accessToken);
      // Microsoft rotates refresh tokens; Google usually keeps the same one.
      const refreshTokenEncrypted = tokens.refreshToken ? deps.secretBox.encrypt(tokens.refreshToken) : null;
      const tokenExpiresAt = tokens.expiresAt?.toISOString() ?? null;

      await deps.accounts.saveTokens(account.id, { accessTokenEncrypted, refreshTokenEncrypted, tokenExpiresAt });

      account.accessTokenEncrypted = accessTokenEncrypted;
      if (refreshTokenEncrypted) account.refreshTokenEncrypted = refreshTokenEncrypted;
      account.tokenExpiresAt = tokenExpiresAt;

      cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt?.getTime() ?? null };
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof OAuthError && error.requiresReconnect) {
        throw new ProviderAuthError("The refresh token was revoked or expired", "AUTH_REVOKED");
      }
      throw error;
    }
  }

  return {
    account,
    async getAccessToken(options) {
      if (!options?.forceRefresh) {
        if (cached && (cached.expiresAt === null || cached.expiresAt - now() > REFRESH_MARGIN_MS)) {
          return cached.token;
        }

        const expiresAt = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : null;
        const stillValid = expiresAt === null || expiresAt - now() > REFRESH_MARGIN_MS;
        if (account.accessTokenEncrypted && stillValid) {
          const token = deps.secretBox.decrypt(account.accessTokenEncrypted);
          cached = { token, expiresAt };
          return token;
        }
      }
      return refresh();
    }
  };
}
