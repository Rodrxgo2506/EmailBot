// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BRAND_LOGO_LIGHT_SRC, BRAND_LOGO_SRC, BrandLogo } from "./brand-logo";

/*
 * jsdom does not load index.css nor generate Tailwind's utilities, so it cannot tell which rendition a browser
 * displays. These tests check the markup (which classes each rendition carries) and the CSS source that gives
 * those classes their meaning: `dark:` = <html data-theme="dark"> is asserted on index.css in src/theme-css.test.ts.
 * What a browser actually displays can only be checked in a browser, not here.
 */

const renditions = (container: HTMLElement) => ({
  light: container.querySelector<HTMLImageElement>('img[data-theme-rendition="light"]')!,
  dark: container.querySelector<HTMLImageElement>('img[data-theme-rendition="dark"]')!
});
const classes = (element: Element) => element.className.split(/\s+/);

describe("BrandLogo", () => {
  it("one accessible image named EmailBot; the two renditions inside are decorative", () => {
    const { container } = render(<BrandLogo className="h-12" />);
    expect(screen.getAllByRole("img", { name: "EmailBot" })).toHaveLength(1);
    const { light, dark } = renditions(container);
    for (const image of [light, dark]) {
      expect(image).toHaveAttribute("alt", "");
      expect(image).not.toHaveAccessibleName();
    }
  });

  it("follows the global theme through the dark: variant: light rendition by default, the original under data-theme=dark", () => {
    const { container } = render(<BrandLogo className="h-12" />);
    const { light, dark } = renditions(container);
    expect(light).toHaveAttribute("src", BRAND_LOGO_LIGHT_SRC);
    expect(BRAND_LOGO_LIGHT_SRC).toMatch(/emailbot-logo-oficial-light\.png$/);
    expect(dark).toHaveAttribute("src", BRAND_LOGO_SRC);
    expect(BRAND_LOGO_SRC).toMatch(/emailbot-logo-oficial\.png$/);
    // light: shown, hidden under the dark theme; dark: hidden, shown under the dark theme
    expect(classes(light)).toEqual(expect.arrayContaining(["block", "dark:hidden"]));
    expect(classes(light)).not.toContain("hidden");
    expect(classes(dark)).toEqual(expect.arrayContaining(["hidden", "dark:block"]));
  });

  it("never chooses by the operating system preference alone (no <picture> / media query)", () => {
    const { container } = render(<BrandLogo />);
    expect(container.querySelector("picture, source")).toBeNull();
    expect(container.innerHTML).not.toMatch(/prefers-color-scheme/);
  });

  it("the markup does not depend on the theme at render time (CSS decides, so a theme change needs no re-render)", () => {
    document.documentElement.dataset.theme = "dark";
    const dark = render(<BrandLogo className="h-12" />).container.innerHTML;
    document.documentElement.dataset.theme = "light";
    const light = render(<BrandLogo className="h-12" />).container.innerHTML;
    delete document.documentElement.dataset.theme;
    expect(dark).toBe(light);
  });

  it("keeps the original 3:1 proportions without cropping or stretching (both renditions)", () => {
    const { container } = render(<BrandLogo className="h-12" />);
    for (const image of Object.values(renditions(container))) {
      expect(image).toHaveAttribute("width", "2171");
      expect(image).toHaveAttribute("height", "724");
      expect(classes(image)).toEqual(expect.arrayContaining(["w-auto", "object-contain", "h-12"]));
      expect(classes(image)).not.toContain("h-10");
    }
  });
});
