// @vitest-environment jsdom
import type {
  AdminActivityItem,
  AdminAuditEntry,
  AdminOrganizationDetail,
  AdminOrganizationSummary,
  AdminStats,
  OffsetPage,
  Paginated
} from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RequirePlatformAdmin } from "@/components/layout/guards";
import { Sidebar } from "@/components/layout/sidebar";
import { ApiError } from "@/lib/api-client";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";
import type { AdminApi } from "./admin-api";
import { AdminApp } from "./admin-app";

/*
 * Platform administration console (EmailBot V2 phase 6). The API is faked:
 * authorization is enforced by the API and the database (apps/api,
 * packages/database); these tests cover what the UI shows and sends.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const stats: AdminStats = {
  totalOrganizations: 12,
  activeOrganizations: 10,
  suspendedOrganizations: 2,
  cancelledOrganizations: 0,
  totalMembers: 30,
  totalBots: 7,
  totalCustomers: 1250,
  totalEmailAccounts: 9,
  activeEmailAccounts: 8,
  totalEmails: 5000,
  totalProcessedEmails: 4800,
  totalDeliveries: 4100
};

const summary = (overrides: Partial<AdminOrganizationSummary> = {}): AdminOrganizationSummary => ({
  id: ORG_A,
  name: "Acme",
  slug: "acme",
  plan: "PRO",
  status: "ACTIVE",
  owner: { userId: "u1", email: "owner@acme.test", fullName: "Ana Owner" },
  membersCount: 3,
  botsCount: 2,
  customersCount: 40,
  emailAccountsCount: 1,
  processedEmailsCount: 321,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  ...overrides
});

const detail = (overrides: Partial<AdminOrganizationDetail> = {}): AdminOrganizationDetail => ({
  ...summary(),
  rulesCount: 5,
  emailsCount: 330,
  deliveriesCount: 300,
  ...overrides
});

const activityItem: AdminActivityItem = {
  id: "act-1",
  organization: { id: ORG_A, name: "Acme" },
  actorType: "USER",
  action: "CREATE",
  entityType: "customer",
  event: "customer.created",
  createdAt: "2026-10-05T09:00:00.000Z"
};

const auditEntry: AdminAuditEntry = {
  id: "aud-1",
  actor: { userId: "root", email: "root@platform.test" },
  action: "organization.suspended",
  targetType: "organization",
  targetId: ORG_A,
  organization: { id: ORG_A, name: "Acme" },
  metadata: { from: "ACTIVE", to: "SUSPENDED" },
  createdAt: "2026-10-05T09:30:00.000Z"
};

const SUB = "77777777-7777-4777-8777-777777777777";
const PRICES = [
  { id: "p1", plan: "BASIC", planName: "Básico", billingPeriod: "MONTHLY", currency: "PEN", amount: "19.90", amountCents: 1990 },
  { id: "p2", plan: "BASIC", planName: "Básico", billingPeriod: "YEARLY", currency: "PEN", amount: "199.00", amountCents: 19900 },
  { id: "p3", plan: "PRO", planName: "Pro", billingPeriod: "MONTHLY", currency: "PEN", amount: "39.90", amountCents: 3990 },
  { id: "p4", plan: "PRO", planName: "Pro", billingPeriod: "YEARLY", currency: "PEN", amount: "399.00", amountCents: 39900 },
  { id: "p5", plan: "BUSINESS", planName: "Business", billingPeriod: "MONTHLY", currency: "PEN", amount: "89.90", amountCents: 8990 },
  { id: "p6", plan: "BUSINESS", planName: "Business", billingPeriod: "YEARLY", currency: "PEN", amount: "899.00", amountCents: 89900 }
];
const activeSubscription = {
  id: SUB,
  status: "ACTIVE",
  plan: "PRO",
  billingPeriod: "MONTHLY",
  currency: "PEN",
  listAmount: "39.90",
  paymentMethod: "YAPE",
  origin: "ADMIN",
  startedAt: "2026-10-06T05:00:00.000Z",
  currentPeriodStart: "2026-10-06T05:00:00.000Z",
  currentPeriodEnd: "2099-11-06T05:00:00.000Z",
  canceledAt: null,
  suspendedAt: null,
  expiredAt: null,
  createdAt: "2026-10-06T05:00:00.000Z",
  updatedAt: "2026-10-06T05:00:00.000Z"
};

const page = <T,>(items: T[], total = items.length): Paginated<T> => ({ items, page: 1, pageSize: 25, total });
const logPage = <T,>(items: T[], hasMore = false): OffsetPage<T> => ({ items, page: 1, pageSize: 25, hasMore });

function fakeApi(overrides: Partial<Record<keyof AdminApi, unknown>> = {}) {
  const base = {
    stats: vi.fn(async () => stats),
    listOrganizations: vi.fn(async () => page([summary(), summary({ id: ORG_B, name: "Beta", slug: "beta", status: "SUSPENDED", plan: "FREE" })])),
    getOrganization: vi.fn(async () => detail()),
    createOrganization: vi.fn(async () => detail({ id: ORG_B, name: "Nueva" })),
    updateOrganization: vi.fn(async (_id: string, patch: { status?: string }) => detail({ status: (patch.status as "ACTIVE") ?? "ACTIVE" })),
    members: vi.fn(async () => [{ userId: "u1", email: "owner@acme.test", fullName: "Ana Owner", role: "OWNER", joinedAt: "2026-10-01T10:00:00.000Z" }]),
    bots: vi.fn(async () => [{ id: "b1", name: "Netflix", slug: "netflix", status: "ACTIVE", rulesCount: 4, activeCustomersCount: 40, deliveriesCount: 300, createdAt: "2026-10-01T10:00:00.000Z" }]),
    customers: vi.fn(async () => page([{ id: "c1", displayName: "Juan Pérez", status: "ACTIVE", bots: ["Netflix"], deliveriesCount: 12, createdAt: "2026-10-01T10:00:00.000Z" }])),
    emailAccounts: vi.fn(async () => [
      {
        id: "e1",
        provider: "GMAIL",
        emailAddress: "inbox@acme.test",
        status: "ACTIVE",
        lastSyncedAt: "2026-10-05T09:59:00.000Z",
        lastErrorCode: null,
        watchExpiresAt: null,
        watchErrorCode: null,
        createdAt: "2026-10-01T10:00:00.000Z"
      }
    ]),
    activity: vi.fn(async () => logPage([activityItem])),
    audit: vi.fn(async () => logPage([auditEntry])),
    planPrices: vi.fn(async () => PRICES),
    subscription: vi.fn(async (): Promise<{ subscriptions: unknown[]; paymentEvents: unknown[] }> => ({ subscriptions: [], paymentEvents: [] })),
    activateSubscription: vi.fn(async () => ({ subscriptionId: SUB, outcome: "ACTIVATED", organization: detail() })),
    subscriptionAction: vi.fn(async () => ({ organization: detail() }))
  };
  // Overrides replace mocks with other mocks: keep the mock types for assertions.
  return { ...base, ...overrides } as typeof base;
}

function renderAdmin(path: string, api = fakeApi()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onSignOut = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/*" element={<AdminApp api={api as unknown as AdminApi} userEmail="root@platform.test" panelAvailable onSignOut={onSignOut} />} />
          <Route path="/" element={<p>Panel</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { api, onSignOut };
}

function organizationContext(overrides: Partial<OrganizationContextValue> = {}): OrganizationContextValue {
  return {
    me: undefined,
    loading: false,
    error: null,
    memberships: [],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization: null,
    role: null,
    can: () => true,
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined),
    ...overrides
  };
}

function withOrganization(value: OrganizationContextValue, children: ReactNode, path = "/") {
  return render(
    <OrganizationContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </OrganizationContext.Provider>
  );
}

describe("route protection", () => {
  const guarded = (
    <Routes>
      <Route
        path="/admin/*"
        element={
          <RequirePlatformAdmin>
            <p>Consola de plataforma</p>
          </RequirePlatformAdmin>
        }
      />
    </Routes>
  );

  it("a normal user who navigates to /admin gets 'Acceso denegado' and no admin content", () => {
    withOrganization(organizationContext({ isPlatformAdmin: false }), guarded, "/admin/organizations");
    expect(screen.getByText("Acceso denegado")).toBeInTheDocument();
    expect(screen.queryByText("Consola de plataforma")).not.toBeInTheDocument();
  });

  it("waits for /api/me before deciding", () => {
    withOrganization(organizationContext({ loading: true, isPlatformAdmin: true }), guarded, "/admin");
    expect(screen.queryByText("Consola de plataforma")).not.toBeInTheDocument();
    expect(screen.queryByText("Acceso denegado")).not.toBeInTheDocument();
  });

  it("a platform admin (with or without an organization) sees the console", () => {
    withOrganization(organizationContext({ isPlatformAdmin: true }), guarded, "/admin");
    expect(screen.getByText("Consola de plataforma")).toBeInTheDocument();
  });

  it("an error loading /api/me is shown instead of the console", () => {
    withOrganization(organizationContext({ error: new Error("boom"), isPlatformAdmin: true }), guarded, "/admin");
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText("Consola de plataforma")).not.toBeInTheDocument();
  });
});

describe("sidebar", () => {
  it("shows 'Administración' only to platform admins", () => {
    const { unmount } = withOrganization(organizationContext({ isPlatformAdmin: false }), <Sidebar />);
    expect(screen.queryByRole("link", { name: /Administración/ })).not.toBeInTheDocument();
    unmount();
    withOrganization(organizationContext({ isPlatformAdmin: true }), <Sidebar />);
    expect(screen.getByRole("link", { name: /Administración/ })).toHaveAttribute("href", "/admin");
  });
});

describe("dashboard", () => {
  it("renders the platform stats, recent activity and quick links", async () => {
    const { api } = renderAdmin("/admin");
    expect(await screen.findByTestId("stat-Organizaciones")).toHaveTextContent("12");
    expect(screen.getByTestId("stat-Clientes")).toHaveTextContent(/1[.\s]?250/);
    expect(screen.getByTestId("stat-Correos procesados")).toHaveTextContent(/4[.\s]?800/);
    const activity = await screen.findByRole("list", { name: "Actividad reciente" });
    expect(within(activity).getByText("Acme")).toBeInTheDocument();
    expect(within(activity).getByText(/customer\.created/)).toBeInTheDocument();
    expect(api.activity).toHaveBeenCalledWith({ page: 1, pageSize: 8 });
    expect(screen.getByRole("link", { name: /Ver organizaciones/ })).toHaveAttribute("href", "/admin/organizations");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: /Auditoría/ })).toHaveAttribute("href", "/admin/audit");
    expect(within(screen.getByRole("navigation", { name: "Administración" })).getAllByRole("link")).toHaveLength(3);
  });

  it("shows the API error when the stats cannot be loaded", async () => {
    renderAdmin("/admin", fakeApi({ stats: vi.fn(async () => Promise.reject(new ApiError(403, "PLATFORM_ADMIN_REQUIRED", "x"))) }));
    expect(await screen.findByText("Esta sección es solo para administradores de la plataforma.")).toBeInTheDocument();
  });

  it("sign out and back to the panel", async () => {
    const { onSignOut } = renderAdmin("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(onSignOut).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: /Volver al panel/ }));
    expect(await screen.findByText("Panel")).toBeInTheDocument();
  });
});

describe("organizations table", () => {
  it("lists organizations with plan, status, owner and counts", async () => {
    renderAdmin("/admin/organizations");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const acme = rows[1] as HTMLElement;
    expect(within(acme).getByRole("link", { name: "Acme" })).toHaveAttribute("href", `/admin/organizations/${ORG_A}`);
    expect(acme).toHaveTextContent("Pro");
    expect(acme).toHaveTextContent("Activa");
    expect(acme).toHaveTextContent("owner@acme.test");
    expect(acme).toHaveTextContent("321");
    expect(within(rows[2] as HTMLElement).getByText("Suspendida")).toBeInTheDocument();
  });

  it("filters by status, plan and sort, and searches with debounce", async () => {
    const { api } = renderAdmin("/admin/organizations");
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "SUSPENDED" } });
    await waitFor(() => expect(api.listOrganizations).toHaveBeenLastCalledWith(expect.objectContaining({ status: "SUSPENDED", page: 1 })));
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "BUSINESS" } });
    await waitFor(() => expect(api.listOrganizations).toHaveBeenLastCalledWith(expect.objectContaining({ plan: "BUSINESS" })));
    fireEvent.change(screen.getByLabelText("Orden"), { target: { value: "name_asc" } });
    await waitFor(() => expect(api.listOrganizations).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "name_asc" })));
    fireEvent.change(screen.getByLabelText("Buscar organizaciones"), { target: { value: "acme" } });
    await waitFor(() => expect(api.listOrganizations).toHaveBeenLastCalledWith(expect.objectContaining({ search: "acme", page: 1 })), { timeout: 2000 });
  });

  it("paginates", async () => {
    const api = fakeApi({ listOrganizations: vi.fn(async () => page([summary()], 60)) });
    renderAdmin("/admin/organizations", api);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente" }));
    await waitFor(() => expect(api.listOrganizations).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it("empty and filtered-empty states", async () => {
    const api = fakeApi({ listOrganizations: vi.fn(async () => page([])) });
    renderAdmin("/admin/organizations", api);
    expect(await screen.findByText("Sin organizaciones")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "CANCELLED" } });
    expect(await screen.findByText("Sin resultados")).toBeInTheDocument();
  });

  it("shows a loading state while the list loads", async () => {
    renderAdmin("/admin/organizations", fakeApi({ listOrganizations: vi.fn(() => new Promise(() => undefined)) }));
    expect(await screen.findByLabelText("Cargando")).toBeInTheDocument();
  });

  it("suspend: explains the effect, PATCHes status SUSPENDED after confirming and refreshes the list", async () => {
    const { api } = renderAdmin("/admin/organizations");
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Suspender Acme" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¿Suspender organización?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("dejará de procesar correos nuevos");
    expect(dialog).toHaveTextContent("No se elimina ningún dato");
    const calls = api.listOrganizations.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));
    await waitFor(() => expect(api.updateOrganization).toHaveBeenCalledWith(ORG_A, { status: "SUSPENDED" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(api.listOrganizations.mock.calls.length).toBeGreaterThan(calls));
  });

  it("cancelling the confirmation sends nothing", async () => {
    const { api } = renderAdmin("/admin/organizations");
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Suspender Acme" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.updateOrganization).not.toHaveBeenCalled();
  });

  it("reactivate: a suspended organization offers 'Reactivar' and PATCHes status ACTIVE", async () => {
    const { api } = renderAdmin("/admin/organizations");
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Reactivar Beta" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¿Reactivar organización?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reactivar" }));
    await waitFor(() => expect(api.updateOrganization).toHaveBeenCalledWith(ORG_B, { status: "ACTIVE" }));
  });

  it("a failed suspension shows the API error inside the dialog", async () => {
    const api = fakeApi({ updateOrganization: vi.fn(async () => Promise.reject(new ApiError(403, "PLATFORM_ADMIN_REQUIRED", "x"))) });
    renderAdmin("/admin/organizations", api);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Suspender Acme" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("solo para administradores de la plataforma");
  });

  it("Commercial V1.1: the plan is never edited on the organization (it comes from a subscription)", async () => {
    const { api } = renderAdmin("/admin/organizations", fakeApi({
      listOrganizations: vi.fn(async () => page([summary(), summary({ id: ORG_B, name: "Beta", slug: "beta", plan: "FREE" }), summary({ id: SUB, name: "Gamma", slug: "gamma", plan: null })]))
    }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Free (legado)")).toBeInTheDocument();
    expect(within(table).getByText("Sin plan")).toBeInTheDocument();
    // The filter still finds legacy organizations.
    expect(within(screen.getByLabelText("Plan")).getByRole("option", { name: "Free (legado)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Editar plan/ })).not.toBeInTheDocument();
    expect(api.updateOrganization).not.toHaveBeenCalled();
  });

  it("create: validates, sends name and owner e-mail (no plan), then opens the new organization", async () => {
    const { api } = renderAdmin("/admin/organizations");
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: /Nueva organización/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear organización" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("entre 2 y 120");
    fireEvent.change(within(dialog).getByLabelText("Nombre de la empresa"), { target: { value: " Nueva " } });
    fireEvent.change(within(dialog).getByLabelText("Correo del propietario"), { target: { value: "boss@nueva.test" } });
    expect(within(dialog).queryByLabelText("Plan")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Se crea sin plan ni acceso al producto/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear organización" }));
    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith({ name: "Nueva", ownerEmail: "boss@nueva.test" }));
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(api.getOrganization).toHaveBeenCalled();
  });

  it("create: an unknown owner shows a clear message", async () => {
    const api = fakeApi({ createOrganization: vi.fn(async () => Promise.reject(new ApiError(422, "OWNER_NOT_FOUND", "x"))) });
    renderAdmin("/admin/organizations", api);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: /Nueva organización/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nombre de la empresa"), { target: { value: "Nueva" } });
    fireEvent.change(within(dialog).getByLabelText("Correo del propietario"), { target: { value: "ghost@nueva.test" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear organización" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("No existe un usuario con ese correo confirmado");
  });
});

describe("organization detail", () => {
  it("shows summary, stats and every metadata section, without e-mail content", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    // Owner in the summary and in the members section.
    expect(screen.getAllByText("Ana Owner")).toHaveLength(2);
    expect(await screen.findByText("Netflix", { selector: "p" })).toBeInTheDocument();
    expect(await screen.findByText("Juan Pérez")).toBeInTheDocument();
    expect(await screen.findByText("inbox@acme.test")).toBeInTheDocument();
    expect(await screen.findByText(/inactivo \(polling\)/)).toBeInTheDocument();
    expect(await screen.findByText("Organización suspendida")).toBeInTheDocument();
    expect(screen.getByText(/ACTIVE → SUSPENDED/)).toBeInTheDocument();
    for (const fn of [api.getOrganization, api.members, api.bots, api.emailAccounts]) expect(fn).toHaveBeenCalledWith(ORG_A);
    expect(api.customers).toHaveBeenCalledWith(ORG_A, 1, 25);
    expect(api.activity).toHaveBeenCalledWith({ organizationId: ORG_A, page: 1, pageSize: 25 });
    expect(api.audit).toHaveBeenCalledWith({ organizationId: ORG_A, page: 1, pageSize: 25 });
  });

  it("suspends from the detail page", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "Suspender" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));
    await waitFor(() => expect(api.updateOrganization).toHaveBeenCalledWith(ORG_A, { status: "SUSPENDED" }));
  });

  it("cancel: an explicit confirmation PATCHes status CANCELLED", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar organización" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¿Cancelar organización?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("mismos efectos que una suspensión");
    expect(dialog).toHaveTextContent("No se elimina ningún dato");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar organización" }));
    await waitFor(() => expect(api.updateOrganization).toHaveBeenCalledWith(ORG_A, { status: "CANCELLED" }));
  });

  it("dismissing the cancel confirmation sends nothing", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar organización" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.updateOrganization).not.toHaveBeenCalled();
  });

  it("a cancelled organization offers 'Reactivar' and no cancellation", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`, fakeApi({ getOrganization: vi.fn(async () => detail({ status: "CANCELLED" })) }));
    const reactivate = await screen.findByRole("button", { name: "Reactivar" });
    expect(screen.queryByRole("button", { name: "Cancelar organización" })).not.toBeInTheDocument();
    fireEvent.click(reactivate);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reactivar" }));
    await waitFor(() => expect(api.updateOrganization).toHaveBeenCalledWith(ORG_A, { status: "ACTIVE" }));
  });

  it("a status change refreshes the activity and the platform audit", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "Suspender" }));
    await waitFor(() => expect(api.activity).toHaveBeenCalledTimes(1));
    const audits = api.audit.mock.calls.length;
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender" }));
    await waitFor(() => expect(api.updateOrganization).toHaveBeenCalled());
    await waitFor(() => expect(api.activity).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.audit.mock.calls.length).toBeGreaterThan(audits));
  });

  it("a manual payment (transfer) activates the subscription with the list price and Lima dates, then refreshes", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    expect(await screen.findByText("Sin suscripción activa. Registra el pago para activarla.")).toBeInTheDocument();
    await waitFor(() => expect(api.activity).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Activar suscripción" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Importe pagado (S/)")).toHaveValue("19.90"));
    expect(within(within(dialog).getByLabelText("Método de pago")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Yape",
      "Efectivo",
      "Transferencia",
      "Otro pago manual"
    ]);
    fireEvent.change(within(dialog).getByLabelText("Plan"), { target: { value: "PRO" } });
    expect(within(dialog).getByLabelText("Importe pagado (S/)")).toHaveValue("39.90");
    fireEvent.change(within(dialog).getByLabelText("Método de pago"), { target: { value: "TRANSFER" } });
    fireEvent.change(within(dialog).getByLabelText("Inicio"), { target: { value: "2026-10-06" } });
    expect(within(dialog).getByLabelText("Vencimiento")).toHaveValue("2026-11-06");
    fireEvent.change(within(dialog).getByLabelText("Referencia del pago (opcional)"), { target: { value: " BCP-123 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Activar suscripción" }));
    await waitFor(() =>
      expect(api.activateSubscription).toHaveBeenCalledWith(ORG_A, {
        plan: "PRO",
        billingPeriod: "MONTHLY",
        paymentMethod: "TRANSFER",
        amount: "39.90",
        periodStart: "2026-10-06T00:00:00-05:00",
        periodEnd: "2026-11-06T00:00:00-05:00",
        reference: "BCP-123"
      })
    );
    // Refreshed after the activation: subscription, audit and activity are fetched again.
    await waitFor(() => expect(api.subscription.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(api.activity.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("an invalid amount is caught before calling the API", async () => {
    const { api } = renderAdmin(`/admin/organizations/${ORG_A}`);
    await screen.findByText("Sin suscripción activa. Registra el pago para activarla.");
    fireEvent.click(screen.getByRole("button", { name: "Activar suscripción" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Importe pagado (S/)")).toHaveValue("19.90"));
    fireEvent.change(within(dialog).getByLabelText("Importe pagado (S/)"), { target: { value: "39,90" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Activar suscripción" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Indica el importe pagado");
    expect(api.activateSubscription).not.toHaveBeenCalled();
  });

  it("an active subscription is shown with its actions; suspending goes through the API after confirmation", async () => {
    const api = fakeApi({
      subscription: vi.fn(async () => ({
        subscriptions: [activeSubscription],
        paymentEvents: [
          { id: "e1", subscriptionId: SUB, eventType: "payment.manual", paymentMethod: "YAPE", amount: "39.90", currency: "PEN", status: "PROCESSED", reference: "yape:OP-9", note: "Pago de octubre", occurredAt: "2026-10-06T15:00:00.000Z", processedAt: "2026-10-06T15:00:00.000Z" }
        ]
      }))
    });
    renderAdmin(`/admin/organizations/${ORG_A}`, api);
    expect(await screen.findByText("Pro · Mensual · S/ 39.90")).toBeInTheDocument();
    expect(screen.getByText("yape:OP-9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar pago" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reactivar suscripción" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Suspender suscripción" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/No se borra ningún dato/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspender suscripción" }));
    await waitFor(() => expect(api.subscriptionAction).toHaveBeenCalledWith(SUB, "suspend", undefined));
  });

  it("an unknown organization shows 'Organización no encontrada'", async () => {
    renderAdmin(`/admin/organizations/${ORG_B}`, fakeApi({ getOrganization: vi.fn(async () => Promise.reject(new ApiError(404, "NOT_FOUND", "Organization not found"))) }));
    expect(await screen.findByText("Organización no encontrada")).toBeInTheDocument();
  });

  it("empty sections", async () => {
    renderAdmin(`/admin/organizations/${ORG_A}`, fakeApi({ bots: vi.fn(async () => []), customers: vi.fn(async () => page([])), emailAccounts: vi.fn(async () => []) }));
    expect(await screen.findByText("Sin bots.")).toBeInTheDocument();
    expect(await screen.findByText("Sin clientes.")).toBeInTheDocument();
    expect(await screen.findByText("Sin cuentas conectadas.")).toBeInTheDocument();
  });
});

describe("platform audit page", () => {
  it("lists platform actions with actor and organization, and pages forward", async () => {
    const api = fakeApi({ audit: vi.fn(async () => logPage([auditEntry], true)) });
    renderAdmin("/admin/audit", api);
    expect(await screen.findByText("Organización suspendida")).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).getByText("root@platform.test")).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "Acme" })).toHaveAttribute("href", `/admin/organizations/${ORG_A}`);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(api.audit).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 }));
  });

  it("an entry of a deleted organization says 'Organización eliminada' (no link); other entries without organization say 'Sin organización'", async () => {
    const deleted: AdminAuditEntry = { ...auditEntry, id: "aud-2", organization: null };
    const platformWide: AdminAuditEntry = { ...auditEntry, id: "aud-3", organization: null, targetType: "platform", targetId: null, metadata: {} };
    renderAdmin("/admin/audit", fakeApi({ audit: vi.fn(async () => logPage([deleted, platformWide])) }));
    const main = await screen.findByRole("main");
    expect(await within(main).findByText("Organización eliminada")).toBeInTheDocument();
    expect(within(main).getByText(/Sin organización/)).toBeInTheDocument();
    expect(within(main).queryByRole("link", { name: "Acme" })).not.toBeInTheDocument();
  });

  it("empty state", async () => {
    renderAdmin("/admin/audit", fakeApi({ audit: vi.fn(async () => logPage([])) }));
    expect(await screen.findByText("Sin registros")).toBeInTheDocument();
  });
});
