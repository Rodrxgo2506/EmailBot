// @vitest-environment jsdom
import { CURRENT_LEGAL_VERSIONS, type LegalAcceptanceStatus } from "@emailbot/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";

/*
 * EmailBot V2 phase 7: second barrier after sign-up. A signed-in user whose
 * acceptance of the CURRENT legal versions is not recorded (existing users,
 * accounts created outside the web sign-up, older versions) sees the
 * acceptance screen instead of the panel. The real OrganizationProvider and
 * RequireLegalAcceptance run against a faked API that behaves like
 * apps/api (src/test/legal.test.ts covers the API itself).
 */

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client")), api: { get, post } }));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } }, user: { id: "user-1" }, signOut: vi.fn() })
}));

const { OrganizationProvider } = await import("@/providers/organization-provider");
const { RequireLegalAcceptance } = await import("@/components/layout/guards");
const { LegalAcceptancePage } = await import("./legal-acceptance-page");

const CURRENT = { termsVersion: CURRENT_LEGAL_VERSIONS.terms, privacyVersion: CURRENT_LEGAL_VERSIONS.privacy };
let legal: LegalAcceptanceStatus | undefined;
let memberships: unknown[] = [];
const ORGANIZATION = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme",
  plan: "FREE",
  status: "ACTIVE",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};

function me() {
  return {
    user: { id: "user-1", email: "ana@example.com" },
    memberships,
    isPlatformAdmin: false,
    ...(legal ? { legal } : {})
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderApp(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrganizationProvider>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/legal/accept" element={<LegalAcceptancePage />} />
            <Route element={<RequireLegalAcceptance />}>
              <Route path="/" element={<p>Panel de EmailBot</p>} />
              <Route path="/rules" element={<p>Reglas</p>} />
              <Route path="/onboarding" element={<p>Onboarding</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </OrganizationProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  memberships = [];
  sessionStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === "/api/me") return me();
    throw new Error(`unexpected GET ${path}`);
  });
  // Behaves like the API: records the server's versions for the session user.
  post.mockImplementation(async (path: string) => {
    if (path !== "/api/me/legal-acceptance") return undefined;
    legal = { ...CURRENT, accepted: true };
    return { legal };
  });
});

describe("legal re-acceptance gate", () => {
  it("1. a user with the current acceptance enters the panel normally", async () => {
    legal = { ...CURRENT, accepted: true };
    renderApp("/");
    expect(await screen.findByText("Panel de EmailBot")).toBeInTheDocument();
    expect(screen.queryByText("Términos y privacidad")).not.toBeInTheDocument();
  });

  it("2-3. a user without acceptance cannot see the panel and is sent to the legal screen", async () => {
    legal = { ...CURRENT, accepted: false };
    renderApp("/rules");
    expect(await screen.findByText("Términos y privacidad")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/legal/accept");
    expect(screen.queryByText("Reglas")).not.toBeInTheDocument();
    expect(screen.queryByText("Panel de EmailBot")).not.toBeInTheDocument();
    // Links, current versions from the central configuration, unchecked checkbox, accept button.
    expect(screen.getByRole("link", { name: "Términos y Condiciones" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Política de Privacidad" })).toHaveAttribute("href", "/privacy");
    expect(screen.getAllByText(/· versión /).map((node) => node.textContent)).toEqual([
      `· versión ${CURRENT_LEGAL_VERSIONS.terms}`,
      `· versión ${CURRENT_LEGAL_VERSIONS.privacy}`
    ]);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Aceptar y continuar" })).toBeInTheDocument();
  });

  it("the onboarding (users without an organization) is behind the same gate", async () => {
    legal = { ...CURRENT, accepted: false };
    renderApp("/onboarding");
    expect(await screen.findByText("Términos y privacidad")).toBeInTheDocument();
    expect(screen.queryByText("Onboarding")).not.toBeInTheDocument();
  });

  it("the checkbox is mandatory: nothing is sent without it", async () => {
    legal = { ...CURRENT, accepted: false };
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "Aceptar y continuar" }));
    expect(await screen.findByText("Debes aceptar los Términos y Condiciones y la Política de Privacidad")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("4/6. accepting sends the current versions (only them) and continues to the page the user wanted", async () => {
    legal = { ...CURRENT, accepted: false };
    renderApp("/rules");
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar y continuar" }));
    expect(await screen.findByText("Reglas")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    // No user id, date or organization travels: the API records the session user with the database time.
    expect(post).toHaveBeenCalledWith("/api/me/legal-acceptance", CURRENT);
    expect(screen.getByTestId("where")).toHaveTextContent("/rules");
  });

  it("5. a user who accepted an older version (the API reports it as not accepted) must accept again", async () => {
    legal = { termsVersion: "2.1", privacyVersion: CURRENT_LEGAL_VERSIONS.privacy, accepted: false };
    renderApp("/");
    expect(await screen.findByText("Términos y privacidad")).toBeInTheDocument();
    expect(screen.queryByText("Panel de EmailBot")).not.toBeInTheDocument();
  });

  it("a page opened before a new version was published cannot accept it: the user is asked to reload", async () => {
    legal = { ...CURRENT, accepted: false };
    post.mockRejectedValue(new ApiError(409, "LEGAL_VERSION_OUTDATED", "The legal documents changed"));
    renderApp("/");
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Aceptar y continuar" }));
    expect(await screen.findByText(/Recarga la página para ver la versión vigente/)).toBeInTheDocument();
    expect(screen.queryByText("Panel de EmailBot")).not.toBeInTheDocument();
  });

  it("an accepted user who opens /legal/accept goes back to the panel", async () => {
    legal = { ...CURRENT, accepted: true };
    renderApp("/legal/accept");
    expect(await screen.findByText("Panel de EmailBot")).toBeInTheDocument();
  });

  it("an API that does not report `legal` yet (deployed before this web version) does not lock users out", async () => {
    legal = undefined;
    renderApp("/");
    expect(await screen.findByText("Panel de EmailBot")).toBeInTheDocument();
  });

  it("the login audit event (refused by the API until acceptance) is sent only after accepting", async () => {
    const { markPendingLoginEvent } = await import("@/lib/login-event");
    legal = { ...CURRENT, accepted: false };
    memberships = [{ role: "OWNER", organization: ORGANIZATION }];
    markPendingLoginEvent();
    renderApp("/");
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(post.mock.calls.map(([path]) => path)).not.toContain("/api/me/login-event");
    fireEvent.click(screen.getByRole("button", { name: "Aceptar y continuar" }));
    expect(await screen.findByText("Panel de EmailBot")).toBeInTheDocument();
    await waitFor(() => expect(post.mock.calls.map(([path]) => path)).toEqual(["/api/me/legal-acceptance", "/api/me/login-event"]));
  });

  it("if /api/me fails, the panel is not shown either", async () => {
    get.mockRejectedValue(new ApiError(500, "DATABASE_ERROR", "Unexpected database error"));
    renderApp("/");
    await waitFor(() => expect(screen.queryByText("Panel de EmailBot")).not.toBeInTheDocument());
    expect(await screen.findByText(/Unexpected database error|error/i)).toBeInTheDocument();
  });
});
