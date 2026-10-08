// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "@/components/layout/guards";
import { ApiError } from "@/lib/api-client";
import { PLAN_CATALOG } from "@/test/plan-catalog-fixture";

/*
 * Public site (Culqi phase 1): home for anonymous visitors, contact, the virtual Libro de Reclamaciones and the
 * shared footer. The API is faked; validation, the correlative and rate limiting are covered by apps/api and
 * packages/database.
 */

const { get, post, auth } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  auth: { session: null as { user: { id: string } } | null, loading: false }
}));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post } }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ session: auth.session, user: auth.session?.user ?? null, loading: auth.loading }) }));

const { HomePage } = await import("./home-page");
const { ContactPage } = await import("./contact-page");
const { ComplaintsBookPage } = await import("./complaints-book-page");
const { RefundPolicyPage } = await import("@/features/legal/refund-policy-page");

function renderAt(element: ReactElement, path = "/") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </QueryClientProvider>
  );
}

const footer = () => screen.getByRole("contentinfo");
const description = () => document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "";

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  auth.session = null;
  auth.loading = false;
  document.documentElement.dataset.theme = "light";
  get.mockImplementation(async (path: string) => {
    if (path === "/api/plans") return { items: PLAN_CATALOG };
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("public footer", () => {
  it("links plans, contact, every legal page and the Libro de Reclamaciones, with the public email and address and no social networks", () => {
    renderAt(<ContactPage />, "/contacto");
    const links = within(footer()).getAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));
    for (const href of ["/planes", "/contacto", "/terms", "/privacy", "/cambios-devoluciones", "/libro-de-reclamaciones", "mailto:soporte@emailbot.app"]) {
      expect(hrefs).toContain(href);
    }
    expect(within(footer()).getByRole("link", { name: /Libro de Reclamaciones/ })).toHaveAttribute("href", "/libro-de-reclamaciones");
    expect(footer()).toHaveTextContent("Jr Manco Cápac 653");
    expect(footer()).toHaveTextContent("Pucallpa, Ucayali, Perú");
    expect(hrefs.some((href) => /facebook|instagram|twitter|x\.com|linkedin|tiktok|youtube|whatsapp/i.test(href ?? ""))).toBe(false);
  });
});

describe("home (/)", () => {
  it("explains the product and offers plans, register and login, with prices from GET /api/plans", async () => {
    renderAt(<HomePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Automatiza y organiza los correos que recibes" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Crear cuenta" })[0]).toHaveAttribute("href", "/register");
    expect(screen.getAllByRole("link", { name: /Iniciar sesión/ })[0]).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("link", { name: "Ver planes y precios" })[0]).toHaveAttribute("href", "/planes");
    expect(screen.getAllByRole("link", { name: "Contacto" })[0]).toHaveAttribute("href", "/contacto");
    expect(await screen.findByText(/Planes desde S\/ 19\.90 al mes/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/plans");
    expect(document.title).toBe("EmailBot · Automatiza y organiza los correos que recibes");
    expect(description()).toMatch(/EmailBot conecta tus cuentas de correo/);
  });

  it("without the catalog it does not invent prices", async () => {
    get.mockRejectedValue(new Error("offline"));
    renderAt(<HomePage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByTestId("plans-teaser")).toHaveTextContent("Planes mensuales y anuales en soles, IGV incluido.");
    expect(screen.getByTestId("plans-teaser")).not.toHaveTextContent(/S\/ \d/);
  });

  it("the theme toggle switches between light and dark", () => {
    renderAt(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Cambiar a modo nocturno" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Cambiar a modo claro" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("/ routing", () => {
  const app = (
    <Routes>
      <Route element={<RequireAuth anonymousHome={<p>Inicio público</p>} />}>
        <Route path="/" element={<p>Panel</p>} />
        <Route path="/inbox" element={<p>Bandeja</p>} />
      </Route>
      <Route path="/login" element={<p>Login</p>} />
    </Routes>
  );

  it("anonymous visitors see the public home at / and are sent to /login elsewhere", () => {
    renderAt(app, "/");
    expect(screen.getByText("Inicio público")).toBeInTheDocument();
    expect(screen.queryByText("Panel")).not.toBeInTheDocument();
  });

  it("anonymous visitors of a private page go to /login", () => {
    renderAt(app, "/inbox");
    expect(screen.getByText("Login")).toBeInTheDocument();
  });

  it("signed-in users keep the panel at /", () => {
    auth.session = { user: { id: "u1" } };
    renderAt(app, "/");
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(screen.queryByText("Inicio público")).not.toBeInTheDocument();
  });
});

describe("/contacto", () => {
  it("shows the support email, the phone already defined and the public address, without opening hours", () => {
    renderAt(<ContactPage />, "/contacto");
    const main = screen.getByRole("main");
    expect(screen.getByRole("heading", { level: 1, name: "Contacto" })).toBeInTheDocument();
    expect(within(main).getAllByRole("link", { name: "soporte@emailbot.app" })[0]).toHaveAttribute("href", "mailto:soporte@emailbot.app");
    expect(within(main).getAllByRole("link", { name: /971458658/ })[0]).toHaveAttribute("href", "tel:971458658");
    expect(main).toHaveTextContent("Jr Manco Cápac 653");
    expect(within(main).getAllByRole("link", { name: /Libro de Reclamaciones/ })[0]).toHaveAttribute("href", "/libro-de-reclamaciones");
    expect(main).not.toHaveTextContent(/horario|lunes|a\.\s?m\.|p\.\s?m\./i);
    expect(document.title).toBe("Contacto · EmailBot");
  });
});

describe("/cambios-devoluciones", () => {
  it("states the cancellation and refund policy without deadlines or percentages", () => {
    renderAt(<RefundPolicyPage />, "/cambios-devoluciones");
    const main = screen.getByRole("main");
    expect(screen.getByRole("heading", { level: 1, name: "Cambios, devoluciones y cancelación" })).toBeInTheDocument();
    expect(main).toHaveTextContent("Puedes cancelar tu suscripción en cualquier momento.");
    expect(main).toHaveTextContent("evita la siguiente renovación automática");
    expect(main).toHaveTextContent("Conservas el acceso al servicio hasta que termine el periodo que ya pagaste.");
    expect(main).toHaveTextContent("no genera una devolución prorrateada");
    for (const exception of ["cobro duplicado", "error atribuible a EmailBot", "falla técnica grave atribuible a EmailBot", "transacción que no reconoces", "cuando la ley lo exija"]) {
      expect(main).toHaveTextContent(exception);
    }
    expect(main).not.toHaveTextContent(/\d+\s?%|\d+\s+días/);
    expect(document.title).toBe("Cambios, devoluciones y cancelación · EmailBot");
  });
});

describe("/libro-de-reclamaciones", () => {
  const RECEIPT = { code: "LR-2026-000042", number: 42, kind: "RECLAMO", createdAt: "2026-10-07T21:30:00.000Z", confirmationEmail: "SENT" };

  function fillValid() {
    fireEvent.change(screen.getByLabelText("Nombres"), { target: { value: "María" } });
    fireEvent.change(screen.getByLabelText("Apellidos"), { target: { value: "Pérez Soto" } });
    fireEvent.change(screen.getByLabelText("Número de documento"), { target: { value: "12345678" } });
    fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: "Maria@Example.com" } });
    fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "987654321" } });
    fireEvent.change(screen.getByLabelText("Domicilio"), { target: { value: "Av. Siempre Viva 123, Lima" } });
    fireEvent.change(screen.getByLabelText(/Descripción/), { target: { value: "Plan Pro mensual" } });
    fireEvent.change(screen.getByLabelText(/Monto reclamado/), { target: { value: "39.90" } });
    fireEvent.change(screen.getByLabelText("Detalle"), { target: { value: "Se me cobró dos veces el mismo mes." } });
    fireEvent.change(screen.getByLabelText("Pedido"), { target: { value: "Devolución del cobro duplicado." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Declaro que la información es verdadera/ }));
  }

  it("shows the required intro, the provider data and the INDECOPI legends", () => {
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    expect(screen.getByRole("heading", { level: 1, name: "Libro de Reclamaciones" })).toBeInTheDocument();
    expect(screen.getByText("Este formulario permite registrar una queja o reclamo relacionado con los productos o servicios de EmailBot.")).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("10733272231");
    expect(main).toHaveTextContent("Jr Manco Cápac 653, Pucallpa, Ucayali, Perú");
    expect(main).toHaveTextContent(/no impide acudir a otras vías de solución de controversias/);
    expect(main).toHaveTextContent(/quince \(15\) días hábiles/);
    expect(screen.getByRole("radio", { name: /Reclamo/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Queja/ })).not.toBeChecked();
    expect(document.title).toBe("Libro de Reclamaciones · EmailBot");
  });

  it("validates on the client and sends nothing when the form is incomplete", async () => {
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(3);
    expect(post).not.toHaveBeenCalled();
  });

  it("asks for the parent or guardian when the consumer is a minor", async () => {
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    expect(screen.queryByLabelText("Nombre del padre, madre o apoderado")).not.toBeInTheDocument();
    fillValid();
    fireEvent.click(screen.getByRole("checkbox", { name: "Soy menor de edad" }));
    expect(screen.getByLabelText("Nombre del padre, madre o apoderado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    expect(await screen.findByText("Indica el nombre del padre, madre o apoderado")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("submits a valid sheet and shows the number, the date and the advice to keep the number", async () => {
    post.mockResolvedValue(RECEIPT);
    window.scrollTo = vi.fn();
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));

    expect(await screen.findByRole("heading", { name: "Recibimos tu reclamo" })).toBeInTheDocument();
    expect(screen.getByTestId("complaint-code")).toHaveTextContent("LR-2026-000042");
    expect(screen.getByText(/Conserva este número/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Recibimos tu reclamo" })).getByText(/7 de octubre de 2026/)).toBeInTheDocument();
    expect(screen.getByTestId("complaint-copy-status")).toHaveTextContent("Te enviamos una copia de tu hoja de reclamación al correo que indicaste.");
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("/api/complaints-book");
    expect(body).toMatchObject({
      kind: "RECLAMO",
      firstNames: "María",
      documentType: "DNI",
      documentNumber: "12345678",
      email: "maria@example.com",
      goodType: "SERVICIO",
      claimedAmount: "39.90",
      isMinor: false,
      confirmTruth: true,
      submissionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    });

    fireEvent.click(screen.getByRole("button", { name: "Registrar otra hoja" }));
    expect(screen.getByRole("form", { name: "Hoja de reclamación" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nombres")).toHaveValue("");

    // The next sheet gets a new submission id.
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect((post.mock.calls[1]![1] as { submissionId: string }).submissionId).not.toBe((body as { submissionId: string }).submissionId);
  });

  it("a retry of the same form after an error sends the same submission id (no second sheet)", async () => {
    post.mockRejectedValueOnce(new ApiError(0, "NETWORK_ERROR", "offline")).mockResolvedValueOnce(RECEIPT);
    window.scrollTo = vi.fn();
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    });
    await screen.findByText(/No se pudo conectar/);
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    expect(await screen.findByTestId("complaint-code")).toHaveTextContent("LR-2026-000042");
    const ids = post.mock.calls.map((call) => (call[1] as { submissionId: string }).submissionId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("when the copy could not be e-mailed, the sheet is still confirmed and the consumer is told to keep the receipt", async () => {
    post.mockResolvedValue({ ...RECEIPT, confirmationEmail: "FAILED" });
    window.scrollTo = vi.fn();
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    expect(await screen.findByTestId("complaint-code")).toHaveTextContent("LR-2026-000042");
    expect(screen.getByTestId("complaint-copy-status")).toHaveTextContent(/quedó registrada, pero todavía no pudimos confirmar el envío de la copia/);
    expect(screen.getByTestId("complaint-copy-status")).toHaveTextContent(/Imprime o guarda esta constancia/);
  });

  it("can register a queja", async () => {
    post.mockResolvedValue({ ...RECEIPT, kind: "QUEJA" });
    window.scrollTo = vi.fn();
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fillValid();
    fireEvent.click(screen.getByRole("radio", { name: /Queja/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    expect(await screen.findByRole("heading", { name: "Recibimos tu queja" })).toBeInTheDocument();
    expect(post.mock.calls[0]![1]).toMatchObject({ kind: "QUEJA" });
  });

  it("shows the API error and keeps the form (for example, too many submissions)", async () => {
    post.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Demasiadas solicitudes. Intenta de nuevo más tarde."));
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fillValid();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    });
    expect(await screen.findByText(/Demasiadas solicitudes|Intenta de nuevo/)).toBeInTheDocument();
    expect(screen.queryByTestId("complaint-code")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nombres")).toHaveValue("María");
  });

  it("renders submitted text as text (no HTML injection)", async () => {
    post.mockResolvedValue({ ...RECEIPT, code: "<img src=x onerror=alert(1)>" });
    window.scrollTo = vi.fn();
    renderAt(<ComplaintsBookPage />, "/libro-de-reclamaciones");
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Enviar hoja de reclamación" }));
    expect(await screen.findByTestId("complaint-code")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img[src=x]")).toBeNull();
  });
});
