import { DEFAULT_JOB_OPTIONS } from "@emailbot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * F8-B: worker error reporting. @sentry/node is mocked: no event ever leaves
 * the test. A failing job is reported once, on its final attempt; events are
 * scrubbed like the API's.
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
  environment: string;
  release?: string;
  dataCollection: Record<string, unknown>;
  beforeSend(event: Record<string, unknown>): Record<string, unknown> | null;
  beforeBreadcrumb(breadcrumb: Record<string, unknown>): Record<string, unknown> | null;
};

async function load() {
  vi.resetModules();
  return import("../infrastructure/sentry.js");
}

const DSN = "https://public@o0.ingest.example/1";
const job = (attemptsMade: number, attempts: number | undefined, data: unknown = { type: "SYNC_ACCOUNT", emailAccountId: "acc-1" }) => ({
  queueName: "email-events",
  attemptsMade,
  opts: attempts === undefined ? {} : { attempts },
  data
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isFinalAttempt", () => {
  it.each([
    [0, 5, false],
    [3, 5, false],
    [4, 5, true],
    [5, 5, true],
    [0, undefined, true],
    [0, 1, true],
    [0, 0, true]
  ])("attemptsMade %i of %s attempts -> %s", async (attemptsMade, attempts, final) => {
    const { isFinalAttempt } = await load();
    expect(isFinalAttempt(job(attemptsMade, attempts))).toBe(final);
  });
});

describe("reportJobFailure", () => {
  it("a job retried 5 times (DEFAULT_JOB_OPTIONS) produces exactly one event, on the final attempt", async () => {
    const { initWorkerSentry, reportJobFailure } = await load();
    initWorkerSentry({ dsn: DSN, environment: "production" });
    const error = new Error("Gmail 500");
    for (let attemptsMade = 0; attemptsMade < DEFAULT_JOB_OPTIONS.attempts; attemptsMade++) {
      reportJobFailure(error, job(attemptsMade, DEFAULT_JOB_OPTIONS.attempts), { queue: "email-events", type: "SYNC_ACCOUNT" });
    }
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("tags only the queue and the job type (no ids or payload)", async () => {
    const { initWorkerSentry, reportJobFailure } = await load();
    initWorkerSentry({ dsn: DSN, environment: "production" });
    reportJobFailure(new Error("x"), job(0, 1), { queue: "email-events", type: "SYNC_ACCOUNT" });
    expect(sentry.scope.setTag.mock.calls).toEqual([
      ["queue", "email-events"],
      ["jobType", "SYNC_ACCOUNT"]
    ]);
  });

  it("does nothing without a DSN", async () => {
    const { initWorkerSentry, reportJobFailure, captureWorkerException } = await load();
    initWorkerSentry({ dsn: null, environment: "development" });
    reportJobFailure(new Error("x"), job(4, 5), { queue: "email-events" });
    captureWorkerException(new Error("init"), { phase: "initialization" });
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("jobType", () => {
  it("reads the type of email-events jobs only", async () => {
    const { jobType } = await load();
    expect(jobType({ type: "POLL_ACCOUNTS" })).toBe("POLL_ACCOUNTS");
    expect(jobType({ emailAccountId: "a", providerMessageId: "m" })).toBeUndefined();
    expect(jobType(null)).toBeUndefined();
  });
});

describe("initWorkerSentry", () => {
  it("uses the environment and release, and the shared scrubbing", async () => {
    const { initWorkerSentry } = await load();
    initWorkerSentry({ dsn: DSN, environment: "production", release: "df338a4a9df8e65137621928668086e8903c0659" });
    const options = sentry.init.mock.calls[0]?.[0] as InitOptions;
    expect(options.environment).toBe("production");
    expect(options.release).toBe("df338a4a9df8e65137621928668086e8903c0659");
    expect(options.dataCollection).toMatchObject({ httpHeaders: false, httpBodies: [], stackFrameVariables: false });

    const event = options.beforeSend({
      request: { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:a@b.co", headers: { authorization: "Bearer ya29.secret" } },
      exception: { values: [{ value: "token refresh failed for box@empresa.test: access_token=ya29.a0secret" }] }
    });
    const serialized = JSON.stringify(event);
    for (const leak of ["@empresa.test", "a@b.co", "ya29", "authorization", "q=from"]) expect(serialized).not.toContain(leak);
    expect(options.beforeBreadcrumb({ type: "http", category: "http" })).toBeNull();
  });

  it("without a release (local) the option is omitted", async () => {
    const { initWorkerSentry } = await load();
    initWorkerSentry({ dsn: DSN, environment: "development", release: undefined });
    const options = sentry.init.mock.calls[0]?.[0] as InitOptions;
    expect("release" in options).toBe(false);
  });
});
