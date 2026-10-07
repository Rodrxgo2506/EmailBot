// @vitest-environment jsdom
import type { Organization, OrganizationPlanOverview, OrganizationSettings } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";
import { PLAN_CATALOG } from "@/test/plan-catalog-fixture";

/*
 * Organization settings (EmailBot V2 phase 7): the panel only offers what
 * exists. Email notifications (no outbound mail provider; the worker only
 * logs them) and email retention (nothing deletes emails by age) are not
 * shown, and saving never sends them.
 */

// Hoisted: organization-provider (imported above) loads @/lib/api before this module's body runs.
const { get, patch, post } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, patch, post } }));
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

const GB = 1024 ** 3;
const basicOverview = (overrides: Partial<OrganizationPlanOverview["usage"]> = {}, plan: Organization["plan"] = "BASIC"): OrganizationPlanOverview => ({
  subscription:
    plan === "FREE"
      ? null
      : {
          status: "ACTIVE",
          plan: "BASIC",
          billingPeriod: "MONTHLY",
          currency: "PEN",
          amount: "19.90",
          paymentMethod: "TRANSFER",
          startedAt: "2026-10-06T05:00:00.000Z",
          currentPeriodStart: "2026-10-06T05:00:00.000Z",
          currentPeriodEnd: "2099-11-06T05:00:00.000Z",
          canceledAt: null,
          suspendedAt: null,
          expiredAt: null
        },
  entitlements: {
    plan,
    effectivePlan: "BASIC",
    access: plan === "FREE" ? "LEGACY" : "SUBSCRIPTION",
    subscriptionStatus: plan === "FREE" ? null : "ACTIVE",
    limits: { EMAIL_ACCOUNTS: 25, RULES: 10, BOTS: 2, MONTHLY_EMAILS: 2000, MEMBERS: 2, CUSTOMERS: 500, STORAGE_BYTES: GB, RETENTION_DAYS: 30 },
    features: { GMAIL: true, MICROSOFT: false, ADVANCED_STATS: false, PORTAL: false, API: false, PRIORITY_SUPPORT: false }
  },
  usage: { EMAIL_ACCOUNTS: 1, RULES: 3, BOTS: 0, MONTHLY_EMAILS: 120, MEMBERS: 1, CUSTOMERS: 0, STORAGE_BYTES: 5 * 1024 ** 2, ...overrides }
});

let currentOrganization: Organization = organization;
let planOverview: OrganizationPlanOverview = basicOverview({}, "FREE");

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
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  currentOrganization = organization;
  planOverview = basicOverview({}, "FREE");
  get.mockImplementation(async (path: string) =>
    path === "/api/organizations/current/plan"
      ? planOverview
      : path === "/api/plans"
        ? { items: PLAN_CATALOG }
        : { organization: currentOrganization, role: "ADMIN", settings }
  );
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

describe("organization plan (Commercial V1)", () => {
  it("shows the commercial name of the plan, its usage and only the features that exist", async () => {
    currentOrganization = { ...organization, plan: "BASIC" };
    planOverview = basicOverview();
    renderSettings();
    expect(await screen.findByText("Plan Básico · Activa")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Plan Básico" })).toBeInTheDocument();
    expect(screen.getByText("Cuentas de correo").nextSibling).toHaveTextContent("1 / 25");
    expect(screen.getByText("Almacenamiento de adjuntos").nextSibling).toHaveTextContent("5 MB / 1 GB");
    const features = screen.getByRole("list", { name: "Funcionalidades del plan" });
    expect(features).toHaveTextContent("Gmail (incluido)");
    expect(features).toHaveTextContent("Microsoft (Outlook / 365) (no incluido)");
    expect(features).toHaveTextContent("Portal de clientes (no incluido)");
    // Not presented as if they existed: no public API, advanced statistics, support tiers or retention yet.
    expect(features).not.toHaveTextContent(/API|Estadísticas|Soporte/);
    expect(screen.queryByText(/Retención/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/FREE|Free/)).not.toBeInTheDocument();
  });

  it("a legacy FREE organization is told that the Básico limits apply", async () => {
    renderSettings();
    expect(await screen.findByText("Plan Free (legado) · Activa")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Plan Básico" })).toBeInTheDocument();
    expect(screen.getByText(/se aplican los límites del plan Básico/)).toBeInTheDocument();
  });

  it("warns when a limit is reached (nothing is deleted)", async () => {
    currentOrganization = { ...organization, plan: "BASIC" };
    planOverview = basicOverview({ EMAIL_ACCOUNTS: 25, MONTHLY_EMAILS: 2000 });
    renderSettings();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Alcanzaste el límite de tu plan en: cuentas de correo, correos este mes");
    expect(status).toHaveTextContent("Lo existente se conserva");
  });

  it("without an active subscription: no plan, no limits shown as granted, and nothing free is offered", async () => {
    currentOrganization = { ...organization, plan: null };
    planOverview = {
      ...basicOverview(),
      subscription: null,
      entitlements: { ...basicOverview().entitlements, plan: null, effectivePlan: null, access: "NONE", subscriptionStatus: null }
    };
    renderSettings();
    expect(await screen.findByText("Sin plan · Activa")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sin suscripción activa" })).toBeInTheDocument();
    expect(screen.getByText(/EmailBot es un servicio de pago/)).toBeInTheDocument();
    expect(screen.queryByText("Cuentas de correo")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Funcionalidades del plan" })).not.toBeInTheDocument();
    expect(screen.queryByText(/gratis|gratuit/i)).not.toBeInTheDocument();
  });
});

describe("Mi plan: plans above the current one (catalog GET /api/plans; nothing is charged)", () => {
  const overviewFor = (plan: "PRO" | "BUSINESS"): OrganizationPlanOverview => {
    const base = basicOverview({}, "BASIC");
    const entry = PLAN_CATALOG.find((item) => item.code === plan);
    return {
      ...base,
      entitlements: { ...base.entitlements, plan, effectivePlan: plan, access: "SUBSCRIPTION", limits: entry!.limits, features: entry!.features }
    };
  };
  const upgrades = () =>
    screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Plan "));

  it("Básico: offers Pro and Business with what each adds", async () => {
    currentOrganization = { ...organization, plan: "BASIC" };
    planOverview = basicOverview();
    renderSettings();
    expect(await screen.findByRole("heading", { name: "Mi plan" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Mejorar plan" })).toBeInTheDocument();
    expect(upgrades()).toEqual(["Plan Pro", "Plan Business"]);
    const pro = screen.getByRole("list", { name: "Qué obtienes con Pro" });
    expect(pro).toHaveTextContent("125 cuentas de correo");
    expect(pro).toHaveTextContent("Microsoft (Outlook / 365)");
    expect(pro).toHaveTextContent("Portal de clientes");
    expect(screen.getByText("S/ 39.90")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Comparar planes" })).toHaveAttribute("href", "/planes");
  });

  it("Pro: shows the Pro plan and offers only Business", async () => {
    currentOrganization = { ...organization, plan: "PRO" };
    planOverview = overviewFor("PRO");
    renderSettings();
    expect(await screen.findByRole("heading", { name: "Plan Pro" })).toBeInTheDocument();
    expect(screen.getByText("Cuentas de correo").nextSibling).toHaveTextContent("1 / 125");
    await screen.findByRole("heading", { name: "Mejorar plan" });
    expect(upgrades()).toEqual(["Plan Business"]);
    const business = screen.getByRole("list", { name: "Qué obtienes con Business" });
    expect(business).toHaveTextContent("250 cuentas de correo");
    expect(business).not.toHaveTextContent(/Microsoft|Portal/); // Pro already has them
  });

  it("Business: the most complete plan, no upgrade offered", async () => {
    currentOrganization = { ...organization, plan: "BUSINESS" };
    planOverview = overviewFor("BUSINESS");
    renderSettings();
    expect(await screen.findByRole("heading", { name: "Plan Business" })).toBeInTheDocument();
    expect(screen.getByText("Cuentas de correo").nextSibling).toHaveTextContent("1 / 250");
    expect(await screen.findByText("Actualmente tienes el plan más completo.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mejorar a/ })).not.toBeInTheDocument();
  });

  it("choosing an upgrade only informs: no request, no payment, nothing activated", async () => {
    currentOrganization = { ...organization, plan: "BASIC" };
    planOverview = basicOverview();
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Mejorar a Pro" }));
    expect(await screen.findByRole("dialog", { name: "Contratación en línea próximamente" })).toHaveTextContent("no se realiza ningún cobro");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([path]) => path).every((path) => !/culqi|checkout|payment|subscription/i.test(String(path)))).toBe(true);
  });
});
