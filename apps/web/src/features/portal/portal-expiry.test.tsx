// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type { PortalApi } from "./portal-api";

/*
 * Session expiry race (portal-context.tsx). React Router performs navigations
 * inside a transition, so under load the redirect to /portal/login can still
 * be pending while the expired pages stay mounted and the other 401s arrive.
 * Here the navigation is held until the test releases it, which makes that
 * window deterministic: nothing may be requested again and the redirect must
 * be requested once.
 */

const held = vi.hoisted(() => ({ requested: [] as string[], release: [] as Array<() => void> }));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return (to: string, options?: { replace?: boolean }) => {
        held.requested.push(to);
        held.release.push(() => navigate(to, options));
      };
    }
  };
});

const { PortalApp } = await import("./portal-app");

const unauthorized = () => Promise.reject(new ApiError(401, "UNAUTHORIZED", "La sesión no es válida."));
const flushNotifications = () =>
  act(async () => {
    // React Query notifies observers on the next macrotask; let several rounds run.
    for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("portal session expiry while the redirect is still pending", () => {
  it("no request is repeated, the redirect is requested once, and the portal data is cleared once on the login page", async () => {
    const api = {
      me: vi.fn(unauthorized),
      inbox: vi.fn(unauthorized),
      filters: vi.fn(unauthorized),
      syncStatus: vi.fn(unauthorized)
    } as unknown as PortalApi & Record<"me" | "inbox" | "filters" | "syncStatus", ReturnType<typeof vi.fn>>;
    render(
      <MemoryRouter initialEntries={["/portal"]}>
        <Routes>
          <Route path="/portal/*" element={<PortalApp api={api} realtime={null} />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(held.requested.length).toBeGreaterThan(0));
    await flushNotifications();
    // Redirect still pending: the expired pages are mounted, yet nothing was requested again.
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(api.filters).toHaveBeenCalledTimes(1);
    expect(held.requested).toEqual(["/portal/login?expired=1"]);

    await act(async () => {
      for (const release of held.release.splice(0)) release();
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Tu sesión terminó. Vuelve a ingresar con tu Access ID.");
    await flushNotifications();
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(api.filters).toHaveBeenCalledTimes(1);
    expect(held.requested).toHaveLength(1);
  });
});
