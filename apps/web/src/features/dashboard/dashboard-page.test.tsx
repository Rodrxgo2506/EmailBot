// @vitest-environment jsdom
import type { Organization } from "@emailbot/types";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/*
 * Dashboard empty state (EmailBot V2 phase 7): Gmail notifies new mail but
 * Microsoft is polled, so the text must hold for every provider and never
 * promise "real time".
 */

let activeAccounts = 1;
vi.mock("@/providers/auth-provider", () => ({ useUserDisplayName: () => "Ana Pérez" }));
vi.mock("@/features/inbox/stats", () => ({
  useInboxStats: () => ({ isPending: false, error: null, data: { total: 0, unread: 0, important: 0, recent: [] } })
}));
vi.mock("@/features/accounts/api", () => ({
  useEmailAccounts: () => ({
    isPending: false,
    data: Array.from({ length: activeAccounts }, (_, index) => ({ id: `a${index}`, status: "ACTIVE", emailAddress: `inbox${index}@acme.test` }))
  })
}));
vi.mock("@/features/rules/api", () => ({ useRules: () => ({ isPending: false, data: [{ id: "r1", enabled: true }] }) }));
vi.mock("@/features/categories/api", () => ({ useCategories: () => ({ data: [] }) }));

const { DashboardPage } = await import("./dashboard-page");

const organization: Organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme",
  plan: "FREE",
  status: "ACTIVE",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};

function renderDashboard() {
  const context: OrganizationContextValue = {
    me: undefined,
    loading: false,
    error: null,
    memberships: [{ role: "OWNER", organization }],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization,
    role: "OWNER",
    can: () => true,
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
  return render(
    <OrganizationContext.Provider value={context}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </OrganizationContext.Provider>
  );
}

describe("dashboard empty state", () => {
  it("with a connected account: processed emails appear automatically (no real-time promise)", () => {
    activeAccounts = 1;
    const { container } = renderDashboard();
    expect(screen.getByText("Todavía no hay correos procesados")).toBeInTheDocument();
    expect(screen.getByText("Los correos procesados aparecerán aquí automáticamente.")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/tiempo real|instantáneamente/i);
  });

  it("without accounts it still asks to connect one", () => {
    activeAccounts = 0;
    renderDashboard();
    expect(screen.getByText("Conecta una cuenta de correo y crea una regla para empezar.")).toBeInTheDocument();
  });
});
