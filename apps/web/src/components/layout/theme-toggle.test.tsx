// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeToggle } from "./theme-toggle";

/* Navbar theme toggle: shows the action, switches the whole document and remembers the choice. */

type ChangeListener = () => void;
let systemDark = false;
const systemListeners = new Set<ChangeListener>();

beforeEach(() => {
  localStorage.clear();
  systemDark = false;
  systemListeners.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_type: string, listener: ChangeListener) => systemListeners.add(listener),
      removeEventListener: (_type: string, listener: ChangeListener) => systemListeners.delete(listener)
    }))
  );
  document.documentElement.dataset.theme = "light";
});
afterEach(() => vi.unstubAllGlobals());

const html = () => document.documentElement.dataset.theme;

describe("ThemeToggle", () => {
  it("light -> dark -> light, with the action as the accessible name, remembered for the next visit", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Cambiar a modo nocturno" });
    expect(button).toHaveAttribute("title", "Cambiar a modo nocturno");

    fireEvent.click(button);
    expect(html()).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Cambiar a modo claro" })).toBe(button);

    fireEvent.click(button);
    expect(html()).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: "Cambiar a modo nocturno" })).toBe(button);
  });

  it("starts from the theme already applied (e.g. dark from the boot script)", () => {
    document.documentElement.dataset.theme = "dark";
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Cambiar a modo claro" })).toBeInTheDocument();
  });

  it("every toggle on the page shows the same theme", () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Cambiar a modo nocturno" })[0] as HTMLElement);
    expect(screen.getAllByRole("button", { name: "Cambiar a modo claro" })).toHaveLength(2);
  });

  it("follows the system while nothing was chosen, not after a choice", () => {
    render(<ThemeToggle />);
    const systemChanges = () => act(() => systemListeners.forEach((listener) => listener()));
    systemDark = true;
    systemChanges();
    expect(html()).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Cambiar a modo claro" }));
    expect(html()).toBe("light");
    systemDark = true;
    systemChanges();
    expect(html()).toBe("light");
  });
});
