// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

/* Panel navbar: the theme toggle sits with the existing controls, which keep working. */

const signOut = vi.fn(async () => undefined);
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" }, signOut }),
  useUserDisplayName: () => "Ana Pérez"
}));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: () => ({ organization: { id: "org-1", name: "Acme" } }) }));
vi.mock("@/providers/realtime", () => ({ useRealtime: () => "connected" }));
vi.mock("./sidebar", () => ({ Sidebar: () => <nav aria-label="Principal" /> }));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
});

describe("AppShell navbar", () => {
  it("has the theme toggle next to the existing controls; it switches the whole app", () => {
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>
    );
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Acme")).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "Perfil" })).toHaveAttribute("href", "/profile");
    expect(within(header).getByRole("button", { name: "Abrir menú" })).toBeInTheDocument();

    fireEvent.click(within(header).getByRole("button", { name: "Cambiar a modo nocturno" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(within(header).getByRole("button", { name: "Cambiar a modo claro" })).toBeInTheDocument();

    fireEvent.click(within(header).getByRole("button", { name: "Cerrar sesión" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
