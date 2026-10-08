// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* The browser tab icon: index.html points to the EmailBot icon kept in public/ (served from "/"). */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(`${webRoot}index.html`, "utf8");

describe("favicon", () => {
  it("index.html declares the existing icon in public/ and no other icon", () => {
    const icons = [...html.matchAll(/<link[^>]+rel="(icon|shortcut icon|apple-touch-icon)"[^>]*>/g)].map((match) => match[0]);
    expect(icons).toEqual([
      '<link rel="icon" type="image/png" href="/logo-emailbotv2.png" />',
      '<link rel="apple-touch-icon" href="/logo-emailbotv2.png" />'
    ]);
    expect(html).not.toMatch(/favicon\.ico|vite\.svg/);
  });

  it("the referenced file exists in public/ and is a PNG", () => {
    const path = `${webRoot}public/logo-emailbotv2.png`;
    expect(existsSync(path)).toBe(true);
    expect([...readFileSync(path).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
