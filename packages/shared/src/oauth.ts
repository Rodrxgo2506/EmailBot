import { z } from "zod";

/*
 * Minimal OAuth 2.0 authorization-code clients for Google (Gmail) and
 * Microsoft identity platform (Graph). Implemented with fetch against the
 * documented endpoints to avoid heavy SDKs. Shared by the API (code exchange)
 * and the worker (token refresh).
 *
 * Status: implemented per provider documentation; requires real OAuth client
 * credentials to be exercised end-to-end.
 */

export type OAuthProvider = "GMAIL" | "MICROSOFT";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Microsoft only: "common", "organizations", "consumers" or a tenant id. */
  tenant?: string | undefined;
}

export interface OAuthTokens {
  accessToken: string;
  /** Google only returns it on first consent; Microsoft rotates it. */
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Provider error code such as "invalid_grant" (never a token). */
    readonly providerError: string | null
  ) {
    super(message);
    this.name = "OAuthError";
  }

  /** The refresh token was revoked/expired: the user must reconnect. */
  get requiresReconnect(): boolean {
    return this.providerError === "invalid_grant";
  }
}

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export const MICROSOFT_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/User.Read"
];

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function microsoftAuthority(config: OAuthClientConfig): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenant ?? "common")}/oauth2/v2.0`;
}

export function buildAuthorizationUrl(provider: OAuthProvider, config: OAuthClientConfig, state: string): string {
  if (provider === "GMAIL") {
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPES.join(" "),
      access_type: "offline",
      // Explicit consent (a refresh token every time) AND the account chooser: with several Google sessions open,
      // the user picks which mailbox to connect (several Gmail accounts per organization).
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state
    }).toString();
    return url.toString();
  }

  const url = new URL(`${microsoftAuthority(config)}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    prompt: "select_account",
    state
  }).toString();
  return url.toString();
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().optional(),
  scope: z.string().optional()
});

const tokenErrorSchema = z.object({ error: z.string() }).partial();

async function requestTokens(
  provider: OAuthProvider,
  config: OAuthClientConfig,
  params: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<OAuthTokens> {
  const tokenUrl = provider === "GMAIL" ? GOOGLE_TOKEN_URL : `${microsoftAuthority(config)}/token`;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...params,
    ...(provider === "MICROSOFT" ? { scope: MICROSOFT_SCOPES.join(" ") } : {})
  });

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });

  const json: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const providerError = tokenErrorSchema.safeParse(json).data?.error ?? null;
    throw new OAuthError(
      `${provider} token endpoint returned HTTP ${response.status}${providerError ? ` (${providerError})` : ""}`,
      response.status,
      providerError
    );
  }

  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OAuthError(`${provider} token endpoint returned an unexpected payload`, response.status, null);
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: parsed.data.expires_in ? new Date(Date.now() + parsed.data.expires_in * 1000) : null,
    scope: parsed.data.scope ?? null
  };
}

export function exchangeAuthorizationCode(
  provider: OAuthProvider,
  config: OAuthClientConfig,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokens> {
  return requestTokens(
    provider,
    config,
    { grant_type: "authorization_code", code, redirect_uri: config.redirectUri },
    fetchImpl
  );
}

export function refreshAccessToken(
  provider: OAuthProvider,
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokens> {
  return requestTokens(provider, config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
