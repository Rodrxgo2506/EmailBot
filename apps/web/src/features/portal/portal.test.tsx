// @vitest-environment jsdom
import type { PortalEmailDetail, PortalInboxItem, PortalInboxPage, PortalProfile } from "@emailbot/types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type { PortalApi } from "./portal-api";
import { PortalApp } from "./portal-app";
import type { PortalRealtime, PortalRealtimeHandlers } from "./portal-realtime";

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
    sync: vi.fn(async () => ({ status: "QUEUED", lastSyncAt: new Date(Date.now() - 30_000).toISOString() })),
    syncStatus: vi.fn(async () => ({ running: false, lastSyncAt: new Date(Date.now() - 30_000).toISOString() })),
    ...overrides
  };
  return api as unknown as PortalApi & Record<keyof PortalApi, ReturnType<typeof vi.fn>>;
}

function renderPortal(path: string, api = fakeApi(), realtime?: PortalRealtime | null) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/portal/*" element={<PortalApp api={api} realtime={realtime} />} />
      </Routes>
    </MemoryRouter>
  );
  return { ...view, api };
}

/** Records the realtime connections the portal opens and lets the test fire their signals. */
function fakeRealtime() {
  const connections: Array<{ handlers: PortalRealtimeHandlers; stop: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn((handlers: PortalRealtimeHandlers) => {
    const stop = vi.fn();
    connections.push({ handlers, stop });
    return stop;
  });
  return { connect: connect as unknown as PortalRealtime, calls: connect, connections };
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

  it("Enter in the field, then an error: the field keeps the focus, one request only, and the Access ID can be fixed and sent again", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const login = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_resolve, fail) => (reject = fail)))
      .mockImplementationOnce(async () => ({ customer: { displayName: "Juan Pérez" }, session: profile.session }));
    renderPortal("/portal/login", fakeApi({ login }));
    const field = screen.getByLabelText("Access ID") as HTMLInputElement;
    field.focus();
    typeAccessId("SP-7KQ9X82MP4Z0");
    // Enter in a text field submits its form (implicit submission; jsdom does not emulate the key itself).
    fireEvent.submit(field.form as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole("button", { name: /ingresando/i })).toBeDisabled());
    expect(field).toHaveAttribute("readonly");
    expect(field).not.toBeDisabled();
    expect(field).toHaveFocus();
    fireEvent.submit(field.form as HTMLFormElement); // a second Enter while signing in
    expect(login).toHaveBeenCalledTimes(1);

    await act(async () => reject(new ApiError(401, "INVALID_CREDENTIALS", "nope")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access ID o credenciales no válidas.");
    expect(field).toHaveFocus();
    expect(field).not.toHaveAttribute("readonly");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Access ID o credenciales no válidas.");

    typeAccessId("SP-7KQ9X82MP4Z7");
    fireEvent.submit(field.form as HTMLFormElement);
    await screen.findByRole("heading", { name: "Bandeja" });
    expect(login).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenLastCalledWith("SP-7KQ9X82MP4Z7");
  });

  it("an error after clicking the button moves the focus back to the field", async () => {
    renderPortal("/portal/login", fakeApi({ login: vi.fn(async () => Promise.reject(new ApiError(401, "INVALID_CREDENTIALS", "nope"))) }));
    typeAccessId("SP-7KQ9X82MP4Z7");
    const button = screen.getByRole("button", { name: /ingresar/i });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Access ID")).toHaveFocus();
  });

  it("empty Access ID: the message and the focus go to the field, nothing is sent", async () => {
    const { api } = renderPortal("/portal/login");
    fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ingresa tu Access ID.");
    expect(screen.getByLabelText("Access ID")).toHaveFocus();
    expect(api.login).not.toHaveBeenCalled();
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
    // Service and category menus list the real options of GET /api/portal/filters; the slug is sent.
    fireEvent.click(screen.getByRole("button", { name: /^servicio/i }));
    fireEvent.click(await screen.findByRole("option", { name: "Netflix" }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ bot: "netflix" })));
    expect(screen.getByRole("button", { name: /^servicio/i })).toHaveAccessibleName("Servicio Netflix");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^categoría/i }));
    fireEvent.click(await screen.findByRole("option", { name: "Códigos" }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ category: "codigos" })));
    // A day chosen in the calendar becomes the `from` filter; "Eliminar fecha" removes it again.
    fireEvent.click(screen.getByRole("button", { name: /^desde/i }));
    const calendar = await screen.findByRole("dialog");
    fireEvent.click(within(calendar).getAllByRole("button", { name: /\d{4}$/ })[0] as HTMLElement);
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String) })));
    fireEvent.click(screen.getByRole("button", { name: /^desde/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar fecha" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^desde/i })).toHaveAccessibleName("Desde sin fecha"));
    // (that combination is served from the query cache; the next request carries no `from`)
    fireEvent.click(screen.getByRole("tab", { name: "Todos" }));
    await waitFor(() =>
      expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ from: undefined, important: undefined, bot: "netflix", category: "codigos" }))
    );
    for (const [params] of api.inbox.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(Object.keys(params)).not.toEqual(expect.arrayContaining(["customerId", "organizationId", "botId"]));
    }
  });

  it("date range stays coherent: 'Hasta' cannot be earlier than 'Desde', and 'Desde' not later than 'Hasta'", async () => {
    const { api } = renderPortal("/portal");
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /^desde/i }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /, 15 de / }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String) })));
    const calls = api.inbox.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /^hasta/i }));
    const until = await screen.findByRole("dialog");
    expect(until).toHaveAccessibleDescription(/^«Hasta» no puede ser anterior a «Desde» \(15 \w+ \d{4}\)\.$/);
    const early = within(until).getByRole("button", { name: /, 10 de / });
    expect(early).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(early);
    expect(api.inbox.mock.calls.length).toBe(calls); // nothing sent, the calendar stays open
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(within(until).getByRole("button", { name: /, 20 de / }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) })));

    fireEvent.click(screen.getByRole("button", { name: /^desde/i }));
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: /, 25 de / })).toHaveAttribute("aria-disabled", "true");
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
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLElement;
    expect(within(panel).getByRole("button", { name: /^servicio/i })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /^hasta/i })).toBeInTheDocument();
    expect(panel).not.toContainElement(screen.getByPlaceholderText("Buscar por asunto o remitente")); // search always visible
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

  it("showBody = false / showAttachments = false: nothing of that is rendered, and the page says the content is not shown", async () => {
    renderPortal(`/portal/email/${DELIVERY}`, fakeApi({ email: vi.fn(async () => detail({ body: null, attachments: null })) }));
    await screen.findByRole("heading", { name: "Tu código de acceso" });
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
    expect(screen.queryByText(/tu código es/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Archivos adjuntos")).not.toBeInTheDocument();
    expect(screen.getByText("El contenido completo de este correo no se muestra en el portal.")).toBeInTheDocument();
  });

  it("HTML email: the original formatting and the verification code inside the sanitized, sandboxed iframe", async () => {
    const html =
      '<html><head><style>.c{font-size:28px}</style></head><body><table><tr><td><h2>Netflix</h2><p class="c"><b>482913</b></p>' +
      '<a href="https://www.netflix.com/login" onclick="steal()">Iniciar sesión</a><img src="https://cdn.example/l.png"></td></tr></table>' +
      '<form action="https://evil.example"><input name="p"></form><script>alert(1)</script></body></html>';
    renderPortal(`/portal/email/${DELIVERY}`, fakeApi({ email: vi.fn(async () => detail({ body: { text: null, html } })) }));
    const frame = await screen.findByTitle("Contenido del correo");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('<p class="c"><b>482913</b></p>');
    expect(srcdoc).toContain("<style>.c{font-size:28px}</style>");
    expect(srcdoc).toContain('href="https://www.netflix.com/login"');
    expect(srcdoc).toContain('rel="noopener noreferrer"');
    expect(srcdoc).toContain("img-src data: cid:;"); // remote images blocked until the customer asks
    expect(srcdoc).not.toMatch(/<script|onclick|<form|<input|steal\(/);
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/);
    expect(screen.getByRole("button", { name: /Imágenes remotas bloqueadas/ })).toBeInTheDocument();
  });

  it("plain-text email: the full text with its verification code, no iframe", async () => {
    const text = ["Hola Juan,", "Tu código de verificación es 731904.", "Si no fuiste tú, ignora este mensaje."].join("\n");
    renderPortal(`/portal/email/${DELIVERY}`, fakeApi({ email: vi.fn(async () => detail({ body: { text, html: null } })) }));
    expect(await screen.findByText(/Tu código de verificación es 731904/)).toBeInTheDocument();
    expect(screen.getByText(/Si no fuiste tú, ignora este mensaje/)).toBeInTheDocument();
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
  });

  it("shared body without stored content: 'not available', never an empty box", async () => {
    renderPortal(`/portal/email/${DELIVERY}`, fakeApi({ email: vi.fn(async () => detail({ body: { text: null, html: null } })) }));
    expect(await screen.findByText("El contenido de este correo no está disponible.")).toBeInTheDocument();
    expect(screen.queryByTitle("Contenido del correo")).not.toBeInTheDocument();
    expect(screen.queryByText("(sin contenido de texto)")).not.toBeInTheDocument();
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

  it("logout: no portal request after it (the session is revoked), no 'session ended' notice, and nothing is kept for the next sign-in", async () => {
    const api = fakeApi();
    renderPortal("/portal", api);
    await screen.findByText("Tu código de acceso");
    const unauthorized = () => Promise.reject(new ApiError(401, "UNAUTHORIZED", "La sesión no es válida."));
    const authenticated = ["me", "inbox", "filters", "email", "syncStatus"] as const;
    const answers = authenticated.map((name) => api[name].getMockImplementation());
    // The API revokes the session on logout: from then on every portal request would be answered 401.
    api.logout.mockImplementation(async () => {
      for (const name of authenticated) api[name].mockImplementation(unauthorized);
    });
    const calls = () => authenticated.map((name) => api[name].mock.calls.length);
    const before = calls();
    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    await screen.findByLabelText("Access ID");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(calls()).toEqual(before);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // A new session loads everything from the API again (the previous session's data was dropped).
    authenticated.forEach((name, index) => api[name].mockImplementation(answers[index]!));
    api.inbox.mockImplementation(async () => page([item({ subject: "Correo de la nueva sesión" })]));
    typeAccessId("SP-7KQ9X82MP4Z7");
    fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
    expect(await screen.findByText("Correo de la nueva sesión")).toBeInTheDocument();
    expect(screen.queryByText("Tu código de acceso")).not.toBeInTheDocument();
    expect(api.me.mock.calls.length).toBe(before[0]! + 1);
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

  it("a 401 that arrives while the session request is still pending does not repeat any request (deterministic order)", async () => {
    // Under load the inbox / filters 401s can arrive before /me answers: the expiry must not re-run the pending /me.
    let rejectMe!: (error: unknown) => void;
    const me = vi.fn(() => new Promise((_resolve, reject) => (rejectMe = reject)));
    const unauthorized = () => Promise.reject(new ApiError(401, "UNAUTHORIZED", "La sesión no es válida."));
    const api = fakeApi({ me, inbox: vi.fn(unauthorized), filters: vi.fn(unauthorized) });
    renderPortal("/portal", api);
    expect(await screen.findByRole("status")).toHaveTextContent("Tu sesión terminó. Vuelve a ingresar con tu Access ID.");
    await act(async () => {
      rejectMe(new ApiError(401, "UNAUTHORIZED", "La sesión no es válida."));
    });
    expect(screen.getByLabelText("Access ID")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(api.filters).toHaveBeenCalledTimes(1);
  });
});

describe("portal manual sync (Actualizar)", () => {
  it("renders the button and the backend's last sync time", async () => {
    renderPortal("/portal");
    expect(await screen.findByRole("button", { name: /actualizar/i })).toBeInTheDocument();
    const last = await screen.findByText(/Última sincronización: hace 30 segundos/);
    expect(last.className).toMatch(/hidden/); // compact on mobile
    expect(last.className).toMatch(/sm:inline/);
  });

  it("click: one sync request (no body, no ids), 'Actualizando...', then 'Bandeja actualizada' when new mail arrived", async () => {
    let synced = false;
    const inbox = vi.fn(async () => page(synced ? [item({ deliveryId: "d-new", subject: "Correo nuevo" }), item()] : [item()]));
    const sync = vi.fn(async () => {
      synced = true;
      return { status: "QUEUED" as const, lastSyncAt: null };
    });
    // The status stays pending until released, so the running state can be observed deterministically.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const syncStatus = vi.fn(async () => {
      await gate;
      return { running: false, lastSyncAt: null };
    });
    const { api } = renderPortal("/portal", fakeApi({ inbox, sync, syncStatus }));
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /actualizar/i }));
    const running = await screen.findByRole("button", { name: /actualizando/i });
    expect(running).toBeDisabled();
    expect(running).toHaveAttribute("aria-busy", "true");
    release();
    expect(await screen.findByText("Bandeja actualizada")).toBeInTheDocument();
    expect(await screen.findByText("Correo nuevo")).toBeInTheDocument(); // inbox refreshed through the query, no reload
    expect(api.sync).toHaveBeenCalledTimes(1);
    expect(api.sync).toHaveBeenCalledWith();
    expect(api.inbox.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("'No hay correos nuevos' when the newest email did not change (also with nothing to sync)", async () => {
    const first = renderPortal("/portal");
    await within(first.container).findByText("Tu código de acceso");
    fireEvent.click(within(first.container).getByRole("button", { name: /actualizar/i }));
    expect(await within(first.container).findByText("No hay correos nuevos")).toBeInTheDocument();
    first.unmount();

    const second = renderPortal("/portal", fakeApi({ sync: vi.fn(async () => ({ status: "NOTHING_TO_SYNC" as const, lastSyncAt: null })) }));
    await within(second.container).findByText("Tu código de acceso");
    fireEvent.click(within(second.container).getByRole("button", { name: /actualizar/i }));
    expect(await within(second.container).findByText("No hay correos nuevos")).toBeInTheDocument();
  });

  it("repeated clicks while running produce a single request", async () => {
    let finishStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => (finishStatus = resolve));
    const syncStatus = vi.fn(async () => {
      await statusGate;
      return { running: false, lastSyncAt: null };
    });
    const { api } = renderPortal("/portal", fakeApi({ syncStatus }));
    await screen.findByText("Tu código de acceso");
    const button = screen.getByRole("button", { name: /actualizar/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: /actualizando/i }));
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    finishStatus();
  });

  it("429: 'Espera unos segundos antes de volver a actualizar.'", async () => {
    renderPortal("/portal", fakeApi({ sync: vi.fn(async () => Promise.reject(new ApiError(429, "RATE_LIMITED", "Too many"))) }));
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /actualizar/i }));
    expect(await screen.findByText("Espera unos segundos antes de volver a actualizar.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /actualizar/i })).toBeEnabled();
  });

  it("other errors: 'No pudimos actualizar la bandeja.' without internal details", async () => {
    renderPortal("/portal", fakeApi({ sync: vi.fn(async () => Promise.reject(new ApiError(500, "DATABASE_ERROR", "account 1111 failed"))) }));
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /actualizar/i }));
    expect(await screen.findByText("No pudimos actualizar la bandeja.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("1111");
  });

  it("an expired session during sync goes back to the login page", async () => {
    renderPortal("/portal", fakeApi({ sync: vi.fn(async () => Promise.reject(new ApiError(401, "UNAUTHORIZED", "x"))) }));
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /actualizar/i }));
    expect(await screen.findByLabelText("Access ID")).toBeInTheDocument();
  });

  it("nothing is stored in the browser while syncing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderPortal("/portal");
    await screen.findByText("Tu código de acceso");
    fireEvent.click(screen.getByRole("button", { name: /actualizar/i }));
    await screen.findByText("No hay correos nuevos");
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
  });
});

describe("portal realtime (EmailBot V2 phase 7)", () => {
  it("connects once the session is confirmed and an inbox signal refetches the inbox (debounced)", async () => {
    const realtime = fakeRealtime();
    const { api } = renderPortal("/portal", fakeApi(), realtime.connect);
    await screen.findByText("Tu código de acceso");
    await waitFor(() => expect(realtime.calls).toHaveBeenCalledTimes(1));
    const before = api.inbox.mock.calls.length;
    api.inbox.mockResolvedValue(page([item({ deliveryId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2", subject: "Nuevo código" }), item()]));

    act(() => {
      // Several deliveries of one sync arrive together: one refetch.
      realtime.connections[0]?.handlers.onInboxChanged();
      realtime.connections[0]?.handlers.onInboxChanged();
    });
    expect(await screen.findByText("Nuevo código")).toBeInTheDocument();
    expect(api.inbox.mock.calls.length).toBe(before + 1);
  });

  it("does not connect on the login page (no session)", async () => {
    const realtime = fakeRealtime();
    renderPortal("/portal/login", fakeApi(), realtime.connect);
    await screen.findByLabelText("Access ID");
    expect(realtime.calls).not.toHaveBeenCalled();
  });

  it("a revoked session sends the customer back to the login page", async () => {
    const realtime = fakeRealtime();
    const api = fakeApi();
    renderPortal("/portal", api, realtime.connect);
    await screen.findByText("Tu código de acceso");
    await waitFor(() => expect(realtime.calls).toHaveBeenCalledTimes(1));
    api.me.mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "La sesión no es válida."));
    act(() => realtime.connections[0]?.handlers.onRevoked());
    expect(await screen.findByRole("status")).toHaveTextContent("Tu sesión terminó. Vuelve a ingresar con tu Access ID.");
    expect(realtime.connections[0]?.stop).toHaveBeenCalled();
  });

  it("logging out closes the connection", async () => {
    const realtime = fakeRealtime();
    renderPortal("/portal", fakeApi(), realtime.connect);
    await screen.findByText("Tu código de acceso");
    await waitFor(() => expect(realtime.calls).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    await screen.findByLabelText("Access ID");
    expect(realtime.connections[0]?.stop).toHaveBeenCalled();
  });
});
