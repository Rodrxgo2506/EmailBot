import { randomBytes } from "node:crypto";
import { fetchWithTimeout, HttpTimeoutError, SecretBox } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { createProviderContext } from "../credentials/token-manager.js";
import { handleAccountFailure } from "../pipeline/failures.js";
import { createGmailAdapter } from "../providers/gmail/adapter.js";
import { createImapAdapter } from "../providers/imap/adapter.js";
import { createMicrosoftAdapter } from "../providers/microsoft/adapter.js";
import { ProviderAuthError, ProviderNotImplementedError, ProviderTransientError } from "../providers/types.js";
import { makeAccount, makeAccountStore, silentLogger } from "./fakes.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const staticContext = (account = makeAccount()) => ({ account, getAccessToken: vi.fn(async () => "access") });

describe("token manager", () => {
  const box = new SecretBox(randomBytes(32));
  const oauth = {
    GMAIL: { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" },
    MICROSOFT: null
  };

  it("uses the stored token while it is valid", async () => {
    const account = makeAccount({
      accessTokenEncrypted: box.encrypt("stored"),
      refreshTokenEncrypted: box.encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString()
    });
    const fetchMock = vi.fn();
    const context = createProviderContext(account, {
      secretBox: box,
      accounts: makeAccountStore([account]),
      oauth,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(await context.getAccessToken()).toBe("stored");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes expiring tokens and persists them encrypted", async () => {
    const account = makeAccount({
      accessTokenEncrypted: box.encrypt("old"),
      refreshTokenEncrypted: box.encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 30_000).toISOString()
    });
    const accounts = makeAccountStore([account]);
    const fetchMock = vi.fn(async () => json({ access_token: "new-access", expires_in: 3600 }));
    const context = createProviderContext(account, { secretBox: box, accounts, oauth, fetch: fetchMock as unknown as typeof fetch });

    expect(await context.getAccessToken()).toBe("new-access");
    const saved = vi.mocked(accounts.saveTokens).mock.calls[0]?.[1] as { accessTokenEncrypted: string; refreshTokenEncrypted: string | null };
    expect(saved.accessTokenEncrypted).not.toContain("new-access");
    expect(box.decrypt(saved.accessTokenEncrypted)).toBe("new-access");
    expect(saved.refreshTokenEncrypted).toBeNull();
    // Cached afterwards.
    expect(await context.getAccessToken()).toBe("new-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps invalid_grant to ProviderAuthError (reconnect required)", async () => {
    const account = makeAccount({ refreshTokenEncrypted: box.encrypt("refresh"), tokenExpiresAt: new Date(0).toISOString() });
    const fetchMock = vi.fn(async () => json({ error: "invalid_grant" }, 400));
    const context = createProviderContext(account, {
      secretBox: box,
      accounts: makeAccountStore([account]),
      oauth,
      fetch: fetchMock as unknown as typeof fetch
    });

    await expect(context.getAccessToken()).rejects.toMatchObject({ name: "ProviderAuthError", code: "AUTH_REVOKED" });
  });
});

describe("Gmail adapter", () => {
  it("initializes the cursor without importing history", async () => {
    const fetchMock = vi.fn(async () => json({ historyId: "555" }));
    const adapter = createGmailAdapter(fetchMock as unknown as typeof fetch);
    expect(await adapter.listNewMessageIds(staticContext(makeAccount({ syncCursor: null })))).toEqual({
      messageIds: [],
      nextCursor: "555"
    });
  });

  it("collects new message ids across history pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ history: [{ messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] }], historyId: "150", nextPageToken: "p2" })
      )
      .mockResolvedValueOnce(json({ history: [{ messagesAdded: [{ message: { id: "b" } }, { message: { id: "c" } }] }], historyId: "160" }));
    const adapter = createGmailAdapter(fetchMock as unknown as typeof fetch);

    const changes = await adapter.listNewMessageIds(staticContext());
    expect(changes).toEqual({ messageIds: ["a", "b", "c"], nextCursor: "160" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("startHistoryId=100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("pageToken=p2");
  });

  it("reports a history gap when the cursor expired (404) instead of jumping to now (phase 5.6)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ historyId: "999" }));
    const adapter = createGmailAdapter(fetchMock as unknown as typeof fetch);
    const changes = await adapter.listNewMessageIds(staticContext());
    // The stored cursor is kept: the caller recovers (bounded resync) and only then moves it.
    expect(changes).toEqual({ messageIds: [], nextCursor: makeAccount().syncCursor, historyGap: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on 401 and fails with ProviderAuthError on a second 401", async () => {
    const fetchMock = vi.fn(async () => json({}, 401));
    const context = staticContext();
    const adapter = createGmailAdapter(fetchMock as unknown as typeof fetch);

    await expect(adapter.fetchMessage(context, "m")).rejects.toBeInstanceOf(ProviderAuthError);
    expect(context.getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats 429/5xx as transient", async () => {
    const adapter = createGmailAdapter(vi.fn(async () => json({}, 503)) as unknown as typeof fetch);
    await expect(adapter.fetchMessage(staticContext(), "m")).rejects.toBeInstanceOf(ProviderTransientError);
  });
});

describe("Microsoft adapter", () => {
  it("starts with a receivedDateTime filter and stores the deltaLink", async () => {
    const deltaLink = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc";
    const fetchMock = vi.fn(async (_url: string) =>
      json({ value: [{ id: "m1" }, { id: "m2", "@removed": { reason: "deleted" } }], "@odata.deltaLink": deltaLink })
    );
    const adapter = createMicrosoftAdapter(fetchMock as unknown as typeof fetch);

    const changes = await adapter.listNewMessageIds(
      staticContext(makeAccount({ provider: "MICROSOFT", syncCursor: "since:2026-10-02T00:00:00.000Z" }))
    );
    expect(changes).toEqual({ messageIds: ["m1"], nextCursor: deltaLink });
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-10-02T00:00:00.000Z");
  });

  it("refuses to follow cursors that do not point to Microsoft Graph", async () => {
    const fetchMock = vi.fn();
    const adapter = createMicrosoftAdapter(fetchMock as unknown as typeof fetch);
    await expect(
      adapter.listNewMessageIds(staticContext(makeAccount({ provider: "MICROSOFT", syncCursor: "https://evil.example/steal" })))
    ).rejects.toThrow(/non-Graph/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("IMAP adapter", () => {
  it("is an explicit scaffold", async () => {
    const adapter = createImapAdapter();
    await expect(adapter.listNewMessageIds(staticContext(makeAccount({ provider: "IMAP" })))).rejects.toBeInstanceOf(
      ProviderNotImplementedError
    );
  });
});

describe("outbound HTTP timeouts", () => {
  /** A provider that accepts the request and never answers (until aborted). */
  const hanging = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })
  ) as unknown as typeof fetch;

  it("a fast provider answer passes through", async () => {
    const fetchImpl = fetchWithTimeout(vi.fn(async () => json({ historyId: "7" })) as unknown as typeof fetch, 200);
    const adapter = createGmailAdapter(fetchImpl);
    const changes = await adapter.listNewMessageIds(staticContext(makeAccount({ syncCursor: null })));
    expect(changes.nextCursor).toBe("7");
  });

  it("a hanging provider becomes a retryable ProviderTransientError after the timeout", async () => {
    const adapter = createGmailAdapter(fetchWithTimeout(hanging, 50));
    const started = Date.now();
    const error = await adapter.fetchMessage(staticContext(), "m1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderTransientError);
    expect((error as Error).message).toMatch(/Timed out calling gmail\.googleapis\.com/);
    expect(Date.now() - started).toBeLessThan(2000);
    // Retryable: the failure handler rethrows it (BullMQ backoff), it is not a NonRetryableError.
    const accounts = makeAccountStore([makeAccount()]);
    await expect(
      handleAccountFailure(error, { id: "account-1", organizationId: "org" }, { accounts, realtime: { publish: vi.fn() }, logger: silentLogger })
    ).rejects.toBe(error);
    expect(accounts.markError).not.toHaveBeenCalled();
  });

  it("a hanging OAuth token endpoint does not mark the account for reconnection (retryable)", async () => {
    const box = new SecretBox(randomBytes(32));
    const account = makeAccount({ accessTokenEncrypted: null, refreshTokenEncrypted: box.encrypt("refresh"), tokenExpiresAt: null });
    const context = createProviderContext(account, {
      secretBox: box,
      accounts: makeAccountStore([account]),
      oauth: { GMAIL: { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" }, MICROSOFT: null },
      fetch: fetchWithTimeout(hanging, 50)
    });
    const error = await context.getAccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(error).not.toBeInstanceOf(ProviderAuthError);
  });

  it("a revoked token is still not retried", async () => {
    const fetchImpl = fetchWithTimeout(vi.fn(async () => json({}, 401)) as unknown as typeof fetch, 200);
    const context = { account: makeAccount(), getAccessToken: vi.fn(async () => "access") };
    await expect(createGmailAdapter(fetchImpl).fetchMessage(context, "m1")).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
