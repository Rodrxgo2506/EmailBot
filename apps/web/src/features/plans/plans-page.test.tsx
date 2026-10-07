// @vitest-environment jsdom
import type { CommercialPlan, Organization, OrganizationPlanOverview } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";
import { PLAN_CATALOG } from "@/test/plan-catalog-fixture";

/*
 * Commercial V1: public pricing page /planes. The catalog comes from
 * GET /api/plans (database catalog); with a session, the organization's plan
 * is recognized. Nothing on the page charges, activates or records anything.
 */

// Hoisted: organization-provider (imported above) loads @/lib/api before this module's body runs.
const { get, post, patch, auth } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  auth: { session: null as { user: { id: string } } | null }
}));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post, patch } }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ session: auth.session, user: auth.session?.user ?? null, loading: false }) }));

const { PlansPage } = await import("./plans-page");

const ORG = "11111111-1111-4111-8111-111111111111";
const organization: Organization = { id: ORG, name: "Acme", slug: "acme", plan: "PRO", status: "ACTIVE", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

function overview(plan: CommercialPlan | "FREE" | null): OrganizationPlanOverview {
  const effective = plan === "FREE" ? "BASIC" : plan;
  const entry = PLAN_CATALOG.find((item) => item.code === (effective ?? "BASIC"));
  return {
    subscription: null,
    usage: { EMAIL_ACCOUNTS: 0, RULES: 0, BOTS: 0, MONTHLY_EMAILS: 0, MEMBERS: 1, CUSTOMERS: 0, STORAGE_BYTES: 0 },
    entitlements: {
      plan,
      effectivePlan: effective,
      access: plan === null ? "NONE" : plan === "FREE" ? "LEGACY" : "SUBSCRIPTION",
      subscriptionStatus: plan === null || plan === "FREE" ? null : "ACTIVE",
      limits: entry?.limits ?? PLAN_CATALOG[0]!.limits,
      features: entry?.features ?? PLAN_CATALOG[0]!.features
    }
  };
}

let planOverview: OrganizationPlanOverview;

function renderPage({ withOrganization = true }: { withOrganization?: boolean } = {}) {
  const context: OrganizationContextValue = {
    me: undefined,
    loading: false,
    error: null,
    memberships: withOrganization ? [{ role: "VIEWER", organization }] : [],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization: auth.session && withOrganization ? organization : null,
    role: auth.session && withOrganization ? "VIEWER" : null,
    can: () => true,
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizationContext.Provider value={context}>
        <MemoryRouter initialEntries={["/planes"]}>
          <PlansPage />
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

const card = (name: string) => screen.getByRole("group", { name });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  auth.session = null;
  planOverview = overview("PRO");
  get.mockImplementation(async (path: string) => {
    if (path === "/api/plans") return { items: PLAN_CATALOG };
    if (path === "/api/organizations/current/plan") return planOverview;
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("/planes without a session", () => {
  it("shows the three catalog plans with their PEN prices, Pro highlighted, and the comparison", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Elige el plan que mejor se adapte a tu operación" })).toBeInTheDocument();
    await screen.findByRole("group", { name: "Básico" });

    expect(within(card("Básico")).getByText("S/ 19.90")).toBeInTheDocument();
    expect(within(card("Pro")).getByText("S/ 39.90")).toBeInTheDocument();
    expect(within(card("Business")).getByText("S/ 89.90")).toBeInTheDocument();
    expect(within(card("Pro")).getByText("Más elegido")).toBeInTheDocument();
    expect(within(card("Pro")).getByText(/IGV incluido · o S\/ 399.00 al año/)).toBeInTheDocument();

    const pro = within(card("Pro")).getByRole("list", { name: "Qué incluye Pro" });
    expect(pro).toHaveTextContent("5 cuentas de correo");
    expect(pro).toHaveTextContent("15,000 correos procesados al mes");
    expect(pro).toHaveTextContent("5 GB de almacenamiento de adjuntos");
    expect(within(card("Básico")).getByRole("list", { name: "Qué incluye Básico" })).toHaveTextContent("Microsoft (Outlook / 365) (no incluido)");

    const table = screen.getByRole("table", { name: "Comparación de planes" });
    expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["Característica", "Básico", "Pro", "Business"]);
    expect([...table.querySelectorAll("th[scope=colgroup]")].map((cell) => cell.textContent)).toEqual([
      "Correo",
      "Automatización",
      "Clientes y portal",
      "Equipo",
      "Almacenamiento"
    ]);
    expect(within(table).getByRole("rowheader", { name: "Cuentas de correo" }).parentElement).toHaveTextContent("Cuentas de correo2520");
    expect(screen.queryByText(/\$|USD|Gratis/)).not.toBeInTheDocument();
  });

  it("every call to action leads to the existing sign-up; the header offers sign in / sign up", async () => {
    renderPage();
    await screen.findByRole("group", { name: "Pro" });
    for (const name of ["Básico", "Pro", "Business"]) {
      expect(within(card(name)).getByRole("link", { name: "Crear cuenta" })).toHaveAttribute("href", "/register");
    }
    const nav = screen.getByRole("navigation", { name: "Cuenta" });
    expect(within(nav).getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute("href", "/login");
    expect(within(nav).getByRole("link", { name: "Crear cuenta" })).toHaveAttribute("href", "/register");
    expect(get).not.toHaveBeenCalledWith("/api/organizations/current/plan");
  });
});

describe("/planes with a session", () => {
  beforeEach(() => {
    auth.session = { user: { id: "user-1" } };
  });

  it.each([
    ["BASIC", "Básico"],
    ["PRO", "Pro"],
    ["BUSINESS", "Business"]
  ] as const)("organization on %s: its card says so and cannot be chosen", async (plan, name) => {
    planOverview = overview(plan);
    renderPage();
    await screen.findByRole("group", { name });
    expect(within(card(name)).getByText("Plan actual")).toBeInTheDocument();
    expect(within(card(name)).getByRole("button", { name: "Tu plan actual" })).toBeDisabled();
    expect(screen.getAllByText("Plan actual")).toHaveLength(1);
  });

  it("Pro organization: Básico is below it, Business is the upgrade, and upgrading only informs (no payment)", async () => {
    renderPage();
    await screen.findByRole("group", { name: "Business" });
    expect(screen.getByRole("link", { name: "Ir al panel" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "Iniciar sesión" })).not.toBeInTheDocument();
    expect(within(card("Básico")).getByRole("button", { name: "Incluido en tu plan" })).toBeDisabled();
    fireEvent.click(within(card("Business")).getByRole("button", { name: "Mejorar a Business" }));

    const dialog = await screen.findByRole("dialog", { name: "Contratación en línea próximamente" });
    expect(dialog).toHaveTextContent("no se realiza ningún cobro");
    expect(dialog).toHaveTextContent("¿Te interesa el plan Business?");
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/api/plans", "/api/organizations/current/plan"]));
    expect(get.mock.calls.every(([path]) => !/culqi|checkout|payment/i.test(String(path)))).toBe(true);
  });

  it("a legacy FREE organization is recognized on Básico (the plan whose limits apply)", async () => {
    planOverview = overview("FREE");
    renderPage();
    await screen.findByRole("group", { name: "Básico" });
    expect(within(card("Básico")).getByRole("button", { name: "Tu plan actual" })).toBeDisabled();
  });

  it("without an active subscription every plan can be chosen (and only informs)", async () => {
    planOverview = overview(null);
    renderPage();
    await screen.findByRole("group", { name: "Pro" });
    expect(screen.queryByText("Plan actual")).not.toBeInTheDocument();
    for (const name of ["Básico", "Pro", "Business"]) expect(within(card(name)).getByRole("button", { name: `Elegir ${name}` })).toBeEnabled();
  });
});
