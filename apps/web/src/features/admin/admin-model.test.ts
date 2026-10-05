import type { AdminActivityItem, AdminAuditEntry } from "@emailbot/types";
import { describe, expect, it, vi } from "vitest";
import { createAdminApi } from "./admin-api";
import { activityLabel, auditOrganizationLabel, cancelChange, platformActionLabel, platformAuditDetail, statusChange } from "./admin-model";

describe("statusChange", () => {
  it("ACTIVE -> suspend: destructive, explains the real effects and that nothing is deleted", () => {
    const change = statusChange("ACTIVE", "Acme");
    expect(change).toMatchObject({ target: "SUSPENDED", action: "Suspender", title: "¿Suspender organización?", destructive: true });
    expect(change.description).toMatch(/dejará de procesar correos nuevos/);
    expect(change.description).toMatch(/No se elimina ningún dato/);
    expect(change.description).toMatch(/reactivarla después/);
  });

  it.each(["SUSPENDED", "CANCELLED"] as const)("%s -> reactivate (not destructive)", (status) => {
    expect(statusChange(status, "Acme")).toMatchObject({ target: "ACTIVE", action: "Reactivar", title: "¿Reactivar organización?", destructive: false });
  });
});

describe("cancelChange", () => {
  it.each(["ACTIVE", "SUSPENDED"] as const)("%s -> cancel: destructive, same effects as a suspension, nothing deleted, reversible", (status) => {
    const change = cancelChange(status, "Acme");
    expect(change).toMatchObject({ target: "CANCELLED", action: "Cancelar organización", title: "¿Cancelar organización?", destructive: true });
    expect(change?.description).toMatch(/mismos efectos que una suspensión/);
    expect(change?.description).toMatch(/No se elimina ningún dato/);
    expect(change?.description).toMatch(/puedes reactivarla después/);
  });

  it("an already cancelled organization offers no cancellation", () => {
    expect(cancelChange("CANCELLED", "Acme")).toBeNull();
  });
});

describe("auditOrganizationLabel", () => {
  const entry = (overrides: Partial<AdminAuditEntry>): AdminAuditEntry => ({
    id: "a",
    actor: { userId: null, email: null },
    action: "organization.suspended",
    targetType: "organization",
    targetId: "11111111-1111-4111-8111-111111111111",
    organization: { id: "11111111-1111-4111-8111-111111111111", name: "Acme" },
    metadata: {},
    createdAt: "2026-10-05T00:00:00.000Z",
    ...overrides
  });

  it("existing organization: id and name", () => {
    expect(auditOrganizationLabel(entry({}))).toEqual({ id: "11111111-1111-4111-8111-111111111111", name: "Acme" });
  });

  it("organization deleted (organization_id set to NULL, target_id kept): deleted", () => {
    expect(auditOrganizationLabel(entry({ organization: null }))).toEqual({ deleted: true });
  });

  it("not about an organization: null", () => {
    expect(auditOrganizationLabel(entry({ organization: null, targetType: "platform", targetId: null }))).toBeNull();
  });
});

describe("audit and activity labels", () => {
  const entry = (action: string, metadata: Record<string, unknown>): AdminAuditEntry => ({
    id: "1",
    actor: { userId: null, email: null },
    action,
    targetType: "organization",
    targetId: null,
    organization: null,
    metadata,
    createdAt: "2026-10-05T00:00:00.000Z"
  });

  it("translates platform actions and shows only from/to or the plan", () => {
    expect(platformActionLabel("organization.suspended")).toBe("Organización suspendida");
    expect(platformActionLabel("organization.unknown")).toBe("organization.unknown");
    expect(platformAuditDetail(entry("organization.suspended", { from: "ACTIVE", to: "SUSPENDED" }))).toBe("ACTIVE → SUSPENDED");
    expect(platformAuditDetail(entry("organization.created", { plan: "PRO", ownerUserId: "x" }))).toBe("Plan PRO");
    expect(platformAuditDetail(entry("organization.created", {}))).toBeNull();
  });

  it("activity shows the event, otherwise action and entity type", () => {
    const base: AdminActivityItem = {
      id: "1",
      organization: { id: "o", name: "Org" },
      actorType: "SYSTEM",
      action: "PROCESS",
      entityType: "email",
      event: null,
      createdAt: "2026-10-05T00:00:00.000Z"
    };
    expect(activityLabel({ ...base, event: "customer.created" })).toBe("customer.created");
    expect(activityLabel(base)).toBe("PROCESS · email");
  });
});

describe("createAdminApi", () => {
  function client() {
    return {
      get: vi.fn(async (_path: string): Promise<unknown> => ({ stats: { totalOrganizations: 1 }, organization: { id: "o" }, items: [] })),
      post: vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({ organization: { id: "new" } })),
      patch: vi.fn(async (_path: string, _body: unknown): Promise<unknown> => ({ organization: { id: "o" } }))
    };
  }

  it("builds the admin URLs, omits empty filters and unwraps the responses", async () => {
    const http = client();
    const api = createAdminApi(http as never);
    expect(await api.stats()).toEqual({ totalOrganizations: 1 });
    await api.listOrganizations({ search: "  acme ", status: "", plan: "PRO", sort: "name_asc", page: 2, pageSize: 25 });
    expect(http.get).toHaveBeenLastCalledWith("/api/admin/organizations?search=acme&plan=PRO&sort=name_asc&page=2&pageSize=25");
    await api.customers("a/b", 3, 25);
    expect(http.get).toHaveBeenLastCalledWith("/api/admin/organizations/a%2Fb/customers?page=3&pageSize=25");
    await api.activity({ page: 1, pageSize: 8 });
    expect(http.get).toHaveBeenLastCalledWith("/api/admin/activity?page=1&pageSize=8");
    await api.audit({ organizationId: "o", page: 1, pageSize: 25 });
    expect(http.get).toHaveBeenLastCalledWith("/api/admin/audit?organizationId=o&page=1&pageSize=25");
    expect(await api.createOrganization({ name: "Acme", ownerEmail: "o@example.com", plan: "FREE" })).toEqual({ id: "new" });
    expect(http.post).toHaveBeenCalledWith("/api/admin/organizations", { name: "Acme", ownerEmail: "o@example.com", plan: "FREE" });
    await api.updateOrganization("o", { status: "SUSPENDED" });
    expect(http.patch).toHaveBeenCalledWith("/api/admin/organizations/o", { status: "SUSPENDED" });
  });
});
