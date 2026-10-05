// @vitest-environment jsdom
import type { PortalEmailDetail, PortalInboxItem, PortalInboxPage, PortalProfile } from "@emailbot/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type { PortalApi } from "./portal-api";
import { PortalApp } from "./portal-app";

/*
 * Customer portal UI (EmailBot V2 phase 5.5). The API is faked: database and
 * API security are covered by packages/database, apps/api and the local
 * integration; these tests cover what the UI shows, sends and stores.
 */

const DELIVERY = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const ATTACHMENT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

const profile: PortalProfile = {
  customer: { displayName: "Juan Pérez", status: "ACTIVE" },
  organization: { name: "Streaming Corp" },
  bots: [{ name: "Netflix", slug: "netflix", portalSettings: { showBody: true, showAttachments: true, fields: [] } }],
  session: { idleExpiresAt: "2026-10-12T00:00:00.000Z", absoluteExpiresAt: "2026-11-04T00:00:00.000Z" }
};

function item(overrides: Partial<PortalInboxItem> = {}): PortalInboxItem {
  return {
    deliveryId: DELIVERY,
    deliveredAt: "2026-10-05T10:00:00.000Z",
    receivedAt: "2026-10-05T10:00:00.000Z",
    subject: "Tu código de acceso",
    sender: { email: "info@netflix.example", name: "Netflix" },
    bot: { name: "Netflix", slug: "netflix" },
    category: { name: "Códigos", slug: "codigos" },
    important: true,
    read: false,
    hasAttachments: true,
    fields: [{ key: "verification_code", label: "Código", value: "482913" }],
    ...overrides
  };
}

function detail(overrides: Partial<PortalEmailDetail> = {}): PortalEmailDetail {
  const { hasAttachments: _ignored, ...base } = item({ read: true });
  void _ignored;
  return {
    ...base,
    body: { text: "Tu código es 482913", html: "<p>Tu código es <b>482913</b></p><script>alert(1)</script>" },
    attachments: [{ id: ATTACHMENT, filename: "factura.pdf", contentType: "application/pdf", size: 2048, available: true }],
    ...overrides
  };
}

const page = (items: PortalInboxItem[], nextCursor: string | null = null): PortalInboxPage => ({ items, nextCursor });

function fakeApi(overrides: Partial<Record<keyof PortalApi, unknown>> = {}) {
  const api = {
    login: vi.fn(async () => ({ customer: { displayName: "Juan Pérez" }, session: profile.session })),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => profile),
    inbox: vi.fn(async () => page([item()])),
    filters: vi.fn(async () => ({ bots: [{ name: "Netflix", slug: "netflix" }], categories: [{ name: "Códigos", slug: "codigos" }] })),
    email: vi.fn(async () => detail()),
    attachmentUrl: vi.fn(async () => ({ url: "https://storage.example/signed?token=t", expiresIn: 60 })),
    ...overrides
  };
  return api as unknown as PortalApi & Record<keyof PortalApi, ReturnType<typeof vi.fn>>;
}

function renderPortal(path: string, api = fakeApi()) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/portal/*" element={<PortalApp api={api} />} />
      </Routes>
    </MemoryRouter>
  );
  return { ...view, api };
}

const typeAccessId = (value: string) => fireEvent.change(screen.getByLabelText("Access ID"), { target: { value } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portal login", () => {
  it("signs in with the Access ID and opens the inbox (the session is the httpOnly cookie)", async () => {
    const { api } = renderPortal("/portal/login");
    typeAccessId(" sp-7kq9x82mp4z7 ");
    fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
    await screen.findByRole("heading", { name: "Bandeja" });
    expect(api.login).toHaveBeenCalledWith("sp-7kq9x82mp4z7");
    expect(await screen.findByText("Tu código de acceso")).toBeInTheDocument();
  });

  it("shows ONE generic message for any rejected Access ID (never the server's details)", async () => {
    const api = fakeApi({ login: vi.fn(async () => Promise.reject(new ApiError(401, "INVALID_CREDENTIALS", "Customer suspended in organization X"))) });
    renderPortal("/portal/login", api);
    typeAccessId("SP-7KQ9X82MP4Z7");
    fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access ID o credenciales no válidas.");
    expect(document.body.textContent).not.toMatch(/suspended|organization X/);
    expect(screen.getByLabelText("Access ID")).toBeInTheDocument(); // stays on login: no redirect loop
  });

  it("rate limited login: friendly 429 message", async () => {
    renderPortal("/portal/login", fakeApi({ login: vi.fn(async () => Promise.reject(new ApiError(429, "RATE_LIMITED", "Too many"))) }));
    typeAccessId("SP-7KQ9X82MP4Z7");
    fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Has realizado demasiadas solicitudes. Espera un momento e inténtalo nuevamente.");
  });

  it("never stores anything in localStorage / sessionStorage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { api } = renderPortal("/portal/login");
    typeAccessId("SP-7KQ9X82MP4Z7");
    fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
    await screen.findByText("Tu código de acceso");
    expect(api.login).toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});

describe("portal inbox", () => {
  it("renders the customer's emails: sender, subject, bot, category, allowed fields, unread, important, attachment", async () => {
    renderPortal("/portal");
    const row = (await screen.findByText("Tu código de acceso")).closest("a") as HTMLElement;
    expect(within(row).getByText("Netflix", { selector: "span.truncate" })).toBeInTheDocument();
    expect(within(row).getByText("Códigos")).toBeInTheDocument();
    expect(within(row).getByText("482913")).toBeInTheDocument();
    expect(within(row).getByLabelText("No leído")).toBeInTheDocument();
    expect(within(row).getByLabelText("Importante")).toBeInTheDocument();
    expect(within(row).getByLabelText("Con archivos adjuntos")).toBeInTheDocument();
    expect(row).toHaveAttribute("href", `/portal/email/${DELIVERY}`);
    expect(await screen.findByTestId("portal-customer-name")).toHaveTextContent("Juan Pérez");
  });

  it("empty inbox and empty filtered result have their own messages", async () => {
    const api = fakeApi({ inbox: vi.fn(async () => page([])) });
    renderPortal("/portal", api);
    expect(await screen.findByText("No tienes correos disponibles todavía.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "No leídos" }));
    expect(await screen.findByText("No encontramos correos con esos filtros.")).toBeInTheDocument();
  });

  it("filters are sent to the API as query parameters (no client-side filtering)", async () => {
    const { api } = renderPortal("/portal");
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("tab", { name: "No leídos" }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ unread: true, cursor: undefined })));
    fireEvent.click(screen.getByRole("tab", { name: "Importantes" }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ important: true, unread: undefined })));
    await screen.findByRole("option", { name: "Netflix" });
    fireEvent.change(screen.getByLabelText("Bot"), { target: { value: "netflix" } });
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ bot: "netflix" })));
    fireEvent.change(screen.getByLabelText("Categoría"), { target: { value: "codigos" } });
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ category: "codigos" })));
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String) })));
    for (const [params] of api.inbox.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(Object.keys(params)).not.toEqual(expect.arrayContaining(["customerId", "organizationId", "botId"]));
    }
  });

  it("search is debounced: one request after the pause, not one per keystroke", async () => {
    const { api } = renderPortal("/portal");
    await screen.findByText("Tu código de acceso");
    const box = screen.getByPlaceholderText("Buscar por asunto o remitente");
    for (const value of ["c", "co", "cod", "codi", "codigo"]) fireEvent.change(box, { target: { value } });
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ search: "codigo" })), { timeout: 2000 });
    const searches = (api.inbox.mock.calls as unknown as Array<[{ search?: string }]>).map(([params]) => params.search).filter(Boolean);
    expect(searches).toEqual(["codigo"]);
  });

  it("cursor pagination: 'Cargar más' sends the API's opaque cursor untouched and appends the page", async () => {
    const inbox = vi.fn(async (params: { cursor?: string }) =>
      params.cursor ? page([item({ deliveryId: "d2", subject: "Segundo correo" })]) : page([item()], "opaque-cursor==")
    );
    const { api } = renderPortal("/portal", fakeApi({ inbox }));
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));
    expect(await screen.findByText("Segundo correo")).toBeInTheDocument();
    expect(screen.getByText("Tu código de acceso")).toBeInTheDocument();
    expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "opaque-cursor==" }));
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
  });

  it("429 and generic errors show friendly messages with a retry", async () => {
    renderPortal("/portal", fakeApi({ inbox: vi.fn(async () => Promise.reject(new ApiError(429, "RATE_LIMITED", "x"))) }));
    expect(await screen.findByText("Has realizado demasiadas solicitudes. Espera un momento e inténtalo nuevamente.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument();
  });

  it("mobile: the filter panel is collapsed by default and toggled by 'Filtros'", async () => {
    renderPortal("/portal");
    await screen.findByText("Tu código de acceso");
    const toggle = screen.getByRole("button", { name: /filtros/i });
    const panel = screen.getByLabelText("Bot").closest("div") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(panel.className).toMatch(/md:grid/);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});

describe("portal email detail", () => {
  it("shows what the API allows: fields, body in a sandboxed iframe (no scripts, no same-origin), attachments", async () => {
    const { api } = renderPortal(`/portal/email/${DELIVERY}`);
    expect(await screen.findByRole("heading", { name: "Tu código de acceso" })).toBeInTheDocument();
    expect(api.email).toHaveBeenCalledWith(DELIVERY);
    expect(screen.getByText("Código")).toBeInTheDocument();
    expect(screen.getByText("482913")).toBeInTheDocument();
    const frame = screen.getByTitle("Contenido del correo");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-scripts|allow-same-origin/);
    expect(document.querySelector("script")).toBeNull(); // the email's script only lives inside srcdoc
    expect(screen.getByText("factura.pdf")).toBeInTheDocument();
  });

  it("downloads through a short-lived URL requested from the API for that delivery and attachment", async () => {
    const opened: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.href);
    });
    const { api } = renderPortal(`/portal/email/${DELIVERY}`);
    fireEvent.click(await screen.findByRole("button", { name: "Descargar factura.pdf" }));
    await waitFor(() => expect(opened).toEqual(["https://storage.example/signed?token=t"]));
    expect(api.attachmentUrl).toHaveBeenCalledWith(DELIVERY, ATTACHMENT);
  });

  it("a failed download shows a friendly message without any path", async () => {
    const api = fakeApi({ attachmentUrl: vi.fn(async () => Promise.reject(new ApiError(404, "NOT_FOUND", "org/email/attachment/path.pdf"))) });
    renderPortal(`/portal/email/${DELIVERY}`, api);
    fireEvent.click(await screen.findByRole("button", { name: "Descargar factura.pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos preparar la descarga. Inténtalo nuevamente.");
    expect(document.body.textContent).not.toContain("path.pdf");
  });

  it("showBody = false / showAttachments = false: nothing of that is rendered", async () => {
    renderPortal(`/portal/email/${DELIVERY}`, fakeApi({ email: vi.fn(async () => detail({ body: null, attachments: null })) }));
    await screen.findByRole("heading", { name: "Tu código de acceso" });
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
    expect(screen.queryByText(/tu código es/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Archivos adjuntos")).not.toBeInTheDocument();
  });

  it("an empty attachment list and hidden / missing fields", async () => {
    renderPortal(
      `/portal/email/${DELIVERY}`,
      fakeApi({ email: vi.fn(async () => detail({ attachments: [], fields: [{ key: "pin", label: "PIN", value: null }] })) })
    );
    expect(await screen.findByText("Este correo no tiene archivos adjuntos disponibles.")).toBeInTheDocument();
    expect(screen.getByText("PIN")).toBeInTheDocument();
    expect(screen.getByText("No disponible")).toBeInTheDocument();
    expect(screen.queryByText("Código")).not.toBeInTheDocument();
  });

  it("404: 'El correo no está disponible.'", async () => {
    renderPortal(`/portal/email/${DELIVERY}`, fakeApi({ email: vi.fn(async () => Promise.reject(new ApiError(404, "NOT_FOUND", "Email not found"))) }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El correo no está disponible.");
  });

  it("no internal identifiers are displayed", async () => {
    renderPortal(`/portal/email/${DELIVERY}`);
    await screen.findByRole("heading", { name: "Tu código de acceso" });
    const text = document.body.textContent ?? "";
    for (const id of [DELIVERY, ATTACHMENT]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe("portal session lifecycle", () => {
  it("logout calls the API, clears the portal state and returns to the login page", async () => {
    const { api } = renderPortal("/portal");
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    expect(await screen.findByLabelText("Access ID")).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Tu código de acceso")).not.toBeInTheDocument();
  });

  it("any 401 (expired, revoked, customer or organization suspended) redirects once to login with a generic notice", async () => {
    const unauthorized = () => Promise.reject(new ApiError(401, "UNAUTHORIZED", "La sesión no es válida."));
    const api = fakeApi({ me: vi.fn(unauthorized), inbox: vi.fn(unauthorized), filters: vi.fn(unauthorized) });
    renderPortal("/portal", api);
    expect(await screen.findByRole("status")).toHaveTextContent("Tu sesión terminó. Vuelve a ingresar con tu Access ID.");
    expect(screen.getByLabelText("Access ID")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.me.mock.calls.length).toBeLessThanOrEqual(1);
    expect(api.inbox.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
