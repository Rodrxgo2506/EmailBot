import type { AdminOrganizationDetail, AdminOrganizationSummary } from "@emailbot/types";
import { afterEach, describe, expect, it } from "vitest";
import { fromDatabaseError } from "../lib/errors.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B, type TestUser } from "./helpers.js";

/*
 * Platform administration API (EmailBot V2 phase 6). The admin.* database
 * functions are faked here; their SQL, grants and actor checks are covered
 * by packages/database/test/platform-admin.test.ts.
 */

const ORG_NEW = "33333333-3333-4333-8333-333333333333";

const summary = (overrides: Partial<AdminOrganizationSummary> = {}): AdminOrganizationSummary => ({
  id: ORG_A,
  name: "Org A",
  slug: "org-a",
  plan: "FREE",
  status: "ACTIVE",
  owner: { userId: "44444444-4444-4444-8444-444444444444", email: "owner@a.test", fullName: "Owner" },
  membersCount: 2,
  botsCount: 1,
  customersCount: 3,
  emailAccountsCount: 1,
  processedEmailsCount: 10,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

const detail = (overrides: Partial<AdminOrganizationDetail> = {}): AdminOrganizationDetail => ({
  ...summary(),
  rulesCount: 4,
  emailsCount: 12,
  deliveriesCount: 7,
  ...overrides
});

const owner = makeUser({ [ORG_A]: "OWNER" });
const orgAdmin = makeUser({ [ORG_A]: "ADMIN" });
const operator = makeUser({ [ORG_A]: "OPERATOR" });
const viewer = makeUser({ [ORG_A]: "VIEWER" });
const noOrganization = makeUser({});
const platformAdmin = makeUser({});
const platformAdminWithOrg = makeUser({ [ORG_B]: "VIEWER" });
const USERS = [owner, orgAdmin, operator, viewer, noOrganization, platformAdmin, platformAdminWithOrg];

let current: Awaited<ReturnType<typeof createTestApp>> | null = null;

async function setup() {
  current = await createTestApp({ users: USERS, platformAdmins: [platformAdmin.id, platformAdminWithOrg.id] });
  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = null;
});

const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/api/admin/stats"],
  ["GET", "/api/admin/organizations"],
  ["POST", "/api/admin/organizations", { name: "Acme", ownerEmail: "o@example.com" }],
  ["GET", `/api/admin/organizations/${ORG_A}`],
  ["PATCH", `/api/admin/organizations/${ORG_A}`, { status: "SUSPENDED" }],
  ["GET", `/api/admin/organizations/${ORG_A}/members`],
  ["GET", `/api/admin/organizations/${ORG_A}/bots`],
  ["GET", `/api/admin/organizations/${ORG_A}/customers`],
  ["GET", `/api/admin/organizations/${ORG_A}/email-accounts`],
  ["GET", "/api/admin/activity"],
  ["GET", "/api/admin/audit"]
];

const inject = (app: Awaited<ReturnType<typeof createTestApp>>["app"], method: string, url: string, user?: TestUser, body?: unknown, organizationId?: string) =>
  app.inject({
    method: method as "GET",
    url,
    headers: user ? authHeaders(user, organizationId) : {},
    ...(body !== undefined ? { payload: body as object } : {})
  });

describe("authentication and authorization", () => {
  it.each(ROUTES)("%s %s without a token -> 401", async (method, url, body) => {
    const { app, admin } = await setup();
    const response = await inject(app, method, url, undefined, body);
    expect(response.statusCode).toBe(401);
    expect(admin.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ["OWNER", owner],
    ["ADMIN", orgAdmin],
    ["OPERATOR", operator],
    ["VIEWER", viewer],
    ["user without organization", noOrganization]
  ] as const)("%s is rejected on every admin route before any data is read", async (_label, user) => {
    const { app, admin, privileged } = await setup();
    for (const [method, url, body] of ROUTES) {
      // Also when sending their own organization as the active one.
      const response = await inject(app, method, url, user, body, ORG_A);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
    }
    for (const [name, fn] of Object.entries(admin)) {
      if (name !== "isPlatformAdmin") expect(fn, name).not.toHaveBeenCalled();
    }
    expect(privileged.findProfileIdByEmail).not.toHaveBeenCalled();
  });

  it("the platform decision comes from the database on every request (revocation is immediate)", async () => {
    const { app, admin } = await setup();
    admin.stats.mockResolvedValue({ totalOrganizations: 1 });
    expect((await inject(app, "GET", "/api/admin/stats", platformAdmin)).statusCode).toBe(200);
    admin.isPlatformAdmin.mockResolvedValue(false);
    expect((await inject(app, "GET", "/api/admin/stats", platformAdmin)).statusCode).toBe(403);
    expect(admin.isPlatformAdmin).toHaveBeenCalledTimes(2);
  });

  it("the database's own actor check (42501) also ends in 403", async () => {
    const { app, admin } = await setup();
    admin.stats.mockRejectedValue(fromDatabaseError({ code: "42501", message: "Platform administrator access required" }));
    expect((await inject(app, "GET", "/api/admin/stats", platformAdmin)).statusCode).toBe(403);
  });

  it("a platform admin needs no organization, and the X-Organization-Id header is ignored", async () => {
    const { app, admin, repos } = await setup();
    admin.stats.mockResolvedValue({ totalOrganizations: 2 });
    for (const user of [platformAdmin, platformAdminWithOrg]) {
      const response = await inject(app, "GET", "/api/admin/stats", user, undefined, ORG_A);
      expect(response.statusCode).toBe(200);
      expect(admin.stats).toHaveBeenLastCalledWith(user.id);
    }
    expect(repos.memberships.findAccess).not.toHaveBeenCalled();
  });
});

describe("GET /api/me isPlatformAdmin", () => {
  it("is true only for platform admins and false when the lookup fails", async () => {
    const { app, admin } = await setup();
    expect((await inject(app, "GET", "/api/me", platformAdmin)).json().isPlatformAdmin).toBe(true);
    expect((await inject(app, "GET", "/api/me", owner)).json()).toMatchObject({ isPlatformAdmin: false, memberships: [{ role: "OWNER" }] });
    admin.isPlatformAdmin.mockRejectedValue(new Error("admin schema not exposed"));
    const response = await inject(app, "GET", "/api/me", platformAdmin);
    expect(response.statusCode).toBe(200);
    expect(response.json().isPlatformAdmin).toBe(false);
  });
});

describe("stats and organizations", () => {
  it("GET /stats returns the platform statistics", async () => {
    const { app, admin } = await setup();
    admin.stats.mockResolvedValue({ totalOrganizations: 3, activeOrganizations: 2 });
    const response = await inject(app, "GET", "/api/admin/stats", platformAdmin);
    expect(response.json()).toEqual({ stats: { totalOrganizations: 3, activeOrganizations: 2 } });
  });

  it("GET /organizations maps filters, sort and pagination", async () => {
    const { app, admin } = await setup();
    admin.listOrganizations.mockResolvedValue({ items: [summary()], total: 41 });
    const response = await inject(app, "GET", "/api/admin/organizations?search=%20acme%20&status=SUSPENDED&plan=PRO&sort=name_asc&page=3&pageSize=20", platformAdmin);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [summary()], page: 3, pageSize: 20, total: 41 });
    expect(admin.listOrganizations).toHaveBeenCalledWith(platformAdmin.id, {
      search: "acme",
      status: "SUSPENDED",
      plan: "PRO",
      sort: "name_asc",
      limit: 20,
      offset: 40
    });
  });

  it.each([
    "sort=name",
    "sort=created_at%20desc%3B%20drop%20table%20organizations",
    "status=DELETED",
    "plan=ENTERPRISE",
    "pageSize=1000",
    "page=0"
  ])("GET /organizations?%s -> 400", async (query) => {
    const { app, admin } = await setup();
    const response = await inject(app, "GET", `/api/admin/organizations?${query}`, platformAdmin);
    expect(response.statusCode).toBe(400);
    expect(admin.listOrganizations).not.toHaveBeenCalled();
  });

  it("GET /organizations/:id returns the detail, 404 when missing, 400 for a bad id", async () => {
    const { app, admin } = await setup();
    admin.getOrganization.mockResolvedValueOnce(detail()).mockResolvedValueOnce(null);
    expect((await inject(app, "GET", `/api/admin/organizations/${ORG_A}`, platformAdmin)).json()).toEqual({ organization: detail() });
    expect((await inject(app, "GET", `/api/admin/organizations/${ORG_B}`, platformAdmin)).statusCode).toBe(404);
    expect((await inject(app, "GET", "/api/admin/organizations/not-a-uuid", platformAdmin)).statusCode).toBe(400);
  });
});

describe("POST /api/admin/organizations", () => {
  it("resolves the owner by confirmed e-mail, derives the slug and returns 201 with the new organization", async () => {
    const { app, admin, privileged } = await setup();
    privileged.findProfileIdByEmail.mockResolvedValue("55555555-5555-4555-8555-555555555555");
    admin.createOrganization.mockResolvedValue(ORG_NEW);
    admin.getOrganization.mockResolvedValue(detail({ id: ORG_NEW, name: "Clínica Señal", slug: "clinica-senal", plan: "PRO" }));
    const response = await inject(app, "POST", "/api/admin/organizations", platformAdmin, {
      name: "  Clínica Señal ",
      plan: "PRO",
      ownerEmail: "Owner@Example.com"
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().organization).toMatchObject({ id: ORG_NEW, slug: "clinica-senal" });
    expect(privileged.findProfileIdByEmail).toHaveBeenCalledWith("owner@example.com");
    expect(admin.createOrganization).toHaveBeenCalledWith(platformAdmin.id, {
      name: "Clínica Señal",
      slug: "clinica-senal",
      plan: "PRO",
      ownerUserId: "55555555-5555-4555-8555-555555555555",
      requestId: expect.any(String)
    });
  });

  it("an unknown or unconfirmed owner -> 422 OWNER_NOT_FOUND and nothing is created", async () => {
    const { app, admin, privileged } = await setup();
    privileged.findProfileIdByEmail.mockResolvedValue(null);
    const response = await inject(app, "POST", "/api/admin/organizations", platformAdmin, { name: "Acme", ownerEmail: "ghost@example.com" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("OWNER_NOT_FOUND");
    expect(admin.createOrganization).not.toHaveBeenCalled();
  });

  it("a duplicated slug -> 409", async () => {
    const { app, admin, privileged } = await setup();
    privileged.findProfileIdByEmail.mockResolvedValue("55555555-5555-4555-8555-555555555555");
    admin.createOrganization.mockRejectedValue(fromDatabaseError({ code: "23505", message: "duplicate key value violates unique constraint" }));
    const response = await inject(app, "POST", "/api/admin/organizations", platformAdmin, { name: "Acme", slug: "org-a", ownerEmail: "o@example.com" });
    expect(response.statusCode).toBe(409);
  });

  it.each([
    [{ name: "Acme" }],
    [{ name: "Acme", ownerEmail: "o@example.com", status: "ACTIVE" }],
    [{ name: "Acme", ownerEmail: "o@example.com", ownerUserId: ORG_NEW }],
    [{ name: "Acme", ownerEmail: "o@example.com", plan: "ENTERPRISE" }],
    [{ name: "!!", ownerEmail: "o@example.com" }]
  ])("rejects %j without creating anything", async (body) => {
    const { app, admin } = await setup();
    const response = await inject(app, "POST", "/api/admin/organizations", platformAdmin, body);
    expect(response.statusCode).toBe(400);
    expect(admin.createOrganization).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/organizations/:id", () => {
  it.each([
    [{ status: "SUSPENDED" }, { plan: undefined, status: "SUSPENDED" }],
    [{ status: "ACTIVE" }, { plan: undefined, status: "ACTIVE" }],
    [{ status: "CANCELLED" }, { plan: undefined, status: "CANCELLED" }],
    [{ plan: "BUSINESS" }, { plan: "BUSINESS", status: undefined }]
  ])("%j updates through the audited function and returns the fresh detail", async (body, patch) => {
    const { app, admin } = await setup();
    admin.updateOrganization.mockResolvedValue(true);
    admin.getOrganization.mockResolvedValue(detail({ status: (body as { status?: "SUSPENDED" }).status ?? "ACTIVE" }));
    const response = await inject(app, "PATCH", `/api/admin/organizations/${ORG_A}`, platformAdmin, body);
    expect(response.statusCode).toBe(200);
    expect(admin.updateOrganization).toHaveBeenCalledWith(platformAdmin.id, ORG_A, patch, expect.any(String));
    expect(response.json().organization.id).toBe(ORG_A);
  });

  it("unknown organization -> 404", async () => {
    const { app, admin } = await setup();
    admin.updateOrganization.mockResolvedValue(false);
    expect((await inject(app, "PATCH", `/api/admin/organizations/${ORG_NEW}`, platformAdmin, { status: "SUSPENDED" })).statusCode).toBe(404);
  });

  it.each([[{}], [{ name: "Otro" }], [{ status: "SUSPENDED", slug: "x" }], [{ status: "PAUSED" }]])("rejects %j (no mass assignment)", async (body) => {
    const { app, admin } = await setup();
    expect((await inject(app, "PATCH", `/api/admin/organizations/${ORG_A}`, platformAdmin, body)).statusCode).toBe(400);
    expect(admin.updateOrganization).not.toHaveBeenCalled();
  });
});

describe("organization metadata", () => {
  it.each([
    ["members", "listMembers"],
    ["bots", "listBots"],
    ["email-accounts", "listEmailAccounts"]
  ] as const)("GET /organizations/:id/%s returns items of that organization", async (path, method) => {
    const { app, admin } = await setup();
    admin.getOrganization.mockResolvedValue(detail());
    admin[method].mockResolvedValue([{ id: "x" }]);
    const response = await inject(app, "GET", `/api/admin/organizations/${ORG_A}/${path}`, platformAdmin);
    expect(response.json()).toEqual({ items: [{ id: "x" }] });
    expect(admin[method]).toHaveBeenCalledWith(platformAdmin.id, ORG_A);
  });

  it.each(["members", "bots", "customers", "email-accounts"])("GET /organizations/:id/%s -> 404 for an unknown organization (no list query)", async (path) => {
    const { app, admin } = await setup();
    admin.getOrganization.mockResolvedValue(null);
    expect((await inject(app, "GET", `/api/admin/organizations/${ORG_NEW}/${path}`, platformAdmin)).statusCode).toBe(404);
    for (const method of ["listMembers", "listBots", "listCustomers", "listEmailAccounts"] as const) expect(admin[method]).not.toHaveBeenCalled();
  });

  it("customers are paginated", async () => {
    const { app, admin } = await setup();
    admin.getOrganization.mockResolvedValue(detail());
    admin.listCustomers.mockResolvedValue({ items: [], total: 60 });
    const response = await inject(app, "GET", `/api/admin/organizations/${ORG_A}/customers?page=2&pageSize=25`, platformAdmin);
    expect(response.json()).toEqual({ items: [], page: 2, pageSize: 25, total: 60 });
    expect(admin.listCustomers).toHaveBeenCalledWith(platformAdmin.id, ORG_A, { limit: 25, offset: 25 });
  });
});

describe("activity and audit", () => {
  it.each([
    ["activity", "listActivity"],
    ["audit", "listAudit"]
  ] as const)("GET /%s asks one extra row to report hasMore", async (path, method) => {
    const { app, admin } = await setup();
    admin[method].mockResolvedValue([{ id: "1" }, { id: "2" }, { id: "3" }]);
    const response = await inject(app, "GET", `/api/admin/${path}?page=2&pageSize=2&organizationId=${ORG_A}`, platformAdmin);
    expect(response.json()).toEqual({ items: [{ id: "1" }, { id: "2" }], page: 2, pageSize: 2, hasMore: true });
    expect(admin[method]).toHaveBeenCalledWith(platformAdmin.id, { organizationId: ORG_A, limit: 3, offset: 2 });
  });

  it("the last page reports hasMore = false; a bad organization id -> 400", async () => {
    const { app, admin } = await setup();
    admin.listAudit.mockResolvedValue([{ id: "1" }]);
    expect((await inject(app, "GET", "/api/admin/audit", platformAdmin)).json()).toEqual({ items: [{ id: "1" }], page: 1, pageSize: 25, hasMore: false });
    expect((await inject(app, "GET", "/api/admin/activity?organizationId=x", platformAdmin)).statusCode).toBe(400);
  });
});

describe("normal organization endpoints are unchanged for platform admins", () => {
  it("a platform admin who is not a member cannot use another organization's endpoints", async () => {
    const { app } = await setup();
    const response = await inject(app, "GET", "/api/customers", platformAdmin, undefined, ORG_A);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("NOT_A_MEMBER");
  });
});
