import { readFileSync } from "node:fs";
import { IMAP_TRIAL_ORGANIZATION_IDS, imapAllowedForOrganization } from "@emailbot/shared";
import type { EmailAccount } from "@emailbot/types";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B, type TestUser } from "./helpers.js";

/*
 * IMAP trial allowlist (API side). imapAccountsEnabled stays FIXED to false in the configuration; when a reviewed change
 * turns it on, IMAP is available ONLY to the organizations in IMAP_TRIAL_ORGANIZATION_IDS (@emailbot/shared, fixed in
 * code, empty today), checked against the organization verified for the request (membership). Here the switch and the
 * list are set in the TEST configuration only. No network: nothing reaches a resolver, an IMAP client, the RPCs or
 * the queue in the refused cases.
 */

const ownerA = makeUser({ [ORG_A]: "OWNER" });
const ownerB = makeUser({ [ORG_B]: "OWNER" });
const ownerBoth = makeUser({ [ORG_A]: "OWNER", [ORG_B]: "OWNER" });
const nobody = makeUser({});
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const MISSING_ID = "99999999-2222-4333-8444-555555555555";

const account = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: ACCOUNT_ID,
  organizationId: ORG_A,
  provider: "IMAP",
  status: "PAUSED",
  emailAddress: "ventas@empresa-correo.com",
  displayName: "Ventas",
  lastSyncedAt: null,
  lastErrorCode: "IMAP_ACTIVATION_PENDING",
  lastErrorMessage: null,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...overrides
});

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

async function setup(config: { imapAccountsEnabled: boolean; imapOrganizationIds: readonly string[] }) {
  ctx = await createTestApp({ users: [ownerA, ownerB, ownerBoth, nobody], config });
  return ctx;
}

const code = (response: { json(): { error?: { code?: string } } }) => response.json().error?.code;
const post = (url: string, user: TestUser, organizationId?: string, headers: Record<string, string> = {}) =>
  ctx!.app.inject({ method: "POST", url, headers: { ...authHeaders(user, organizationId), ...headers }, payload: "{not json" });
const providers = async (user: TestUser, organizationId?: string) =>
  (await ctx!.app.inject({ method: "GET", url: "/api/email-accounts/providers", headers: authHeaders(user, organizationId) })).json().providers;

describe("policy (pure)", () => {
  it("empty today; true only with IMAP on AND a listed, well-formed organization id", () => {
    expect(IMAP_TRIAL_ORGANIZATION_IDS).toEqual([]);
    expect(imapAllowedForOrganization(true, [ORG_A], ORG_A)).toBe(true);
    for (const [enabled, list, organization] of [
      [false, [ORG_A], ORG_A],
      [undefined, [ORG_A], ORG_A],
      [true, [], ORG_A],
      [true, undefined, ORG_A],
      [true, [ORG_A], ORG_B],
      [true, [ORG_A], null],
      [true, [ORG_A], undefined],
      [true, [ORG_A], ""],
      [true, [ORG_A], 42],
      // ids are compared as stored (lower case): an upper-case spelling is not the listed organization
      [true, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]
    ] as const) {
      expect(imapAllowedForOrganization(enabled, list as readonly string[] | undefined, organization), JSON.stringify([enabled, list, organization])).toBe(false);
    }
  });

  it("the production configuration: IMAP off, empty frozen allowlist, no environment variable changes either", () => {
    const base = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", TOKEN_ENCRYPTION_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3)).toString("base64"), OAUTH_STATE_SECRET: "x".repeat(32) };
    for (const name of ["", "IMAP_TRIAL_ORGANIZATION_IDS", "IMAP_ORGANIZATION_IDS", "IMAP_ALLOWED_ORGANIZATIONS", "IMAP_ACCOUNTS_ENABLED"]) {
      const config = loadConfig(name ? { ...base, [name]: ORG_A } : base);
      expect(config.imapAccountsEnabled, name).toBe(false);
      expect(config.imapOrganizationIds, name).toEqual([]);
      expect(Object.isFrozen(config.imapOrganizationIds), name).toBe(true);
    }
  });

  it("every IMAP decision in the routes goes through the organization of the request (static)", () => {
    const source = readFileSync(new URL("../modules/email-accounts/routes.ts", import.meta.url), "utf8");
    expect(source.match(/providerAvailability\(deps\.config\)/g)).toBeNull();
    expect(source.match(/providerAvailability\(deps\.config, (getOrganization\(request\)\.id|organizationId)\)/g)?.length).toBeGreaterThanOrEqual(6);
    // Outside comments, the switch is read in one place only: providerAvailability, together with the allowlist.
    const code = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(code.filter((line) => line.includes("imapAccountsEnabled"))).toEqual([
      "    IMAP: imapAllowedForOrganization(config.imapAccountsEnabled, config.imapOrganizationIds, organizationId)"
    ]);
  });
});

describe("IMAP on, ORG_A in the allowlist", () => {
  const allowA = { imapAccountsEnabled: true, imapOrganizationIds: [ORG_A] };

  it("/providers: IMAP true for ORG_A, false for ORG_B; Gmail / Microsoft unchanged", async () => {
    await setup(allowA);
    const a = await providers(ownerA, ORG_A);
    const b = await providers(ownerB, ORG_B);
    expect(a.IMAP).toBe(true);
    expect(b.IMAP).toBe(false);
    expect({ GMAIL: a.GMAIL, MICROSOFT: a.MICROSOFT }).toEqual({ GMAIL: b.GMAIL, MICROSOFT: b.MICROSOFT });
  });

  it("ORG_A reaches the route body (a malformed body is now a 400, not the 503)", async () => {
    await setup(allowA);
    for (const url of ["/api/email-accounts/imap/test", "/api/email-accounts/imap"]) {
      const response = await post(url, ownerA, ORG_A, { "content-type": "application/json" });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it("ORG_B: both IMAP routes answer 503 IMAP_NOT_AVAILABLE before the body; nothing contacted or stored", async () => {
    const { privileged, queue } = await setup(allowA);
    for (const url of ["/api/email-accounts/imap/test", "/api/email-accounts/imap"]) {
      const response = await post(url, ownerB, ORG_B, { "content-type": "application/json" });
      expect([response.statusCode, code(response)], url).toEqual([503, "IMAP_NOT_AVAILABLE"]);
    }
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("a member of both organizations: ORG_A allowed, ORG_B refused, depending only on the selected organization", async () => {
    await setup(allowA);
    expect((await post("/api/email-accounts/imap/test", ownerBoth, ORG_A, { "content-type": "application/json" })).statusCode).toBe(400);
    const refused = await post("/api/email-accounts/imap/test", ownerBoth, ORG_B, { "content-type": "application/json" });
    expect([refused.statusCode, code(refused)]).toEqual([503, "IMAP_NOT_AVAILABLE"]);
  });

  it("ORG_B: resuming its IMAP mailbox keeps 409 IMAP_SYNC_NOT_IMPLEMENTED; no RPC, no write, no queue", async () => {
    const { privileged, repos, queue } = await setup(allowA);
    repos.emailAccounts.get.mockResolvedValue(account({ organizationId: ORG_B }));
    const response = await ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${ACCOUNT_ID}`, headers: authHeaders(ownerB, ORG_B), payload: { status: "ACTIVE" } });
    expect([response.statusCode, code(response)]).toEqual([409, "IMAP_SYNC_NOT_IMPLEMENTED"]);
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
    expect(repos.emailAccounts.update).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("ORG_A: resuming its IMAP mailbox goes to the activation RPC", async () => {
    const { privileged, repos } = await setup(allowA);
    repos.emailAccounts.get.mockResolvedValue(account());
    privileged.activateImapEmailAccount.mockResolvedValue({ outcome: "ALREADY_ACTIVE", account: account({ status: "ACTIVE" }), previousStatus: "ACTIVE" });
    const response = await ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${ACCOUNT_ID}`, headers: authHeaders(ownerA, ORG_A), payload: { status: "ACTIVE" } });
    expect(response.statusCode).toBe(200);
    expect(privileged.activateImapEmailAccount).toHaveBeenCalledWith(ORG_A, ACCOUNT_ID);
  });

  it("manual sync: ORG_B's ACTIVE IMAP account gets 409 and nothing is queued; ORG_A's is queued", async () => {
    const { repos, queue } = await setup(allowA);
    repos.emailAccounts.get.mockResolvedValue(account({ organizationId: ORG_B, status: "ACTIVE" }));
    const refused = await ctx!.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/sync`, headers: authHeaders(ownerB, ORG_B) });
    expect([refused.statusCode, code(refused)]).toEqual([409, "IMAP_SYNC_NOT_IMPLEMENTED"]);
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();

    repos.emailAccounts.get.mockResolvedValue(account({ status: "ACTIVE" }));
    const queued = await ctx!.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/sync`, headers: authHeaders(ownerA, ORG_A) });
    expect(queued.statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledTimes(1);
  });

  it("an account that does not exist: 404 for resume and sync, in either organization; nothing called", async () => {
    const { privileged, repos, queue } = await setup(allowA);
    repos.emailAccounts.get.mockResolvedValue(null);
    for (const [user, organization] of [
      [ownerA, ORG_A],
      [ownerB, ORG_B]
    ] as const) {
      const resume = await ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${MISSING_ID}`, headers: authHeaders(user, organization), payload: { status: "ACTIVE" } });
      const sync = await ctx!.app.inject({ method: "POST", url: `/api/email-accounts/${MISSING_ID}/sync`, headers: authHeaders(user, organization) });
      expect([resume.statusCode, sync.statusCode], organization).toEqual([404, 404]);
    }
    expect(privileged.activateImapEmailAccount).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("no valid organization: malformed header 400, not a member 403, none selected 400, no organization 403; never 2xx", async () => {
    const { privileged, queue } = await setup(allowA);
    const cases: Array<[TestUser, Record<string, string>, number, string]> = [
      [ownerA, { "x-organization-id": "not-a-uuid" }, 400, "INVALID_ORGANIZATION_ID"],
      [ownerB, { "x-organization-id": ORG_A }, 403, "NOT_A_MEMBER"],
      [ownerBoth, {}, 400, "ORGANIZATION_REQUIRED"],
      [nobody, {}, 403, "NO_ORGANIZATION"]
    ];
    for (const [user, headers, status, expected] of cases) {
      for (const url of ["/api/email-accounts/imap/test", "/api/email-accounts/imap"]) {
        const response = await post(url, user, undefined, { ...headers, "content-type": "application/json" });
        expect([response.statusCode, code(response)], `${url} ${expected}`).toEqual([status, expected]);
      }
      const listing = await ctx!.app.inject({ method: "GET", url: "/api/email-accounts/providers", headers: { ...authHeaders(user), ...headers } });
      expect(listing.statusCode, expected).toBe(status);
    }
    expect(privileged.connectImapEmailAccount).not.toHaveBeenCalled();
    expect(queue.enqueueEmailEvent).not.toHaveBeenCalled();
  });

  it("Gmail accounts of ORG_B are paused, resumed and synchronized as before", async () => {
    const { repos, queue } = await setup(allowA);
    const gmail = account({ organizationId: ORG_B, provider: "GMAIL", status: "PAUSED", emailAddress: "b@gmail.com" });
    repos.emailAccounts.get.mockResolvedValue(gmail);
    repos.emailAccounts.update.mockResolvedValue({ ...gmail, status: "ACTIVE" });
    const resumed = await ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${ACCOUNT_ID}`, headers: authHeaders(ownerB, ORG_B), payload: { status: "ACTIVE" } });
    expect(resumed.statusCode).toBe(200);
    expect(repos.emailAccounts.update).toHaveBeenCalledWith(ORG_B, ACCOUNT_ID, { status: "ACTIVE" });
    repos.emailAccounts.get.mockResolvedValue({ ...gmail, status: "ACTIVE" });
    const sync = await ctx!.app.inject({ method: "POST", url: `/api/email-accounts/${ACCOUNT_ID}/sync`, headers: authHeaders(ownerB, ORG_B) });
    expect(sync.statusCode).toBe(202);
    expect(queue.enqueueEmailEvent).toHaveBeenCalledTimes(1);
  });
});

describe("the global switch still rules", () => {
  it("IMAP on with an EMPTY allowlist: refused for every organization", async () => {
    await setup({ imapAccountsEnabled: true, imapOrganizationIds: [] });
    expect((await providers(ownerA, ORG_A)).IMAP).toBe(false);
    const response = await post("/api/email-accounts/imap/test", ownerA, ORG_A, { "content-type": "application/json" });
    expect([response.statusCode, code(response)]).toEqual([503, "IMAP_NOT_AVAILABLE"]);
  });

  it("IMAP off with ORG_A listed (production switch): still refused", async () => {
    const { repos } = await setup({ imapAccountsEnabled: false, imapOrganizationIds: [ORG_A] });
    expect((await providers(ownerA, ORG_A)).IMAP).toBe(false);
    const response = await post("/api/email-accounts/imap", ownerA, ORG_A, { "content-type": "application/json" });
    expect([response.statusCode, code(response)]).toEqual([503, "IMAP_NOT_AVAILABLE"]);
    repos.emailAccounts.get.mockResolvedValue(account());
    const resume = await ctx!.app.inject({ method: "PATCH", url: `/api/email-accounts/${ACCOUNT_ID}`, headers: authHeaders(ownerA, ORG_A), payload: { status: "ACTIVE" } });
    expect([resume.statusCode, code(resume)]).toEqual([409, "IMAP_SYNC_NOT_IMPLEMENTED"]);
  });
});
