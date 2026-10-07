import { useCallback, useSyncExternalStore } from "react";

/*
 * Light / dark theme: the existing design tokens (index.css) switch on <html data-theme>.
 * public/theme-init.js sets the attribute before the first paint; this module reads it,
 * changes it from the navbar toggle and remembers the user's choice. Without a saved
 * choice the theme follows the operating system (the previous, automatic behaviour).
 */

export type Theme = "light" | "dark";

/** Same key and rule as public/theme-init.js. */
export const THEME_STORAGE_KEY = "emailbot.theme";

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

function systemTheme(): Theme {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | null {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null; // storage unavailable (private mode): follow the system
  }
}

/** The theme the page shows (the attribute), resolving it if the boot script did not run. */
export function currentTheme(): Theme {
  const applied = document.documentElement.dataset.theme;
  return isTheme(applied) ? applied : (storedTheme() ?? systemTheme());
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function apply(theme: Theme): void {
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  notify();
}

/** Applies the theme everywhere at once and remembers it (this browser). */
export function setTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  apply(theme);
}

/** Safety net when public/theme-init.js did not run (e.g. tests): sets the attribute once. */
export function ensureThemeApplied(): void {
  if (!isTheme(document.documentElement.dataset.theme)) document.documentElement.dataset.theme = storedTheme() ?? systemTheme();
}

/** While someone listens: follow the system when nothing is saved, and other tabs' choices. */
function watchOutside(): () => void {
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (!storedTheme()) apply(systemTheme());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) apply(storedTheme() ?? systemTheme());
  };
  media?.addEventListener?.("change", onSystemChange);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    media?.removeEventListener?.("change", onSystemChange);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

let stopWatching: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stopWatching ??= watchOutside();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };
}

export function useTheme(): { theme: Theme; toggleTheme(): void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggleTheme = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return { theme, toggleTheme };
}
