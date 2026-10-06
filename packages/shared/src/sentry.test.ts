import { describe, expect, it } from "vitest";
import { filterSentryBreadcrumb, scrubSentryEvent, scrubSentryText, sentryRelease, type ScrubbableEvent } from "./sentry.js";

/*
 * F8-B: what leaves for Sentry. A simulated event as the SDK would build it
 * from a failed request / job, with every kind of sensitive data in it.
 */

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
const GOOGLE_ACCESS = "ya29.a0AfH6SMBx-very-secret-token";
const GOOGLE_REFRESH = "1//0gLongRefreshTokenValue-abcdefghij";

function simulatedEvent(): ScrubbableEvent {
  return {
    message: `sync failed for cliente@empresa.test with ${GOOGLE_ACCESS}`,
    request: {
      url: "https://api.emailbot.app/api/oauth/gmail/callback?code=4/0AbCdEf&state=xyz",
      headers: { authorization: `Bearer ${JWT}`, cookie: "sb-access-token=abc" },
      cookies: { "sb-access-token": "abc" },
      data: '{"password":"hunter22","email":"cliente@empresa.test"}',
      query_string: "code=4/0AbCdEf&state=xyz",
      env: { REMOTE_ADDR: "203.0.113.7" }
    },
    user: { id: "user-1", email: "owner@empresa.test", ip_address: "203.0.113.7" },
    extra: { body: { refresh_token: GOOGLE_REFRESH } },
    exception: {
      values: [
        {
          value:
            'GET https://x.supabase.co/rest/v1/emails?sender_email=eq.cliente@empresa.test&select=id failed: duplicate key (cliente@empresa.test)'
        },
        { value: `Google token refresh failed: refresh_token=${GOOGLE_REFRESH} access_token=${GOOGLE_ACCESS} Authorization: Bearer ${JWT}` },
        { value: "GET https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=987654 returned 404" },
        { value: "Graph GET https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2THVSAAA= failed" }
      ]
    },
    breadcrumbs: [
      { type: "http", category: "http", data: { url: "https://x.supabase.co/rest/v1/email_accounts?email_address=eq.box@empresa.test" } },
      { category: "fetch", data: { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f" } },
      { category: "console", message: "token=abc cliente@empresa.test" },
      { category: "app", message: "processing for cliente@empresa.test", data: { emailAddress: "cliente@empresa.test" } }
    ]
  };
}

describe("scrubSentryEvent", () => {
  const scrubbed = scrubSentryEvent(simulatedEvent());
  const serialized = JSON.stringify(scrubbed);

  it("removes request headers, cookies, body, query string and environment; the URL keeps only its path", () => {
    expect(scrubbed.request).toEqual({ url: "https://api.emailbot.app/api/oauth/gmail/callback" });
  });

  it("removes user and extra data", () => {
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
  });

  it("contains no email address, OAuth token, JWT, password, query string, PostgREST filter, Gmail or Graph id", () => {
    for (const leak of [
      "@empresa.test",
      GOOGLE_ACCESS,
      GOOGLE_REFRESH,
      JWT,
      "hunter22",
      "code=4/",
      "sb-access-token",
      "eq.",
      "startHistoryId",
      "987654",
      "AAMkAGI2THVSAAA",
      "18c2f",
      "203.0.113.7"
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("keeps what is useful to debug: error text, hosts and the app breadcrumb", () => {
    expect(scrubbed.exception?.values?.[0]?.value).toBe("GET https://x.supabase.co/[redacted] failed: duplicate key ([email])");
    expect(scrubbed.exception?.values?.[1]?.value).toBe(
      "Google token refresh failed: refresh_token=[redacted] access_token=[redacted] Authorization: Bearer [token]"
    );
    expect(scrubbed.exception?.values?.[2]?.value).toBe("GET https://gmail.googleapis.com/[redacted] returned 404");
    expect(scrubbed.message).toBe("sync failed for [email] with [token]");
    expect(scrubbed.breadcrumbs).toEqual([{ category: "app", message: "processing for [email]" }]);
  });
});

describe("filterSentryBreadcrumb", () => {
  it.each([
    [{ type: "http", category: "http" }],
    [{ category: "fetch" }],
    [{ category: "xhr" }],
    [{ category: "console", message: "x" }],
    [{ category: "navigation" }]
  ])("drops network / console breadcrumbs (%o)", (breadcrumb) => {
    expect(filterSentryBreadcrumb(breadcrumb)).toBeNull();
  });

  it("keeps other breadcrumbs without data and with scrubbed text", () => {
    expect(filterSentryBreadcrumb({ category: "queue", message: "job for a@b.co", data: { id: "1" } })).toEqual({
      category: "queue",
      message: "job for [email]"
    });
  });
});

describe("scrubSentryText", () => {
  it("leaves text without sensitive data untouched", () => {
    expect(scrubSentryText("Redis connection lost (ECONNRESET)")).toBe("Redis connection lost (ECONNRESET)");
  });
});

describe("sentryRelease", () => {
  it("is the commit Render deploys", () => {
    expect(sentryRelease({ RENDER_GIT_COMMIT: "df338a4a9df8e65137621928668086e8903c0659" })).toBe("df338a4a9df8e65137621928668086e8903c0659");
  });

  it.each([[{}], [{ RENDER_GIT_COMMIT: "" }], [{ RENDER_GIT_COMMIT: "  " }], [{ RENDER_GIT_COMMIT: "main; rm -rf" }]])(
    "is undefined locally or for an unexpected value (%o)",
    (env) => {
      expect(sentryRelease(env)).toBeUndefined();
    }
  );
});
