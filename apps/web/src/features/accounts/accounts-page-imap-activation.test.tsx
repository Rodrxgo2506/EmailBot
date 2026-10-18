// @vitest-environment jsdom
import type { EmailAccount, EmailProviderAvailability, Organization } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/*
 * IMAP M1: an IMAP mailbox is PAUSED after every (re)connection and only synchronizes after an explicit
 * resume ("Reanudar" -> PATCH status ACTIVE, decided by the API / database). The button exists only
 * while the server offers IMAP (GET /api/email-accounts/providers) and never for a DISCONNECTED mailbox.
 */

const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post: vi.fn(), patch, delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { AccountsPage } = await import("./accounts-page");

const ORG = "11111111-1111-4111-8111-111111111111";
const organization: Organization = {
  id: ORG,
  name: "Acme",
  slug: "acme",
  plan: "PRO",
  status: "ACTIVE",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};

const imap = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: "imap-9",
  organizationId: ORG,
  provider: "IMAP",
  status: "PAUSED",
  emailAddress: "ventas@acme.test",
  displayName: null,
  lastSyncedAt: null,
  lastErrorCode: "IMAP_ACTIVATION_PENDING",
  lastErrorMessage: "Mailbox connected and paused. Resume it to start synchronizing new mail.",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

let providers: EmailProviderAvailability;
let accounts: EmailAccount[];

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  accounts = [];
  get.mockImplementation(async (path: string) => {
    if (path === "/api/organizations/current/plan") {
      return {
        entitlements: {
          plan: "PRO",
          effectivePlan: "PRO",
          access: "SUBSCRIPTION",
          subscriptionStatus: "ACTIVE",
          limits: {},
          features: { GMAIL: true, MICROSOFT: true, IMAP: true, ADVANCED_STATS: true, PORTAL: true, API: false, PRIORITY_SUPPORT: true }
        },
        usage: {},
        subscription: null
      };
    }
    if (path === "/api/email-accounts/providers") return { providers };
    if (path === "/api/email-accounts") return { items: accounts };
    throw new Error(`unexpected GET ${path}`);
  });
});

function renderPage(role: OrganizationContextValue["role"] = "OWNER") {
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
        <MemoryRouter initialEntries={["/accounts"]}>
          <AccountsPage />
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

describe("IMAP M1: explicit activation ('Reanudar')", () => {
  it("a newly connected mailbox shows as paused with the pending explanation; 'Reanudar' sends the activation", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
    accounts = [imap()];
    patch.mockResolvedValue({ account: imap({ status: "ACTIVE", lastErrorCode: null, lastErrorMessage: null }) });
    renderPage();
    expect(await screen.findByText("Buzón conectado y en pausa. Reanúdalo para empezar a sincronizar el correo nuevo.")).toBeInTheDocument();
    (await screen.findByRole("button", { name: /Reanudar/ })).click();
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/email-accounts/imap-9", { status: "ACTIVE" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Cuenta reanudada"));
  });

  it("M1.4 (H1): an IMAP mailbox in ERROR offers no 'Reanudar' (it must be connected again) and sends nothing", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
    accounts = [imap({ status: "ERROR", lastErrorCode: "IMAP_AUTH_FAILED" })];
    renderPage();
    expect(await screen.findByText("ventas@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reanudar/ })).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("Gmail / Microsoft in ERROR keep 'Reanudar' (unchanged)", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
    accounts = [
      imap({ id: "g-1", provider: "GMAIL", status: "ERROR", emailAddress: "g@acme.test", lastErrorCode: null }),
      imap({ id: "m-1", provider: "MICROSOFT", status: "ERROR", emailAddress: "m@acme.test", lastErrorCode: null })
    ];
    renderPage();
    expect(await screen.findByText("g@acme.test")).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: /Reanudar/ })).toHaveLength(2);
  });

  it("the API refusal IMAP_RECONNECT_REQUIRED is explained (reconnect and validate the connection again)", async () => {
    const { getErrorMessage } = await import("@/lib/errors");
    expect(getErrorMessage(new ApiError(409, "IMAP_RECONNECT_REQUIRED", "x"))).toMatch(/reconectar el buzón IMAP para validar nuevamente la conexión/);
  });

  it("DISCONNECTED: no 'Reanudar', even with IMAP available", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
    accounts = [imap({ status: "DISCONNECTED", emailAddress: "gone@acme.test", lastErrorCode: null })];
    renderPage();
    expect(await screen.findByText("gone@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reanudar/ })).not.toBeInTheDocument();
  });

  it("IMAP unavailable (production today): no 'Reanudar' and no activation request", async () => {
    providers = { GMAIL: true, MICROSOFT: false, IMAP: false };
    accounts = [imap()];
    renderPage();
    expect(await screen.findByText("ventas@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reanudar/ })).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("VIEWER: no 'Reanudar'", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
    accounts = [imap()];
    renderPage("VIEWER");
    expect(await screen.findByText("ventas@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reanudar/ })).not.toBeInTheDocument();
  });

  it.each([
    [new ApiError(403, "PLAN_FEATURE_UNAVAILABLE", "The plan does not include IMAP"), "Esta funcionalidad no está incluida en tu plan."],
    [new ApiError(409, "IMAP_RECONNECT_REQUIRED", "internal detail"), "Hay que reconectar el buzón IMAP para validar nuevamente la conexión: vuelve a agregarlo con la misma dirección."],
    [new ApiError(409, "RECONNECT_REQUIRED", "internal detail"), "La cuenta está desconectada. Conéctala nuevamente."]
  ])("a refusal from the API is shown with a clear message, never the server text (%s)", async (error, message) => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
    accounts = [imap()];
    patch.mockRejectedValue(error);
    renderPage();
    (await screen.findByRole("button", { name: /Reanudar/ })).click();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  });
});
