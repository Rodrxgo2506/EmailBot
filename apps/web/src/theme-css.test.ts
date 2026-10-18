// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import THEME_INIT from "../public/theme-init.js?raw";

// Read from disk: Vitest processes imported .css files (a `?raw` import of a stylesheet comes back empty).
const INDEX_CSS = readFileSync(new URL("./index.css", import.meta.url), "utf8");

/*
 * Theme regression (portal redesign merged into the global theme). These are checks of the CSS SOURCE: jsdom (and
 * this node test) does not evaluate media queries, selectors or Tailwind, so they cannot prove what a browser paints.
 * They prove the rules: every dark style of the app, the customer portal included, hangs off <html data-theme="dark">
 * (set by public/theme-init.js from the saved choice, else the system preference), never off the operating system
 * alone; the global light / dark tokens are those of the app; the portal only re-colours surfaces, not text.
 */

/** Declarations of the top-level rule whose selector is exactly `selector` (outside any at-rule). */
function block(selector: string): Record<string, string> {
  const css = INDEX_CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r\n/g, "\n");
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let start = 0;
  let header = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) {
        header = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ selector: header, body: css.slice(start, i) });
        start = i + 1;
      }
    } else if (depth === 0 && css[i] === ";") {
      start = i + 1;
    }
  }
  const matches = rules.filter((rule) => rule.selector === selector);
  expect(matches, `exactly one top-level rule "${selector}"`).toHaveLength(1);
  const declarations: Record<string, string> = {};
  for (const line of matches[0]!.body.split(";")) {
    const at = line.indexOf(":");
    if (at > 0) declarations[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return declarations;
}

const SURFACES = ["--background", "--card", "--muted", "--muted-foreground", "--primary", "--primary-foreground", "--secondary", "--secondary-foreground", "--accent", "--accent-foreground", "--border", "--input", "--ring"];

describe("theme CSS", () => {
  it("no style depends on the operating system preference alone (no prefers-color-scheme media query)", () => {
    expect(INDEX_CSS).not.toMatch(/@media[^{]*prefers-color-scheme/);
    expect(INDEX_CSS).toContain('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));');
  });

  it("the system preference is only the default of the global theme (theme-init.js), a saved choice wins", () => {
    expect(THEME_INIT).toContain('window.localStorage.getItem("emailbot.theme")');
    expect(THEME_INIT).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(THEME_INIT).toContain('document.documentElement.setAttribute("data-theme", theme)');
  });

  it("global light and dark tokens are still defined by :root and :root[data-theme=dark] (rest of the app)", () => {
    const light = block(":root");
    const dark = block(':root[data-theme="dark"]');
    expect(light["color-scheme"]).toBe("light");
    expect(dark["color-scheme"]).toBe("dark");
    for (const token of ["--background", "--foreground", "--card", "--card-foreground", "--primary", "--border", "--input", "--ring", "--muted-foreground"]) {
      expect(light[token], `:root ${token}`).toBeTruthy();
      expect(dark[token], `dark ${token}`).toBeTruthy();
      expect(dark[token], token).not.toBe(light[token]);
    }
  });

  it("portal: light surfaces on .portal-theme, dark surfaces only under the global dark theme, same token set", () => {
    const light = block(".portal-theme");
    const dark = block(':root[data-theme="dark"] .portal-theme');
    for (const token of SURFACES) {
      expect(light[token], `light ${token}`).toBeTruthy();
      expect(dark[token], `dark ${token}`).toBeTruthy();
    }
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(dark["--background"]).not.toBe(light["--background"]);
    expect(dark["--card"]).not.toBe(light["--card"]);
  });

  it("portal text follows the global theme: the portal never overrides the text colours", () => {
    for (const selector of [".portal-theme", ':root[data-theme="dark"] .portal-theme']) {
      const declarations = block(selector);
      expect(declarations["--foreground"], selector).toBeUndefined();
      expect(declarations["--card-foreground"], selector).toBeUndefined();
    }
  });

  it("the portal's dark rule comes after its light rule (it would also win by specificity)", () => {
    expect(INDEX_CSS.indexOf(':root[data-theme="dark"] .portal-theme {')).toBeGreaterThan(INDEX_CSS.indexOf(".portal-theme {"));
  });
});
