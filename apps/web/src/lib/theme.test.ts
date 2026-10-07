// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BOOT_SCRIPT from "../../public/theme-init.js?raw";
import { currentTheme, ensureThemeApplied, setTheme, THEME_STORAGE_KEY } from "./theme";

/*
 * Light / dark theme: <html data-theme> drives the existing tokens. public/theme-init.js applies it before
 * the first paint; src/lib/theme.ts changes and remembers it. Without a saved choice: the system preference.
 */

const runBootScript = () => new Function(BOOT_SCRIPT)();

function systemPrefers(theme: "light" | "dark") {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query === "(prefers-color-scheme: dark)" && theme === "dark", addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.unstubAllGlobals());

describe("boot script (before the first paint)", () => {
  it("uses the same storage key as the app", () => {
    expect(BOOT_SCRIPT).toContain(`"${THEME_STORAGE_KEY}"`);
  });

  it.each(["light", "dark"] as const)("without a saved choice follows the system (%s)", (system) => {
    systemPrefers(system);
    runBootScript();
    expect(document.documentElement.dataset.theme).toBe(system);
  });

  it("a saved choice wins over the system", () => {
    systemPrefers("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    runBootScript();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores an unknown saved value", () => {
    systemPrefers("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    runBootScript();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("theme module", () => {
  it("setTheme applies the theme to the whole document and remembers it", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(currentTheme()).toBe("dark");
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("ensureThemeApplied sets the attribute only when the boot script did not", () => {
    systemPrefers("dark");
    ensureThemeApplied();
    expect(document.documentElement.dataset.theme).toBe("dark");
    document.documentElement.dataset.theme = "light";
    ensureThemeApplied();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("storage unavailable (private mode): the theme still changes for the page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    vi.restoreAllMocks();
  });
});
