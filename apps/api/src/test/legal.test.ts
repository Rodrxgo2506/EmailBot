import { CURRENT_LEGAL_VERSIONS } from "@emailbot/types";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../lib/errors.js";
import { SETTINGS_COLUMNS, toSettings } from "../repositories/supabase/mappers.js";
import { authHeaders, createTestApp, makeUser, ORG_A, type TestUser } from "./helpers.js";

/*
 * EmailBot V2 phase 7: acceptance of the CURRENT legal versions. The API is
 * the source of truth: it decides whether a user must accept (GET /api/me
 * `legal`) and records the acceptance for the user of the verified token with
 * the server's versions (the database sets the time; see
 * packages/database/test/legal-acceptances.test.ts).
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const other = makeUser({ [ORG_A]: "VIEWER" });
const newcomer = makeUser({}); // no organization yet: must be able to accept before onboarding

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(acceptances: Record<string, Array<{ document: "terms" | "privacy"; version: string }>>) {
  ctx = await createTestApp({ users: [owner, other, newcomer] });
  const recorded: Record<string, Array<{ document: "terms" | "privacy"; version: string }>> = structuredClone(acceptances);
  ctx.privileged.listLegalAcceptances.mockImplementation(async (userId: string) => recorded[userId] ?? []);
  ctx.privileged.recordLegalAcceptance.mockImplementation(async (userId: string, versions: { terms: string; privacy: string }) => {
    recorded[userId] = [...(recorded[userId] ?? []), { document: "terms", version: versions.terms }, { document: "privacy", version: versions.privacy }];
  });
  return ctx;
}

const current = [
  { document: "terms" as const, version: CURRENT_LEGAL_VERSIONS.terms },
  { document: "privacy" as const, version: CURRENT_LEGAL_VERSIONS.privacy }
];
const accept = (app: Awaited<ReturnType<typeof createTestApp>>["app"], user: TestUser, payload: unknown) =>
  app.inject({ method: "POST", url: "/api/me/legal-acceptance", headers: authHeaders(user), payload: payload as Record<string, unknown> });
const shown = { termsVersion: CURRENT_LEGAL_VERSIONS.terms, privacyVersion: CURRENT_LEGAL_VERSIONS.privacy };

describe("GET /api/me: legal status", () => {
  it("a user who accepted the current versions is reported as accepted (normal access)", async () => {
    const { app } = await setup({ [owner.id]: current });
    const me = (await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) })).json();
    expect(me.legal).toEqual({ termsVersion: CURRENT_LEGAL_VERSIONS.terms, privacyVersion: CURRENT_LEGAL_VERSIONS.privacy, accepted: true });
    expect(me.memberships).toHaveLength(1);
  });

  it("a user without any acceptance (existing user, account created elsewhere) must accept", async () => {
    const { app, privileged } = await setup({});
    const me = (await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) })).json();
    expect(me.legal.accepted).toBe(false);
    expect(privileged.listLegalAcceptances).toHaveBeenCalledWith(owner.id);
  });

  it("an older accepted version does not count: the user must accept again", async () => {
    const { app } = await setup({
      [owner.id]: [
        { document: "terms", version: "1.0" },
        { document: "privacy", version: "1.0" }
      ]
    });
    expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) })).json().legal.accepted).toBe(false);
  });

  it("only one current document accepted is not enough", async () => {
    const { app } = await setup({ [owner.id]: [current[0]!] });
    expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) })).json().legal.accepted).toBe(false);
  });

  it("a failed lookup fails the request instead of skipping the acceptance", async () => {
    const { app, privileged } = await setup({});
    privileged.listLegalAcceptances.mockRejectedValue(new AppError(500, "DATABASE_ERROR", "Unexpected database error"));
    expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) })).statusCode).toBe(500);
  });
});

describe("POST /api/me/legal-acceptance", () => {
  it("records the SERVER's current versions for the authenticated user and reports them accepted", async () => {
    const { app, privileged } = await setup({});
    const response = await accept(app, owner, shown);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ legal: { ...shown, accepted: true } });
    expect(privileged.recordLegalAcceptance).toHaveBeenCalledTimes(1);
    expect(privileged.recordLegalAcceptance).toHaveBeenCalledWith(owner.id, CURRENT_LEGAL_VERSIONS);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(owner) })).json().legal.accepted).toBe(true);
  });

  it("works without an organization (users accept before onboarding)", async () => {
    const { app, privileged } = await setup({});
    expect((await accept(app, newcomer, shown)).statusCode).toBe(200);
    expect(privileged.recordLegalAcceptance).toHaveBeenCalledWith(newcomer.id, CURRENT_LEGAL_VERSIONS);
  });

  it("a user cannot record an acceptance for another user: extra fields are rejected and nothing is recorded", async () => {
    const { app, privileged } = await setup({});
    for (const payload of [
      { ...shown, userId: other.id },
      { ...shown, user_id: other.id },
      { ...shown, organizationId: ORG_A }
    ]) {
      const response = await accept(app, owner, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(privileged.recordLegalAcceptance).not.toHaveBeenCalled();
    // The other user is still not accepted.
    expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeaders(other) })).json().legal.accepted).toBe(false);
  });

  it("the browser's time is never used: a date in the body is rejected", async () => {
    const { app, privileged } = await setup({});
    for (const payload of [
      { ...shown, acceptedAt: "2020-01-01T00:00:00.000Z" },
      { ...shown, accepted_at: "2020-01-01T00:00:00.000Z" }
    ]) {
      expect((await accept(app, owner, payload)).statusCode).toBe(400);
    }
    expect(privileged.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it.each([
    ["an older version", { termsVersion: "1.0", privacyVersion: "1.0" }],
    ["a future version", { termsVersion: "9.9", privacyVersion: CURRENT_LEGAL_VERSIONS.privacy }]
  ])("refuses %s shown to the user (409) and records nothing", async (_label, payload) => {
    const { app, privileged } = await setup({});
    const response = await accept(app, owner, payload);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("LEGAL_VERSION_OUTDATED");
    expect(privileged.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["malformed versions", { termsVersion: "latest", privacyVersion: "2.0" }],
    ["a missing document", { termsVersion: CURRENT_LEGAL_VERSIONS.terms }]
  ])("rejects %s (400)", async (_label, payload) => {
    const { app, privileged } = await setup({});
    expect((await accept(app, owner, payload)).statusCode).toBe(400);
    expect(privileged.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const { app, privileged } = await setup({});
    const response = await app.inject({ method: "POST", url: "/api/me/legal-acceptance", payload: shown });
    expect(response.statusCode).toBe(401);
    expect(privileged.recordLegalAcceptance).not.toHaveBeenCalled();
  });
});

describe("organization settings: email retention and email notifications are not part of the API", () => {
  it.each([
    ["emailNotificationsEnabled", { emailNotificationsEnabled: false }],
    ["both removed fields", { emailNotificationsEnabled: true, emailRetentionDays: 30 }]
  ])("%s alone is an invalid request; nothing is written", async (_label, payload) => {
    const { app, repos } = await setup({ [owner.id]: current });
    const response = await app.inject({ method: "PATCH", url: "/api/organizations/current/settings", headers: authHeaders(owner, ORG_A), payload });
    expect(response.statusCode).toBe(400);
    expect(repos.organizations.updateSettings).not.toHaveBeenCalled();
  });

  it("emailNotificationsEnabled next to other fields is ignored: never written", async () => {
    const { app, repos } = await setup({ [owner.id]: current });
    repos.organizations.updateSettings.mockResolvedValue({ organizationId: ORG_A, notificationsEnabled: false });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organizations/current/settings",
      headers: authHeaders(owner, ORG_A),
      payload: { notificationsEnabled: false, emailNotificationsEnabled: true }
    });
    expect(response.statusCode).toBe(200);
    expect(repos.organizations.updateSettings).toHaveBeenCalledWith(ORG_A, { notifications_enabled: false });
  });

  it("settings returned by the API carry neither field (the columns are not even read)", () => {
    expect(SETTINGS_COLUMNS).not.toMatch(/email_notifications_enabled|email_retention_days/);
    const settings = toSettings({
      organization_id: ORG_A,
      timezone: "America/Lima",
      language: "es",
      auto_processing_enabled: true,
      process_attachments: true,
      notifications_enabled: true,
      email_notifications_enabled: true,
      email_retention_days: 30,
      default_inbox_filter: "ALL",
      updated_at: "2026-10-01T00:00:00.000Z"
    });
    expect(settings).not.toHaveProperty("emailNotificationsEnabled");
    expect(settings).not.toHaveProperty("emailRetentionDays");
  });

  it("the settings contract no longer accepts emailRetentionDays: alone it is an invalid request", async () => {
    const { app, repos } = await setup({ [owner.id]: current });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organizations/current/settings",
      headers: authHeaders(owner, ORG_A),
      payload: { emailRetentionDays: 30 }
    });
    expect(response.statusCode).toBe(400);
    expect(repos.organizations.updateSettings).not.toHaveBeenCalled();
  });

  it("next to other fields it is ignored: never written to the database", async () => {
    const { app, repos } = await setup({ [owner.id]: current });
    repos.organizations.updateSettings.mockResolvedValue({ organizationId: ORG_A, timezone: "America/Lima" });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organizations/current/settings",
      headers: authHeaders(owner, ORG_A),
      payload: { timezone: "America/Lima", emailRetentionDays: 30 }
    });
    expect(response.statusCode).toBe(200);
    expect(repos.organizations.updateSettings).toHaveBeenCalledWith(ORG_A, { timezone: "America/Lima" });
  });
});
