// @vitest-environment jsdom
import type { Bot, CustomerResolution, Organization } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailRule } from "@/features/rules/api";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/*
 * Regression: a bot's emails reached the panel but never the customer portal.
 * Every bot is created with customer_resolution.source = NONE and the panel
 * offered no way to change it, so the worker never delivered (routing.unassigned
 * NOT_CONFIGURED) even with an active customer, identifier and assignment.
 * The bot page now shows the delivery state and lets an admin configure it.
 */

// Hoisted: organization-provider (imported above) loads @/lib/api before this module's body runs.
const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, patch, post: vi.fn(), delete: vi.fn() } }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "user-1" }, session: { user: { id: "user-1" } } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { BotDetailPage } = await import("./bot-detail-page");

const ORG = "11111111-1111-4111-8111-111111111111";
const BOT_ID = "22222222-2222-4222-8222-222222222222";
const organization: Organization = { id: ORG, name: "Acme", slug: "acme", plan: "PRO", status: "ACTIVE", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

const NONE: CustomerResolution = { source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" };
let bot: Bot;
let rules: EmailRule[];

const makeBot = (customerResolution: CustomerResolution): Bot => ({
  id: BOT_ID,
  organizationId: ORG,
  name: "Netflix",
  slug: "netflix",
  description: null,
  status: "ACTIVE",
  customerResolution,
  portalSettings: { showBody: false, showAttachments: false, fields: [] },
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
});

function renderPage(can: (permission: string) => boolean = () => true) {
  const context: OrganizationContextValue = {
    me: undefined,
    loading: false,
    error: null,
    memberships: [{ role: "ADMIN", organization }],
    isPlatformAdmin: false,
    legalAcceptanceRequired: false,
    organization,
    role: "ADMIN",
    can,
    switchOrganization: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganizationContext.Provider value={context}>
        <MemoryRouter initialEntries={[`/bots/${BOT_ID}`]}>
          <Routes>
            <Route path="/bots/:botId" element={<BotDetailPage />} />
          </Routes>
        </MemoryRouter>
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  bot = makeBot(NONE);
  rules = [];
  get.mockImplementation(async (path: string) => {
    if (path === `/api/bots/${BOT_ID}`) return { bot };
    if (path === `/api/bots/${BOT_ID}/customers`) return { items: [] };
    if (path === "/api/rules") return { items: rules };
    throw new Error(`unexpected GET ${path}`);
  });
  patch.mockImplementation(async (_path: string, body: { customerResolution: CustomerResolution }) => {
    bot = makeBot(body.customerResolution);
    return { bot };
  });
});

describe("bot page: delivery to the customer portal", () => {
  it("a bot with the default resolution says that its emails do not reach any portal", async () => {
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent(/no llegan al portal de ningún cliente/);
    expect(screen.getByText("Desactivada")).toBeInTheDocument();
    expect(screen.getByLabelText("Identificar al cliente por")).toHaveValue("NONE");
  });

  it("an admin activates it by recipient: PATCH /api/bots/:id sends the resolution and the warning disappears", async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText("Identificar al cliente por"), { target: { value: "RECIPIENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/api/bots/${BOT_ID}`, { customerResolution: { source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED" } });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByText("Activa")).toBeInTheDocument();
  });

  it("by an extracted field: offers the EXTRACT names of the bot's rules and requires one", async () => {
    rules = [
      {
        id: "r1",
        organizationId: ORG,
        categoryId: null,
        botId: BOT_ID,
        name: "Código",
        description: null,
        enabled: true,
        priority: 10,
        stopProcessing: false,
        matchMode: "AND",
        conditions: [],
        actions: [{ type: "EXTRACT", name: "account_email", preset: "email", source: "any" }],
        createdBy: null,
        updatedBy: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z"
      }
    ];
    renderPage();
    fireEvent.change(await screen.findByLabelText("Identificar al cliente por"), { target: { value: "EXTRACTED_FIELD" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Elige el dato extraído que identifica al cliente")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByRole("option", { name: "account_email" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Dato extraído"), { target: { value: "account_email" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/api/bots/${BOT_ID}`, {
        customerResolution: { source: "EXTRACTED_FIELD", field: "account_email", identifierType: "EMAIL", onMultipleMatches: "LEAVE_UNASSIGNED" }
      })
    );
  });

  it("without bots:manage the configuration is visible but read-only", async () => {
    renderPage((permission) => permission !== "bots:manage");
    expect(await screen.findByLabelText("Identificar al cliente por")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar" })).not.toBeInTheDocument();
  });
});

describe("bot page: what the customer portal shows (portal_settings)", () => {
  it("by default the content is not shared; an admin enables it and the configured fields are kept", async () => {
    const fields = [{ key: "verification_code", label: "Código" }];
    bot = { ...makeBot(NONE), portalSettings: { showBody: false, showAttachments: false, fields } };
    patch.mockImplementation(async (_path: string, body: Partial<Bot>) => {
      bot = { ...bot, ...body };
      return { bot };
    });
    renderPage();

    const showBody = await screen.findByRole("checkbox", { name: /Mostrar el contenido completo del correo/ });
    expect(showBody).not.toBeChecked();
    expect(screen.getByText("Solo resumen")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Guardar vista en el portal" });
    expect(save).toBeDisabled();

    fireEvent.click(showBody);
    fireEvent.click(save);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/api/bots/${BOT_ID}`, { portalSettings: { showBody: true, showAttachments: false, fields } })
    );
    expect(await screen.findByText("Contenido visible")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Mostrar el contenido completo del correo/ })).toBeChecked();
  });

  it("attachments are a separate choice", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Permitir descargar los archivos adjuntos/ }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar vista en el portal" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(`/api/bots/${BOT_ID}`, { portalSettings: { showBody: false, showAttachments: true, fields: [] } })
    );
  });

  it("without bots:manage the choices are visible but read-only", async () => {
    renderPage((permission) => permission !== "bots:manage");
    expect(await screen.findByRole("checkbox", { name: /Mostrar el contenido completo del correo/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar vista en el portal" })).not.toBeInTheDocument();
  });
});
