import { randomBytes } from "node:crypto";
import { createOAuthState } from "@emailbot/shared";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/env.js";
import { revalidateSockets } from "../infrastructure/realtime.js";
import { isExpectedStorageLocation } from "../modules/emails/routes.js";
import type { Repositories } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

const EMAIL_ID = "55555555-5555-4555-8555-555555555555";
const ATTACHMENT_ID = "88888888-8888-4888-8888-888888888888";

describe("rate limiting", () => {
  it("limits the CPU-bound rule test endpoint per client", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app } = await createTestApp({ users: [viewer] });
    const payload = {
      rule: { name: "x", conditions: [{ field: "subject", operator: "contains", value: "a" }] },
      email: { sender: "a@b.com", subject: "a" }
    };

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const response = await app.inject({ method: "POST", url: "/api/rules/test", headers: authHeaders(viewer, ORG_A), payload });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) expect(response.json().error.code).toBe("RATE_LIMITED");
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("applies the global limit but never to health checks", async () => {
    const { app } = await createTestApp({ config: { rateLimitMax: 3 } });
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/api/me" })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
  });

  it("parses TRUST_PROXY for deployments behind a load balancer", () => {
    const base = {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      OAUTH_STATE_SECRET: "x".repeat(40)
    };
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).trustProxy).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    const hops = loadConfig({ ...base, TRUST_PROXY: "1" }).trustProxy as (address: string, hop: number) => boolean;
    expect([hops("x", 0), hops("x", 1)]).toEqual([true, false]);
  });
});

describe("rule test endpoint under expensive regexes", () => {
  it("returns quickly and flags the timeout instead of blocking the API", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app } = await createTestApp({ users: [viewer] });

    // Passes the static validator but is polynomial (n^6) on a long run of digits.
    const started = performance.now();
    const response = await app.inject({
      method: "POST",
      url: "/api/rules/test",
      headers: authHeaders(viewer, ORG_A),
      payload: {
        rule: { name: "x", conditions: [{ field: "body", operator: "regex", value: "\\d+\\d+\\d+\\d+\\d+\\d+x" }] },
        email: { sender: "a@b.com", body: "1".repeat(200) }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ matched: false, regexTimedOut: true });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("attachment downloads (service-role signing)", () => {
  const stored = {
    id: ATTACHMENT_ID,
    emailId: EMAIL_ID,
    organizationId: ORG_A,
    filename: "f.pdf",
    contentType: "application/pdf",
    fileSize: 1,
    isInline: false,
    storageUploaded: true,
    storageBucket: "email-attachments",
    storagePath: `${ORG_A}/${EMAIL_ID}/${ATTACHMENT_ID}/f.pdf`,
    createdAt: ""
  };

  it("only accepts the exact location written by the worker", () => {
    const check = (patch: { storageBucket?: string | null; storagePath?: string | null }) =>
      isExpectedStorageLocation({ ...stored, ...patch }, ORG_A, "email-attachments");

    expect(check({})).toBe(true);
    expect(check({ storageBucket: "other-bucket" })).toBe(false);
    expect(check({ storagePath: `${ORG_B}/${EMAIL_ID}/${ATTACHMENT_ID}/f.pdf` })).toBe(false);
    expect(check({ storagePath: `${ORG_A}/${EMAIL_ID}/${ATTACHMENT_ID}/../../x/f.pdf` })).toBe(false);
    expect(check({ storagePath: `${ORG_A}/${EMAIL_ID}/${ATTACHMENT_ID}/..` })).toBe(false);
    expect(check({ storagePath: `${ORG_A}/other-email/${ATTACHMENT_ID}/f.pdf` })).toBe(false);
    expect(check({ storagePath: null })).toBe(false);
  });

  it("refuses to sign a tampered path pointing to another tenant's object", async () => {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const { app, repos, privileged } = await createTestApp({ users: [operator] });
    repos.attachments.get.mockResolvedValue({ ...stored, storagePath: `${ORG_B}/victim-email/victim-att/secret.pdf` });

    const response = await app.inject({
      method: "GET",
      url: `/api/attachments/${ATTACHMENT_ID}/download`,
      headers: authHeaders(operator, ORG_A)
    });

    expect(response.statusCode).toBe(404);
    expect(privileged.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("signs legitimate attachments with the configured bucket", async () => {
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const { app, repos, privileged } = await createTestApp({ users: [viewer] });
    repos.attachments.get.mockResolvedValue(stored);
    privileged.createSignedDownloadUrl.mockResolvedValue("https://storage.example/signed");

    const response = await app.inject({
      method: "GET",
      url: `/api/attachments/${ATTACHMENT_ID}/download`,
      headers: authHeaders(viewer, ORG_A)
    });

    expect(response.json()).toEqual({ url: "https://storage.example/signed", expiresIn: 60 });
    expect(privileged.createSignedDownloadUrl).toHaveBeenCalledWith("email-attachments", stored.storagePath, 60, "f.pdf");
  });
});

describe("OAuth state", () => {
  it("is single-use: a replayed state is rejected before contacting the provider", async () => {
    const owner = makeUser({ [ORG_A]: "OWNER" });
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("oauth2.googleapis.com")
        ? new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ emailAddress: "me@gmail.com", historyId: "1" }), { status: 200 })
    );
    const { app, privileged, deps } = await createTestApp({
      users: [owner],
      config: { google: { clientId: "c", clientSecret: "s", redirectUri: "http://localhost:3000/api/oauth/gmail/callback" } },
      fetch: fetchMock as unknown as typeof fetch
    });
    privileged.getMemberRole.mockResolvedValue("OWNER");
    privileged.upsertOAuthEmailAccount.mockResolvedValue({ account: { id: "acc", emailAddress: "me@gmail.com" }, created: true });

    const state = encodeURIComponent(
      createOAuthState({ userId: owner.id, organizationId: ORG_A, provider: "GMAIL" }, deps.config.oauthStateSecret)
    );
    const first = await app.inject({ method: "GET", url: `/api/oauth/gmail/callback?code=c1&state=${state}` });
    const replay = await app.inject({ method: "GET", url: `/api/oauth/gmail/callback?code=c2&state=${state}` });

    expect(first.headers.location).toContain("oauth=connected");
    expect(replay.headers.location).toContain("reason=invalid_state");
    expect(privileged.upsertOAuthEmailAccount).toHaveBeenCalledTimes(1);
  });
});

describe("realtime revalidation", () => {
  it("disconnects sockets whose membership was removed or whose token expired", async () => {
    const memberships = new Map([["valid-user", "OWNER"]]);
    const deps = {
      identity: {
        verifyAccessToken: async (token: string) =>
          token === "expired" ? null : { id: token === "valid" ? "valid-user" : "removed-user", email: null }
      },
      repositories: () =>
        ({
          memberships: { findRole: async (userId: string) => memberships.get(userId) ?? null }
        }) as unknown as Repositories
    };
    const socket = (data: Record<string, string>) => ({ data, disconnect: vi.fn() });
    const valid = socket({ token: "valid", userId: "valid-user", organizationId: ORG_A });
    const removed = socket({ token: "removed", userId: "removed-user", organizationId: ORG_A });
    const expired = socket({ token: "expired", userId: "valid-user", organizationId: ORG_A });
    const tampered = socket({ token: "valid", userId: "someone-else", organizationId: ORG_A });

    const dropped = await revalidateSockets([valid, removed, expired, tampered], deps);

    expect(dropped).toBe(3);
    expect(valid.disconnect).not.toHaveBeenCalled();
    expect(removed.disconnect).toHaveBeenCalledWith(true);
    expect(expired.disconnect).toHaveBeenCalledWith(true);
    expect(tampered.disconnect).toHaveBeenCalledWith(true);
  });
});
