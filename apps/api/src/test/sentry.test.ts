import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * F8-B: API error reporting. @sentry/node is mocked: no event ever leaves
 * the test. Checks what initSentry configures and what an event looks like
 * after the configured beforeSend / beforeBreadcrumb.
 */

const sentry = vi.hoisted(() => {
  const scope = { setTag: vi.fn() };
  return {
    scope,
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
    withScope: vi.fn((callback: (s: typeof scope) => void) => callback(scope))
  };
});
vi.mock("@sentry/node", () => sentry);

type InitOptions = {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
  dataCollection: Record<string, unknown>;
  beforeSend(event: Record<string, unknown>): Record<string, unknown> | null;
  beforeBreadcrumb(breadcrumb: Record<string, unknown>): Record<string, unknown> | null;
};

async function loadSentry() {
  vi.resetModules();
  return import("../lib/sentry.js");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initSentry", () => {
  it("does nothing without a DSN (local development, tests)", async () => {
    const { initSentry, captureException } = await loadSentry();
    initSentry(null, "development");
    captureException(new Error("boom"));
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("uses the configured environment and the deployed commit as release", async () => {
    const { initSentry } = await loadSentry();
    initSentry("https://public@o0.ingest.example/1", "production", "df338a4a9df8e65137621928668086e8903c0659");
    const options = sentry.init.mock.calls[0]?.[0] as InitOptions;
    expect(options.environment).toBe("production");
    expect(options.release).toBe("df338a4a9df8e65137621928668086e8903c0659");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.dataCollection).toMatchObject({ httpHeaders: false, cookies: false, httpBodies: [], urlQueryParams: false, userInfo: false });
  });

  it("works without a release (no RENDER_GIT_COMMIT locally)", async () => {
    const { initSentry } = await loadSentry();
    initSentry("https://public@o0.ingest.example/1", "development");
    const options = sentry.init.mock.calls[0]?.[0] as InitOptions;
    expect(options.environment).toBe("development");
    expect("release" in options).toBe(false);
  });

  it("beforeSend strips headers, cookies, body, query, user data, addresses and tokens", async () => {
    const { initSentry } = await loadSentry();
    initSentry("https://public@o0.ingest.example/1", "production");
    const options = sentry.init.mock.calls[0]?.[0] as InitOptions;
    const event = options.beforeSend({
      request: {
        url: "https://api.emailbot.app/api/emails?search=cliente@empresa.test",
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", cookie: "a=b" },
        cookies: { a: "b" },
        data: { password: "hunter22" },
        query_string: "search=cliente@empresa.test"
      },
      user: { email: "owner@empresa.test", ip_address: "203.0.113.7" },
      exception: { values: [{ value: "refresh failed: refresh_token=1//0gSecretRefreshToken-abcdefgh for owner@empresa.test" }] }
    });
    const serialized = JSON.stringify(event);
    expect(event?.request).toEqual({ url: "https://api.emailbot.app/api/emails" });
    for (const leak of ["@empresa.test", "authorization", "cookie", "hunter22", "search=", "1//0g", "eyJ", "203.0.113.7"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("beforeBreadcrumb drops HTTP / fetch breadcrumbs (PostgREST filters, Gmail and Graph ids in URLs)", async () => {
    const { initSentry } = await loadSentry();
    initSentry("https://public@o0.ingest.example/1", "production");
    const options = sentry.init.mock.calls[0]?.[0] as InitOptions;
    expect(options.beforeBreadcrumb({ type: "http", category: "http", data: { url: "https://x.supabase.co/rest/v1/emails?sender_email=eq.a@b.co" } })).toBeNull();
    expect(options.beforeBreadcrumb({ category: "fetch", data: { url: "https://graph.microsoft.com/v1.0/me/messages/AAMk" } })).toBeNull();
  });

  it("captureException tags the request id and error code only", async () => {
    const { initSentry, captureException } = await loadSentry();
    initSentry("https://public@o0.ingest.example/1", "production");
    const error = new Error("boom");
    captureException(error, { requestId: "req-1", code: "DATABASE_ERROR", ignored: undefined });
    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(sentry.scope.setTag.mock.calls).toEqual([
      ["requestId", "req-1"],
      ["code", "DATABASE_ERROR"]
    ]);
  });
});
