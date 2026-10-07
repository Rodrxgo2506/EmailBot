// @vitest-environment jsdom
import type { EmailAccount, EmailProviderAvailability, Organization } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/*
 * F8-A block B: the accounts page only offers the providers the server can
 * connect (GET /api/email-accounts/providers). Microsoft appears only when it
 * is configured (B-1); "Agregar IMAP" never appears while IMAP is unavailable
 * (B-2); existing accounts of any provider can still be managed.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { AccountsPage } = await import("./accounts-page");

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

const account = (overrides: Partial<EmailAccount>): EmailAccount => ({
  id: "acc-1",
  organizationId: ORG,
  provider: "GMAIL",
  status: "ACTIVE",
  emailAddress: "buzon@acme.test",
  displayName: null,
  lastSyncedAt: "2026-10-06T00:00:00.000Z",
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

let providers: EmailProviderAvailability | Error;
let accounts: EmailAccount[];
/** Commercial V1: does the organization's plan include Microsoft (PRO / BUSINESS)? */
let microsoftInPlan: boolean;
/** Commercial V1.1: does the organization have an active subscription? */
let subscribed: boolean;

const planOverview = () => ({
  entitlements: {
    plan: subscribed ? (microsoftInPlan ? "PRO" : "BASIC") : null,
    effectivePlan: subscribed ? (microsoftInPlan ? "PRO" : "BASIC") : null,
    access: subscribed ? "SUBSCRIPTION" : "NONE",
    subscriptionStatus: subscribed ? "ACTIVE" : null,
    limits: {},
    features: subscribed
      ? { GMAIL: true, MICROSOFT: microsoftInPlan, ADVANCED_STATS: microsoftInPlan, PORTAL: microsoftInPlan, API: false, PRIORITY_SUPPORT: microsoftInPlan }
      : { GMAIL: false, MICROSOFT: false, ADVANCED_STATS: false, PORTAL: false, API: false, PRIORITY_SUPPORT: false }
  },
  usage: {},
  subscription: null
});

beforeEach(() => {
  get.mockReset();
  accounts = [];
  microsoftInPlan = true;
  subscribed = true;
  get.mockImplementation(async (path: string) => {
    if (path === "/api/organizations/current/plan") return planOverview();
    if (path === "/api/email-accounts/providers") {
      if (providers instanceof Error) throw providers;
      return { providers };
    }
    if (path === "/api/email-accounts") return { items: accounts };
    throw new Error(`unexpected GET ${path}`);
  });
});

function renderPage(role: OrganizationContextValue["role"] = "OWNER", entry = "/accounts") {
  const context: OrganizationContextValue = {
    me: undefined,
    loading: false,
    error: null,
    memberships: [{ role: role ?? "OWNER", organization }],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization,
    role,
    can: (permission) => role === "OWNER" || (role === "VIEWER" && permission.endsWith(":read")),
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizationContext.Provider value={context}>
        <MemoryRouter initialEntries={[entry]}>
          <AccountsPage />
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

describe("connect options follow the server's provider availability", () => {
  it("Microsoft NOT configured (production today): only Gmail; no Microsoft, no IMAP", async () => {
    providers = { GMAIL: true, MICROSOFT: false, IMAP: false };
    renderPage();
    expect(await screen.findByRole("button", { name: /Conectar Gmail/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Microsoft/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Agregar IMAP/ })).not.toBeInTheDocument();
    expect(await screen.findByText("Conecta Gmail para empezar a procesar correos.")).toBeInTheDocument();
  });

  it("Microsoft configured (future F9): both OAuth providers are offered", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    renderPage();
    expect(await screen.findByRole("button", { name: /Conectar Microsoft \/ Outlook/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Conectar Gmail/ })).toBeInTheDocument();
    expect(await screen.findByText("Conecta Gmail o Microsoft para empezar a procesar correos.")).toBeInTheDocument();
  });

  it("nothing available: no connect button and an explicit notice", async () => {
    providers = { GMAIL: false, MICROSOFT: false, IMAP: false };
    renderPage();
    expect(await screen.findByText("No hay proveedores de correo disponibles en este momento.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Conectar/ })).not.toBeInTheDocument();
  });

  it("if the availability cannot be read, nothing is offered (no button that would fail)", async () => {
    providers = new ApiError(500, "DATABASE_ERROR", "Unexpected error");
    renderPage();
    expect(await screen.findByText(/Unexpected error|error/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Conectar/ })).not.toBeInTheDocument();
  });

  it("members who cannot manage accounts see no connect card at all", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    renderPage("VIEWER");
    expect(await screen.findByText("No hay cuentas conectadas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Conectar/ })).not.toBeInTheDocument();
  });
});

describe("Commercial V1: Microsoft needs the PRO or BUSINESS plan", () => {
  it("BASIC: the Microsoft button is disabled with the reason; Gmail stays available", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    microsoftInPlan = false;
    renderPage();
    expect(await screen.findByText("Disponible en los planes Pro y Business.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Conectar Microsoft \/ Outlook/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Conectar Gmail/ })).toBeEnabled();
  });

  it("PRO / BUSINESS: Microsoft can be connected", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    renderPage();
    expect(await screen.findByRole("button", { name: /Conectar Microsoft \/ Outlook/ })).toBeEnabled();
    expect(screen.queryByText("Disponible en los planes Pro y Business.")).not.toBeInTheDocument();
  });

  it.each([
    ["plan_feature", "Tu plan no incluye este proveedor de correo. Microsoft está disponible en los planes Pro y Business."],
    ["plan_limit", "Alcanzaste el límite de cuentas de correo de tu plan. Para conectar otra se necesita un plan superior."],
    [
      "missing_refresh_token",
      "El proveedor no concedió acceso sin conexión, así que la cuenta no se guardó. Vuelve a conectarla y acepta todos los permisos solicitados."
    ]
  ])("the OAuth callback refusal %s is explained", async (reason, message) => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    renderPage("OWNER", `/accounts?oauth=error&reason=${reason}`);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  });
});

describe("Commercial V1.1: no active subscription, no connection (EmailBot is paid)", () => {
  it("explains it and disables every connect button", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    subscribed = false;
    renderPage();
    expect(await screen.findByText(/no tiene una suscripción activa/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Conectar Gmail/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Conectar Microsoft \/ Outlook/ })).toBeDisabled();
  });

  it("the OAuth callback refusal subscription_required is explained", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    renderPage("OWNER", "/accounts?oauth=error&reason=subscription_required");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Tu organización no tiene una suscripción activa. Contrata o renueva un plan para conectar cuentas.")
    );
  });
});

describe("existing accounts stay manageable", () => {
  it("a historical IMAP account is listed and can be disconnected, never resumed", async () => {
    providers = { GMAIL: true, MICROSOFT: false, IMAP: false };
    accounts = [account({ id: "imap-1", provider: "IMAP", status: "PAUSED", emailAddress: "historico@acme.test", lastErrorCode: "IMAP_SYNC_NOT_IMPLEMENTED" })];
    renderPage();
    const card = (await screen.findByText("historico@acme.test")).closest("div.rounded-lg, [class*='card']") ?? document.body;
    expect(within(card as HTMLElement).getByRole("button", { name: /Desconectar/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reanudar/ })).not.toBeInTheDocument();
  });

  it("a disconnected IMAP account can be deleted", async () => {
    providers = { GMAIL: true, MICROSOFT: false, IMAP: false };
    accounts = [account({ id: "imap-2", provider: "IMAP", status: "DISCONNECTED", emailAddress: "viejo@acme.test" })];
    renderPage();
    expect(await screen.findByText("viejo@acme.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Eliminar/ })).toBeInTheDocument();
  });

  it("a Microsoft account in error offers 'Reconectar' only while Microsoft is available", async () => {
    accounts = [account({ id: "ms-1", provider: "MICROSOFT", status: "ERROR", emailAddress: "outlook@acme.test" })];
    providers = { GMAIL: true, MICROSOFT: false, IMAP: false };
    renderPage();
    expect(await screen.findByText("outlook@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconectar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Desconectar/ })).toBeInTheDocument();
  });

  it("…and offers it when Microsoft is configured", async () => {
    accounts = [account({ id: "ms-2", provider: "MICROSOFT", status: "ERROR", emailAddress: "outlook2@acme.test" })];
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    renderPage();
    expect(await screen.findByRole("button", { name: /Reconectar/ })).toBeInTheDocument();
  });
});
