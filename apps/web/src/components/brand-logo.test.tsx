// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BRAND_LOGO_LIGHT_SRC, BRAND_LOGO_SRC, BrandLogo } from "./brand-logo";

describe("BrandLogo", () => {
  it("light scheme (default): the dark-lettering variant; dark scheme: the original official file", () => {
    const { container } = render(<BrandLogo className="h-12" />);
    const image = screen.getByRole("img", { name: "EmailBot" });
    expect(image).toHaveAttribute("src", BRAND_LOGO_LIGHT_SRC);
    expect(BRAND_LOGO_LIGHT_SRC).toMatch(/emailbot-logo-oficial-light\.png$/);
    const dark = container.querySelector("picture > source");
    expect(dark).toHaveAttribute("media", "(prefers-color-scheme: dark)");
    expect(dark).toHaveAttribute("srcset", BRAND_LOGO_SRC);
    expect(BRAND_LOGO_SRC).toMatch(/emailbot-logo-oficial\.png$/);
  });

  it("keeps the original 3:1 proportions without cropping or stretching", () => {
    render(<BrandLogo className="h-12" />);
    const image = screen.getByRole("img", { name: "EmailBot" });
    expect(image).toHaveAttribute("width", "2171");
    expect(image).toHaveAttribute("height", "724");
    expect(image.className).toMatch(/\bw-auto\b/);
    expect(image.className).toMatch(/\bobject-contain\b/);
    expect(image.className).toMatch(/\bh-12\b/);
  });
});
