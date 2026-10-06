// @vitest-environment jsdom
import type { Organization, OrganizationSettings } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/*
 * Organization settings (EmailBot V2 phase 7): the panel only offers what
 * exists. Email notifications (no outbound mail provider; the worker only
 * logs them) and email retention (nothing deletes emails by age) are not
 * shown, and saving never sends them.
 */

// Hoisted: organization-provider (imported above) loads @/lib/api before this module's body runs.
const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, patch, post: vi.fn() } }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "user-1" }, session: { user: { id: "user-1" } } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SettingsPage } = await import("./settings-page");

const ORG = "11111111-1111-4111-8111-111111111111";
const organization: Organization = {
  id: ORG,
  name: "Acme",
  slug: "acme",
  plan: "FREE",
  status: "ACTIVE",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};
const settings: OrganizationSettings = {
  organizationId: ORG,
  timezone: "America/Lima",
  language: "es",
  autoProcessingEnabled: true,
  processAttachments: true,
  notificationsEnabled: true,
  defaultInboxFilter: "ALL",
  updatedAt: "2026-10-01T00:00:00.000Z"
};

function renderSettings() {
  const context: OrganizationContextValue = {
    me: undefined,
    loading: false,
    error: null,
    memberships: [{ role: "ADMIN", organization }],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization,
    role: "ADMIN",
    can: () => true,
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizationContext.Provider value={context}>
        <SettingsPage />
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  get.mockResolvedValue({ organization, role: "ADMIN", settings });
  patch.mockImplementation(async (_path: string, body: Partial<OrganizationSettings>) => ({ settings: { ...settings, ...body } }));
});

describe("organization settings", () => {
  it("does not offer email notifications nor email retention; the implemented options stay", async () => {
    renderSettings();
    expect(await screen.findByRole("checkbox", { name: /Procesamiento automático/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Guardar adjuntos/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Notificaciones en la aplicación de las reglas/ })).toBeInTheDocument();
    expect(screen.queryByText(/Notificaciones por correo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/por email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retención/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("saving sends only the visible settings (never emailNotificationsEnabled nor emailRetentionDays)", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Procesamiento automático/ }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar configuración" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/organizations/current/settings");
    expect(body).toEqual({
      timezone: "America/Lima",
      language: "es",
      autoProcessingEnabled: false,
      processAttachments: true,
      notificationsEnabled: true,
      defaultInboxFilter: "ALL"
    });
    expect(body).not.toHaveProperty("emailNotificationsEnabled");
    expect(body).not.toHaveProperty("emailRetentionDays");
  });
});
