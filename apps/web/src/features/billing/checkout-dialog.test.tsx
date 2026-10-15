// @vitest-environment jsdom
import type { BillingSubscriptionSummary, Organization } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";
import { catalogEntry } from "@/test/plan-catalog-fixture";

/*
 * Commercial V1 phase 2 (Culqi sandbox): choosing a plan opens the card
 * checkout only when the API has Culqi configured. The browser sends plan,
 * period, Culqi's token and the accepted terms; never an amount or card data.
 * The plan is shown as active only once the API reports the payment confirmed.
 */

const { get, post, requestCardToken } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), requestCardToken: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post, patch: vi.fn() } }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ session: { user: { id: "user-1" } }, user: { id: "user-1" }, loading: false }) }));
vi.mock("./culqi-checkout", () => ({ requestCardToken }));

const { ChoosePlanDialog } = await import("./choose-plan-dialog");

const ORG = "11111111-1111-4111-8111-111111111111";
const organization: Organization = { id: ORG, name: "Acme", slug: "acme", plan: "BASIC", status: "ACTIVE", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
const summary = (status: BillingSubscriptionSummary["status"], failureMessage: string | null = null): BillingSubscriptionSummary => ({
  id: "bill-1",
  status,
  plan: "PRO",
  billingPeriod: "MONTHLY",
  environment: "test",
  createdAt: "2026-10-07T12:00:00.000Z",
  activatedAt: null,
  currentPeriodEnd: null,
  canceledAt: null,
  cancelReason: null,
  failureCode: null,
  failureMessage
});

let enabled: boolean;
let currentStatus: BillingSubscriptionSummary["status"];
const refresh = vi.fn(async () => undefined);

function renderDialog() {
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
    refresh
  };
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizationContext.Provider value={context}>
        <MemoryRouter>
          <ChoosePlanDialog plan={catalogEntry("PRO")} onOpenChange={onOpenChange} />
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
  return { onOpenChange };
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Nombres"), { target: { value: "Ana" } });
  fireEvent.change(screen.getByLabelText("Apellidos"), { target: { value: "Pérez" } });
  fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "999888777" } });
  fireEvent.change(screen.getByLabelText("Dirección"), { target: { value: "Av. Lima 123" } });
  fireEvent.change(screen.getByLabelText("Ciudad"), { target: { value: "Lima" } });
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  requestCardToken.mockReset();
  refresh.mockClear();
  enabled = true;
  currentStatus = "PENDING";
  get.mockImplementation(async (path: string) => {
    if (path === "/api/billing/config") return { enabled, environment: enabled ? "test" : null };
    if (path.startsWith("/api/billing/checkout")) {
      return { publicKey: "pk_test_PUBLIC", environment: "test", plan: "PRO", planName: "Pro", billingPeriod: "MONTHLY", currency: "PEN", amount: "39.90", amountCents: 3990, kind: "upgrade", customerEmail: "ana@example.com" };
    }
    if (path === "/api/billing/subscriptions/current") return { billingSubscription: summary(currentStatus) };
    throw new Error(`unexpected GET ${path}`);
  });
  requestCardToken.mockResolvedValue("tkn_test_TOKEN1");
  post.mockResolvedValue({ billingSubscription: summary("PENDING") });
});

describe("choosing a plan", () => {
  it("without Culqi configured: the existing 'Próximamente' notice, no payment", async () => {
    enabled = false;
    renderDialog();
    expect(await screen.findByRole("dialog", { name: "Contratación en línea próximamente" })).toBeInTheDocument();
    expect(requestCardToken).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("with Culqi (sandbox): the checkout says no real charge is made and offers the catalog prices", async () => {
    renderDialog();
    expect(await screen.findByRole("dialog", { name: "Contratar el plan Pro" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("no se realizan cobros reales");
    const period = screen.getByLabelText("Periodicidad");
    expect(period).toHaveTextContent("Mensual · S/ 39.90 / mes");
    expect(period).toHaveTextContent("Anual · S/ 399.00 / año");
  });

  it("the terms must be accepted before Culqi's form opens", async () => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Contratar el plan Pro" });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Continuar al pago" }));
    expect(await screen.findByText("Debes aceptar los Términos para continuar")).toBeInTheDocument();
    expect(requestCardToken).not.toHaveBeenCalled();
  });

  it("price from the API, token from Culqi, only plan / period / token / terms / contact sent; active only when confirmed", async () => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Contratar el plan Pro" });
    fillForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continuar al pago" }));

    expect(await screen.findByText(/Esperando la confirmación del pago/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/billing/checkout?plan=PRO&billingPeriod=MONTHLY");
    expect(requestCardToken).toHaveBeenCalledWith({ publicKey: "pk_test_PUBLIC", amountCents: 3990, currency: "PEN", email: "ana@example.com" });
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/api/billing/subscriptions");
    expect(body).toEqual({
      plan: "PRO",
      billingPeriod: "MONTHLY",
      tokenId: "tkn_test_TOKEN1",
      acceptTerms: true,
      customer: { firstName: "Ana", lastName: "Pérez", phoneNumber: "999888777", address: "Av. Lima 123", addressCity: "Lima", countryCode: "PE" }
    });
    expect(JSON.stringify(body)).not.toMatch(/amount|currency|price|limits/);
    expect(screen.queryByText(/ya está activo/)).not.toBeInTheDocument();

    // The worker confirms the payment: the next poll reports ACTIVE.
    currentStatus = "ACTIVE";
    expect(await screen.findByText("Pago confirmado. Tu plan Pro ya está activo.", {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("a declined card: Culqi's refusal is shown and nothing is activated", async () => {
    post.mockRejectedValue(new ApiError(402, "PAYMENT_DECLINED", "declined"));
    renderDialog();
    await screen.findByRole("dialog", { name: "Contratar el plan Pro" });
    fillForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continuar al pago" }));
    expect(await screen.findByText("El pago fue rechazado. Revisa los datos de la tarjeta o usa otra.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuar al pago" })).toBeEnabled();
  });

  it("a payment that Culqi finally declines (FAILED) is reported, no plan activated", async () => {
    renderDialog();
    await screen.findByRole("dialog", { name: "Contratar el plan Pro" });
    fillForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continuar al pago" }));
    await screen.findByText(/Esperando la confirmación del pago/);
    currentStatus = "FAILED";
    expect(await screen.findByText(/El pago no se pudo completar.*No se activó ningún plan/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
