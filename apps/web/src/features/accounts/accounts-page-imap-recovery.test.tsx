// @vitest-environment jsdom
import type { EmailAccount, EmailProviderAvailability, Organization } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { imapAccountCreateSchema } from "@emailbot/validation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { ACCOUNT_ERROR_LABELS, IMAP_ACCOUNT_ERROR_FALLBACK, IMAP_ACCOUNT_ERROR_LABELS, IMAP_RECONNECT_HINT } from "@/lib/labels";
import { OrganizationContext, type OrganizationContextValue } from "@/providers/organization-provider";

/*
 * IMAP M1.6 (W1): an IMAP mailbox in ERROR is never resumed (H1). The card explains the error in Spanish
 * (never the worker's English text) and offers "Reconectar", which opens the existing IMAP dialog with the
 * mailbox address fixed: the same route as a new account (POST /api/email-accounts/imap: connection test
 * with the E4 limits, then PAUSED). Gmail / Microsoft keep their flow.
 */

const { get, post, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post, patch, delete: vi.fn() } }));
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

/** The worker's English messages (packages/shared/src/imap-client.ts, apps/worker/src/...): never shown for IMAP. */
const WORKER_TEXT: Record<string, string> = {
  IMAP_AUTH_FAILED: "The mailbox authorization is no longer valid. Reconnect the account.",
  IMAP_CREDENTIALS_MISSING: "The IMAP login is not stored. Connect the mailbox again.",
  IMAP_HOST_FORBIDDEN: "The IMAP server is not an allowed destination",
  IMAP_TLS_FAILED: "The IMAP server's certificate or TLS connection could not be verified",
  IMAP_STARTTLS_UNAVAILABLE: "The IMAP server does not offer a secure (STARTTLS) connection",
  IMAP_RESPONSE_TOO_LARGE: "The IMAP server sent an answer larger than allowed",
  IMAP_SETTINGS_INVALID: "The stored IMAP settings are not valid; connect the mailbox again"
};

const account = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
  id: "imap-9",
  organizationId: ORG,
  provider: "IMAP",
  status: "ERROR",
  emailAddress: "ventas@acme.test",
  displayName: null,
  lastSyncedAt: null,
  lastErrorCode: "IMAP_AUTH_FAILED",
  lastErrorMessage: WORKER_TEXT.IMAP_AUTH_FAILED ?? null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides
});

let providers: EmailProviderAvailability;
let accounts: EmailAccount[];

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  providers = { GMAIL: true, MICROSOFT: true, IMAP: true };
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

describe("M1.6 (W1): IMAP mailbox in ERROR", () => {
  it("1. a refused login is explained in Spanish, with the reconnect instruction; the worker's English text is not shown", async () => {
    accounts = [account()];
    renderPage();
    expect(await screen.findByText(IMAP_ACCOUNT_ERROR_LABELS.IMAP_AUTH_FAILED!)).toBeInTheDocument();
    expect(screen.getByText(IMAP_RECONNECT_HINT)).toBeInTheDocument();
    expect(IMAP_RECONNECT_HINT).toMatch(/Reconecta el buzón para validar de nuevo la conexión/);
    expect(screen.queryByText(WORKER_TEXT.IMAP_AUTH_FAILED!)).not.toBeInTheDocument();
  });

  it.each(["IMAP_CREDENTIALS_MISSING", "IMAP_HOST_FORBIDDEN", "IMAP_TLS_FAILED", "IMAP_STARTTLS_UNAVAILABLE", "IMAP_RESPONSE_TOO_LARGE", "IMAP_SETTINGS_INVALID"])(
    "2. %s: Spanish message and reconnect instruction, never the worker's technical English text",
    async (code) => {
      accounts = [account({ lastErrorCode: code, lastErrorMessage: WORKER_TEXT[code] ?? null })];
      renderPage();
      expect(await screen.findByText(IMAP_ACCOUNT_ERROR_LABELS[code]!)).toBeInTheDocument();
      expect(screen.getByText(IMAP_RECONNECT_HINT)).toBeInTheDocument();
      expect(screen.queryByText(WORKER_TEXT[code]!)).not.toBeInTheDocument();
    }
  );

  it("2b. an unknown or missing code shows the generic Spanish message, never the stored text", async () => {
    accounts = [
      account({ id: "imap-1", emailAddress: "uno@acme.test", lastErrorCode: "SOMETHING_NEW", lastErrorMessage: "Internal detail from imap.internal.example: x" }),
      account({ id: "imap-2", emailAddress: "dos@acme.test", lastErrorCode: null, lastErrorMessage: null })
    ];
    renderPage();
    expect(await screen.findAllByText(IMAP_ACCOUNT_ERROR_FALLBACK)).toHaveLength(2);
    expect(screen.queryByText(/Internal detail/)).not.toBeInTheDocument();
  });

  it("2c. the labels carry no server, user or technical detail and every one is Spanish", () => {
    for (const text of [...Object.values(IMAP_ACCOUNT_ERROR_LABELS), IMAP_ACCOUNT_ERROR_FALLBACK, IMAP_RECONNECT_HINT]) {
      expect(text).not.toMatch(/https?:|@|\b\d{2,5}\b|imap\.[a-z]/i);
      expect(text).not.toMatch(/\b(the|server|could|not|connection)\b/);
    }
  });

  it("3+4+5. 'Reconectar' opens the existing IMAP dialog with this mailbox's address fixed; no 'Reanudar'; the existing route is used, never a resume", async () => {
    accounts = [account()];
    post.mockResolvedValue({ account: account({ status: "PAUSED", lastErrorCode: "IMAP_ACTIVATION_PENDING" }) });
    renderPage();
    const card = (await screen.findByText("ventas@acme.test")).closest("div.rounded-xl, [class*='card']") ?? document.body;
    expect(within(card as HTMLElement).queryByRole("button", { name: /Reanudar/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Reconectar/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reconectar cuenta IMAP")).toBeInTheDocument();
    const email = within(dialog).getByLabelText("Correo") as HTMLInputElement;
    await waitFor(() => expect(email.value).toBe("ventas@acme.test"));
    expect(email.readOnly).toBe(true);
    // Nothing stored is sent to the browser: server, user and password are typed again.
    expect((within(dialog).getByLabelText("Contraseña") as HTMLInputElement).value).toBe("");

    fireEvent.input(within(dialog).getByLabelText("Servidor IMAP"), { target: { value: "imap.acme-mail.com" } });
    fireEvent.input(within(dialog).getByLabelText("Usuario"), { target: { value: "ventas@acme.test" } });
    fireEvent.input(within(dialog).getByLabelText("Contraseña"), { target: { value: "otra-clave-de-prueba" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Guardar cuenta/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/email-accounts/imap", expect.objectContaining({ emailAddress: "ventas@acme.test" })));
    expect(post).toHaveBeenCalledTimes(1);
    // M1.7 (D1): the body really sent is accepted by the API's strict schema (security, never secure).
    const body = post.mock.calls[0]![1];
    expect(body).toEqual({ emailAddress: "ventas@acme.test", host: "imap.acme-mail.com", port: 993, security: "TLS", username: "ventas@acme.test", password: "otra-clave-de-prueba" });
    expect(imapAccountCreateSchema.safeParse(body).success).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("'Agregar IMAP' still opens the add dialog (editable address, add title)", async () => {
    accounts = [account()];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Agregar IMAP/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Agregar cuenta IMAP")).toBeInTheDocument();
    const email = within(dialog).getByLabelText("Correo") as HTMLInputElement;
    expect(email.value).toBe("");
    expect(email.readOnly).toBe(false);
  });

  it("IMAP unavailable on the server: the error is explained but no reconnect action is offered", async () => {
    providers = { GMAIL: true, MICROSOFT: true, IMAP: false };
    accounts = [account()];
    renderPage();
    expect(await screen.findByText(IMAP_ACCOUNT_ERROR_LABELS.IMAP_AUTH_FAILED!)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconectar|Reanudar/ })).not.toBeInTheDocument();
  });

  it("6. DISCONNECTED IMAP: no reconnect / resume action (only delete), no ERROR explanation", async () => {
    accounts = [account({ status: "DISCONNECTED", lastErrorCode: null, lastErrorMessage: null })];
    renderPage();
    expect(await screen.findByRole("button", { name: /Eliminar/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconectar|Reanudar/ })).not.toBeInTheDocument();
    expect(screen.queryByText(IMAP_RECONNECT_HINT)).not.toBeInTheDocument();
  });

  it("7. VIEWER: sees the explanation, gets no management action", async () => {
    accounts = [account()];
    renderPage("VIEWER");
    expect(await screen.findByText(IMAP_ACCOUNT_ERROR_LABELS.IMAP_AUTH_FAILED!)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconectar|Reanudar|Desconectar|Agregar IMAP/ })).not.toBeInTheDocument();
  });

  it("8. a valid PAUSED IMAP mailbox keeps 'Reanudar' and its pending explanation, with no reconnect action", async () => {
    accounts = [account({ status: "PAUSED", lastErrorCode: "IMAP_ACTIVATION_PENDING", lastErrorMessage: "Mailbox connected and paused. Resume it to start synchronizing new mail." })];
    patch.mockResolvedValue({ account: account({ status: "ACTIVE", lastErrorCode: null, lastErrorMessage: null }) });
    renderPage();
    expect(await screen.findByText(ACCOUNT_ERROR_LABELS.IMAP_ACTIVATION_PENDING!)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconectar/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Reanudar/ }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/email-accounts/imap-9", { status: "ACTIVE" }));
  });
});

describe("M1.6 (W1): Gmail / Microsoft unchanged", () => {
  it("9. Gmail / Microsoft in ERROR keep their texts (known label or the stored message), 'Reanudar' and the OAuth 'Reconectar'", async () => {
    accounts = [
      account({ id: "g-1", provider: "GMAIL", emailAddress: "g@acme.test", lastErrorCode: "AUTH_REVOKED", lastErrorMessage: "The refresh token was revoked or expired" }),
      account({ id: "m-1", provider: "MICROSOFT", emailAddress: "m@acme.test", lastErrorCode: "GRAPH_SOMETHING", lastErrorMessage: "Stored provider message" })
    ];
    renderPage();
    expect(await screen.findByText(ACCOUNT_ERROR_LABELS.AUTH_REVOKED!)).toBeInTheDocument();
    expect(screen.getByText("Stored provider message")).toBeInTheDocument();
    expect(screen.queryByText(IMAP_ACCOUNT_ERROR_FALLBACK)).not.toBeInTheDocument();
    expect(screen.queryByText(IMAP_RECONNECT_HINT)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Reanudar/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Reconectar/ })).toHaveLength(2);
  });

  it("9b. the OAuth 'Reconectar' still starts OAuth, never the IMAP dialog", async () => {
    accounts = [account({ id: "g-1", provider: "GMAIL", emailAddress: "g@acme.test", lastErrorCode: "AUTH_REVOKED", lastErrorMessage: "x" })];
    post.mockResolvedValue({ authorizationUrl: "https://accounts.example/consent" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Reconectar/ }));
      await waitFor(() => expect(post).toHaveBeenCalledWith("/api/email-accounts/oauth/gmail/start"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ================================================================ M1.7 (D1): the dialog's body and texts */

async function openDialog(mode: "add" | "reconnect") {
  fireEvent.click(await screen.findByRole("button", { name: mode === "add" ? /Agregar IMAP/ : /Reconectar/ }));
  return screen.findByRole("dialog");
}
function fill(dialog: HTMLElement, fields: { email?: string; host?: string; port?: string; user?: string; password?: string }) {
  if (fields.email !== undefined) fireEvent.input(within(dialog).getByLabelText("Correo"), { target: { value: fields.email } });
  if (fields.host !== undefined) fireEvent.input(within(dialog).getByLabelText("Servidor IMAP"), { target: { value: fields.host } });
  if (fields.port !== undefined) fireEvent.input(within(dialog).getByLabelText("Puerto"), { target: { value: fields.port } });
  if (fields.user !== undefined) fireEvent.input(within(dialog).getByLabelText("Usuario"), { target: { value: fields.user } });
  if (fields.password !== undefined) fireEvent.input(within(dialog).getByLabelText("Contraseña"), { target: { value: fields.password } });
}

describe("M1.7 (D1): IMAP dialog body = the API's strict schema", () => {
  it.each([
    ["add", "993", "TLS"],
    ["add", "143", "STARTTLS"],
    ["reconnect", "993", "TLS"],
    ["reconnect", "143", "STARTTLS"]
  ] as const)("%s, port %s: posts security %s, no secure, no unknown key; the real schema accepts it", async (mode, port, security) => {
    accounts = [account()];
    post.mockResolvedValue({ account: account({ status: "PAUSED", lastErrorCode: "IMAP_ACTIVATION_PENDING" }) });
    renderPage();
    const dialog = await openDialog(mode);
    if (mode === "reconnect") await waitFor(() => expect((within(dialog).getByLabelText("Correo") as HTMLInputElement).value).toBe("ventas@acme.test"));
    fill(dialog, { ...(mode === "add" ? { email: "nueva@acme.test" } : {}), host: "imap.acme-mail.com", port, user: "usuario-prueba", password: "clave-de-prueba-m17" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Guardar cuenta/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe("/api/email-accounts/imap");
    expect(body).toEqual({
      emailAddress: mode === "add" ? "nueva@acme.test" : "ventas@acme.test",
      host: "imap.acme-mail.com",
      port: Number(port),
      security,
      username: "usuario-prueba",
      password: "clave-de-prueba-m17"
    });
    expect(body).not.toHaveProperty("secure");
    const parsed = imapAccountCreateSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("a port without an allowed transport is refused in the form (no request, never plaintext)", async () => {
    accounts = [account()];
    renderPage();
    const dialog = await openDialog("add");
    fill(dialog, { email: "nueva@acme.test", host: "imap.acme-mail.com", port: "110", user: "usuario-prueba", password: "clave-de-prueba-m17" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Guardar cuenta/ }));
    expect(await within(dialog).findByText("Usa el puerto 993 (TLS) o 143 (STARTTLS)")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("a validation refusal from the API is shown in the dialog (Spanish message, never the server text)", async () => {
    accounts = [account()];
    post.mockRejectedValue(new ApiError(400, "VALIDATION_ERROR", "Request body is invalid: internal detail"));
    renderPage();
    const dialog = await openDialog("reconnect");
    await waitFor(() => expect((within(dialog).getByLabelText("Correo") as HTMLInputElement).value).toBe("ventas@acme.test"));
    fill(dialog, { host: "imap.acme-mail.com", port: "993", user: "usuario-prueba", password: "clave-de-prueba-m17" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Guardar cuenta/ }));
    expect(await within(dialog).findByText("Revisa los datos del formulario.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/internal detail/)).not.toBeInTheDocument();
  });

  it("the add dialog no longer says synchronization is pending implementation: paused, nothing synchronized until activated", async () => {
    accounts = [];
    renderPage();
    const dialog = await openDialog("add");
    expect(within(dialog).getByText(/La cuenta quedará en pausa: no se sincronizará ningún correo hasta que se active./)).toBeInTheDocument();
    expect(within(dialog).getByText("Puerto 993: TLS. Puerto 143: STARTTLS. No se admiten conexiones sin cifrar.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/pendiente de implementación|aún no está disponible/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("after a successful add: the confirmation says paused and not synchronized until activated", async () => {
    const { toast } = await import("sonner");
    accounts = [];
    post.mockResolvedValue({ account: account({ status: "PAUSED", lastErrorCode: "IMAP_ACTIVATION_PENDING" }) });
    renderPage();
    const dialog = await openDialog("add");
    fill(dialog, { email: "nueva@acme.test", host: "imap.acme-mail.com", port: "143", user: "usuario-prueba", password: "clave-de-prueba-m17" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Guardar cuenta/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Cuenta IMAP guardada en pausa. No se sincronizará ningún correo hasta que se active."));
  });
});
