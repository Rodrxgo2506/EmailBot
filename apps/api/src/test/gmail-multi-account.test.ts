import { createOAuthState } from "@emailbot/shared";
import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderConfig } from "../config/env.js";
import type { OAuthAccountConnection, OAuthAccountUpsert } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";

/*
 * Several Gmail mailboxes in ONE organization (sales@ / support@), the OAuth
 * callback's use of connectOAuthEmailAccount (P0/P1) and the refusal of a new
 * mailbox without a refresh token. The database side (limit under lock, ERROR
 * reconnection keeping the cursor, one row per address) is covered against the
 * real SQL in packages/database/test/email-account-connect.test.ts.
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const google: OAuthProviderConfig = { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:3000/api/oauth/gmail/callback" };
const SALES_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SUPPORT_ID = "aaaaaaaa-0000-4000-8000-000000000002";

const mailbox = (overrides: Partial<EmailAccount>): EmailAccount => ({
  id: SALES_ID,
  organizationId: ORG_A,
  provider: "GMAIL",
  status: "ACTIVE",
  emailAddress: "sales@example.com",
  displayName: null,
  lastSyncedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

/** What Google returns for the mailbox the user picks in the account chooser. */
interface GoogleGrant {
  emailAddress: string;
  historyId: string;
  accessToken: string;
  refreshToken: string | null;
}

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup() {
  let grant: GoogleGrant = { emailAddress: "sales@example.com", historyId: "1", accessToken: "at", refreshToken: "rt" };
  const fetch = vi.fn(async (url: string) =>
    url.includes("/token")
      ? new Response(
          JSON.stringify({
            access_token: grant.accessToken,
            ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
            expires_in: 3600,
            token_type: "Bearer"
          }),
          { status: 200 }
        )
      : new Response(JSON.stringify({ emailAddress: grant.emailAddress, historyId: grant.historyId }), { status: 200 })
  );
  ctx = await createTestApp({ users: [owner], fetch: fetch as unknown as typeof globalThis.fetch, config: { google } });
  const context = ctx;
  context.privileged.getMemberRole.mockResolvedValue("OWNER");

  /** Runs one OAuth callback for `next` (a fresh state each time, as a new "Conectar Gmail" click). */
  const connect = async (next: GoogleGrant) => {
    grant = next;
    const state = createOAuthState({ userId: owner.id, organizationId: ORG_A, provider: "GMAIL" }, context.deps.config.oauthStateSecret);
    const response = await context.app.inject({ method: "GET", url: `/api/oauth/gmail/callback?code=c&state=${encodeURIComponent(state)}` });
    return response.headers.location as string;
  };
  const stored = (call: number) => context.privileged.connectOAuthEmailAccount.mock.calls[call]?.[0] as OAuthAccountUpsert;
  return { ...context, connect, stored };
}

const created = (account: EmailAccount): OAuthAccountConnection => ({ outcome: "CREATED", account, created: true, previousStatus: null });

describe("two Gmail mailboxes in the same organization", () => {
  it("sales@ and support@: two connections, two ids, each with its own tokens, cursor and watch", async () => {
    const { connect, privileged, queue, deps, stored } = await setup();
    privileged.connectOAuthEmailAccount
      .mockResolvedValueOnce(created(mailbox({ id: SALES_ID, emailAddress: "sales@example.com" })))
      .mockResolvedValueOnce(created(mailbox({ id: SUPPORT_ID, emailAddress: "support@example.com" })));

    const sales = await connect({ emailAddress: "sales@example.com", historyId: "100", accessToken: "at-sales", refreshToken: "rt-sales" });
    const support = await connect({ emailAddress: "support@example.com", historyId: "900", accessToken: "at-support", refreshToken: "rt-support" });

    expect(sales).toContain(`oauth=connected&provider=gmail&accountId=${SALES_ID}`);
    expect(support).toContain(`oauth=connected&provider=gmail&accountId=${SUPPORT_ID}`);
    expect(privileged.connectOAuthEmailAccount).toHaveBeenCalledTimes(2);

    expect(stored(0)).toMatchObject({ organizationId: ORG_A, provider: "GMAIL", emailAddress: "sales@example.com", syncCursor: "100" });
    expect(stored(1)).toMatchObject({ organizationId: ORG_A, provider: "GMAIL", emailAddress: "support@example.com", syncCursor: "900" });
    expect(deps.secretBox.decrypt(stored(0).accessTokenEncrypted)).toBe("at-sales");
    expect(deps.secretBox.decrypt(stored(0).refreshTokenEncrypted as string)).toBe("rt-sales");
    expect(deps.secretBox.decrypt(stored(1).accessTokenEncrypted)).toBe("at-support");
    expect(deps.secretBox.decrypt(stored(1).refreshTokenEncrypted as string)).toBe("rt-support");

    expect(queue.enqueueEmailEvent.mock.calls).toEqual([
      [{ type: "WATCH_ACCOUNT", emailAccountId: SALES_ID, organizationId: ORG_A }, { jobId: `watch-${SALES_ID}` }],
      [{ type: "WATCH_ACCOUNT", emailAccountId: SUPPORT_ID, organizationId: ORG_A }, { jobId: `watch-${SUPPORT_ID}` }]
    ]);
  });

  it("disconnecting sales@ only disconnects sales@ (support@ is never touched)", async () => {
    const { app, repos, privileged } = await setup();
    repos.emailAccounts.get.mockResolvedValue(mailbox({ id: SALES_ID }));
    privileged.disconnectEmailAccount.mockResolvedValue(mailbox({ id: SALES_ID, status: "DISCONNECTED" }));

    const response = await app.inject({ method: "POST", url: `/api/email-accounts/${SALES_ID}/disconnect`, headers: authHeaders(owner, ORG_A) });
    expect(response.statusCode).toBe(200);
    expect(privileged.disconnectEmailAccount).toHaveBeenCalledTimes(1);
    expect(privileged.disconnectEmailAccount).toHaveBeenCalledWith(ORG_A, SALES_ID);
  });
});

describe("a new mailbox without a refresh token (MISSING_REFRESH_TOKEN)", () => {
  it("is refused with its own reason, nothing is audited nor watched, and a retry with offline access connects", async () => {
    const { connect, privileged, queue, stored } = await setup();
    privileged.connectOAuthEmailAccount
      .mockResolvedValueOnce({ outcome: "MISSING_REFRESH_TOKEN" })
      .mockResolvedValueOnce(created(mailbox({ id: SALES_ID })));

    const first = await connect({ emailAddress: "sales@example.com", historyId: "100", accessToken: "at-1", refreshToken: null });
    expect(first).toContain("oauth=error&reason=missing_refresh_token");
    expect(stored(0).refreshTokenEncrypted).toBeNull();
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();

    const retry = await connect({ emailAddress: "sales@example.com", historyId: "101", accessToken: "at-2", refreshToken: "rt-2" });
    expect(retry).toContain("oauth=connected");
    expect(stored(1).refreshTokenEncrypted).not.toBeNull();
    expect(queue.enqueueEmailEvent).toHaveBeenCalledTimes(1);
  });

  it("re-authorizing a mailbox that keeps its stored refresh token still connects (the database keeps it)", async () => {
    const { connect, privileged, stored } = await setup();
    privileged.connectOAuthEmailAccount.mockResolvedValueOnce({
      outcome: "RECONNECTED",
      account: mailbox({ id: SALES_ID }),
      created: false,
      previousStatus: "ERROR"
    });

    expect(await connect({ emailAddress: "sales@example.com", historyId: "100", accessToken: "at-new", refreshToken: null })).toContain(
      "oauth=connected"
    );
    expect(stored(0).refreshTokenEncrypted).toBeNull();
  });
});

describe("mailbox addresses are case-insensitive", () => {
  it.each(["usuario@example.com", "USUARIO@EXAMPLE.COM", "Usuario@Example.com"])("Google reports %s: stored as usuario@example.com", async (reported) => {
    const { connect, privileged, stored } = await setup();
    privileged.connectOAuthEmailAccount.mockResolvedValueOnce(created(mailbox({ emailAddress: "usuario@example.com" })));
    expect(await connect({ emailAddress: reported, historyId: "7", accessToken: "at", refreshToken: "rt" })).toContain("oauth=connected");
    expect(stored(0)).toMatchObject({ emailAddress: "usuario@example.com", providerAccountId: "usuario@example.com" });
  });
});
