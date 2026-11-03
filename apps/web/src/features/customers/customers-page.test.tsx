// @vitest-environment jsdom
import { hasPermission, type Customer, type Organization, type OrganizationRole, type Paginated, type Permission } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/* Customers list: "three dots" row menu -> "Eliminar cliente" -> confirmation -> DELETE /api/customers/:id. */

// Hoisted: organization-provider (imported above) loads @/lib/api before this module's body runs.
const { get, del } = vi.hoisted(() => ({ get: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, patch: vi.fn(), post: vi.fn(), delete: del } }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "user-1" }, session: { user: { id: "user-1" } } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { CustomersPage } = await import("./customers-page");

const ORG = "11111111-1111-4111-8111-111111111111";
const organization: Organization = { id: ORG, name: "Acme", slug: "acme", plan: "PRO", status: "ACTIVE", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

const makeCustomer = (id: string, displayName: string): Customer => ({
  id,
  organizationId: ORG,
  displayName,
  status: "ACTIVE",
  externalRef: null,
  notes: null,
  createdBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
});

const ABELITO = makeCustomer("33333333-3333-4333-8333-333333333331", "Abelito CLIENTE");
const ANTONY = makeCustomer("33333333-3333-4333-8333-333333333332", "Antony CLIENTE");
let listed: Customer[];

function renderPage(role: OrganizationRole = "OWNER") {
  const context: OrganizationContextValue = {
    me: undefined,
    loading: false,
    error: null,
    memberships: [{ role, organization }],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization,
    role,
    can: (permission: Permission) => hasPermission(role, permission),
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizationContext.Provider value={context}>
        <MemoryRouter initialEntries={["/customers"]}>
          <Routes>
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/customers/:customerId" element={<p>detalle</p>} />
          </Routes>
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

const openMenu = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name: `Acciones de ${name}` }));
  return screen.findByRole("menu", { name: `Acciones de ${name}` });
};

beforeEach(() => {
  get.mockReset();
  del.mockReset();
  listed = [ABELITO, ANTONY];
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/customers")) return { items: listed, page: 1, pageSize: 25, total: listed.length } satisfies Paginated<Customer>;
    throw new Error(`unexpected GET ${url}`);
  });
});

describe("customers page: delete a customer", () => {
  it("the row menu offers «Eliminar cliente» as a danger action; opening it does not navigate or delete", async () => {
    renderPage("OWNER");
    const menu = await openMenu("Abelito CLIENTE");
    const item = within(menu).getByRole("menuitem", { name: "Eliminar cliente" });

    expect(item.className).toContain("text-destructive");
    expect(screen.queryByText("detalle")).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("choosing it asks for confirmation naming the customer; Cancelar deletes nothing", async () => {
    renderPage("ADMIN");
    fireEvent.click(within(await openMenu("Abelito CLIENTE")).getByRole("menuitem", { name: "Eliminar cliente" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¿Eliminar a «Abelito CLIENTE»?")).toBeTruthy();
    expect(within(dialog).getByText(/Se conservan sus correos entregados, su historial y la auditoría/)).toBeTruthy();
    // The initial focus is on the safe action: an accidental Enter cancels.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancelar"));

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText("Abelito CLIENTE")).toBeTruthy();
    // The focus goes back to the row's menu button (not lost on the page body).
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Acciones de Abelito CLIENTE"));
  });

  it("Escape in the menu closes it and keeps the focus on its button", async () => {
    renderPage("OWNER");
    const menu = await openMenu("Abelito CLIENTE");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Acciones de Abelito CLIENTE");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirming deletes exactly that customer and refreshes the list without it", async () => {
    del.mockImplementation(async () => {
      listed = [ANTONY];
      return undefined;
    });
    renderPage("OWNER");
    fireEvent.click(within(await openMenu("Abelito CLIENTE")).getByRole("menuitem", { name: "Eliminar cliente" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar cliente" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(`/api/customers/${ABELITO.id}`));
    expect(del).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Abelito CLIENTE")).toBeNull());
    expect(screen.getByText("Antony CLIENTE")).toBeTruthy();
    // Its row is gone: the focus lands on the search box instead of the page body.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Buscar clientes");
  });

  it("an API error stays in the dialog and the customer stays listed", async () => {
    del.mockRejectedValue(new ApiError(403, "INSUFFICIENT_ROLE", "Your role does not allow this action"));
    renderPage("OWNER");
    fireEvent.click(within(await openMenu("Antony CLIENTE")).getByRole("menuitem", { name: "Eliminar cliente" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Eliminar cliente" }));

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Antony CLIENTE")).toBeTruthy();
  });

  it("OPERATOR and VIEWER see no row menu (customers:delete is OWNER / ADMIN only)", async () => {
    for (const role of ["OPERATOR", "VIEWER"] as const) {
      const view = renderPage(role);
      expect(await screen.findByText("Abelito CLIENTE")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Acciones de/ })).toBeNull();
      view.unmount();
    }
  });

  it("the row link still opens the customer", async () => {
    renderPage("OWNER");
    fireEvent.click(await screen.findByText("Abelito CLIENTE"));
    expect(await screen.findByText("detalle")).toBeTruthy();
  });
});
