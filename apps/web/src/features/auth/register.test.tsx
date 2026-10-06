// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * EmailBot V2 phase 7: signing up requires accepting the Terms and the Privacy
 * Policy. The sign-up metadata only carries `legal_accepted: true`; the
 * database records the server's current versions
 * (supabase/migrations/20261005130200_legal_signup_server_versions.sql,
 * packages/database/test/legal-acceptances.test.ts).
 */

const signUp = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { signUp: (...args: unknown[]) => signUp(...args) } } }));

const { RegisterPage } = await import("./auth-pages");

function renderRegister() {
  render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/onboarding" element={<p>Onboarding</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: "Ana Pérez" } });
  fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "ana@example.com" } });
  fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "contraseña-segura" } });
  fireEvent.change(screen.getByLabelText("Confirmar contraseña"), { target: { value: "contraseña-segura" } });
}

beforeEach(() => {
  signUp.mockReset();
  signUp.mockResolvedValue({ data: { session: null, user: { id: "u1" } }, error: null });
});

describe("register: acceptance of the legal documents", () => {
  it("links to the real Terms and Privacy pages", () => {
    renderRegister();
    expect(screen.getByRole("link", { name: "Términos y Condiciones" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Política de Privacidad" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("cannot sign up without accepting: an error is shown and no account is requested", async () => {
    renderRegister();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
    expect(await screen.findByText("Debes aceptar los Términos y Condiciones y la Política de Privacidad")).toBeInTheDocument();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("accepting sends only the acceptance (never versions: the server decides them) and continues", async () => {
    renderRegister();
    fillForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect(signUp.mock.calls[0]?.[0]).toMatchObject({
      email: "ana@example.com",
      options: { data: { full_name: "Ana Pérez", legal_accepted: true } }
    });
    const data = (signUp.mock.calls[0]?.[0] as { options: { data: Record<string, unknown> } }).options.data;
    expect(Object.keys(data).sort()).toEqual(["full_name", "legal_accepted"]);
    expect(await screen.findByText(/Enviamos un enlace de confirmación/)).toBeInTheDocument();
  });
});
