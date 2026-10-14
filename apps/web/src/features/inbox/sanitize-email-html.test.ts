// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./sanitize-email-html";

/* Untrusted email HTML: what survives sanitizeEmailHtml (before the sandboxed iframe). */

function parse(html: string): Document {
  return new DOMParser().parseFromString(sanitizeEmailHtml(html), "text/html");
}

describe("sanitizeEmailHtml", () => {
  it("keeps the formatting of a normal email: text, tables, inline and <head> styles, images, verification codes", () => {
    const html = `<html><head><style>.code{font-size:24px}</style></head><body>
      <h1>Tu código</h1><table><tr><td style="color:#333"><span class="code"><b>482913</b></span></td></tr></table>
      <img src="https://cdn.example/logo.png" alt="Logo" width="120"><img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo=">
    </body></html>`;
    const result = sanitizeEmailHtml(html);
    expect(result).toContain("<style>.code{font-size:24px}</style>");
    expect(result).toContain('<td style="color:#333">');
    expect(result).toContain("<b>482913</b>");
    const images = [...parse(html).querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(images).toEqual(["https://cdn.example/logo.png", "cid:logo@x", "data:image/png;base64,iVBORw0KGgo="]);
  });

  it("removes scripts, event handlers, frames, plugins, meta refresh, base and external stylesheets", () => {
    const html = `<script>alert(1)</script><svg><script>alert(2)</script></svg>
      <img src="x.png" onerror="alert(3)" onload="alert(4)"><body onload="alert(5)"><div onclick="alert(6)">texto</div>
      <iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x.swf">
      <meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">
      <link rel="stylesheet" href="https://evil.example/x.css"><noscript><p>ns</p></noscript><template><p>t</p></template>`;
    const result = sanitizeEmailHtml(html);
    expect(result).not.toMatch(/<script|<iframe|<object|<embed|<meta|<base|<link|<noscript|<template/i);
    expect(result).not.toMatch(/\son[a-z]+=/i);
    expect(result).not.toContain("alert(");
    expect(result).toContain("texto");
  });

  it("forms cannot be submitted: controls are removed, the form is unwrapped and its text kept", () => {
    const result = sanitizeEmailHtml(
      `<form action="https://evil.example/steal" method="post"><p>Confirma tu cuenta</p><input name="password" type="password"><button formaction="https://evil.example">Enviar</button><select><option>a</option></select><textarea>t</textarea></form>`
    );
    expect(result).toBe("<p>Confirma tu cuenta</p>");
  });

  it("drops dangerous URLs (javascript:, vbscript:, data: documents, obfuscated schemes) and keeps safe ones", () => {
    const doc = parse(`
      <a id="js" href="javascript:alert(1)">a</a>
      <a id="js2" href=" JaVa&#x09;Script:alert(1)">b</a>
      <a id="vb" href="vbscript:msgbox(1)">c</a>
      <a id="data" href="data:text/html;base64,PHNjcmlwdD4=">d</a>
      <a id="https" href="https://www.netflix.com/login">e</a>
      <a id="mail" href="mailto:soporte@example.com">f</a>
      <a id="anchor" href="#top">g</a>
      <img id="svg" src="data:image/svg+xml;base64,PHN2Zz4=">
      <img id="jsimg" src="javascript:alert(1)">
      <img id="srcset" src="https://cdn.example/a.png" srcset="https://tracker.example/p.png 2x">
      <svg><a id="svga" xlink:href="javascript:alert(1)"><text>x</text></a></svg>
      <table background="javascript:alert(1)"><tr><td>t</td></tr></table>`);
    for (const id of ["js", "js2", "vb", "data"]) expect(doc.getElementById(id)?.hasAttribute("href"), id).toBe(false);
    expect(doc.getElementById("https")?.getAttribute("href")).toBe("https://www.netflix.com/login");
    expect(doc.getElementById("mail")?.getAttribute("href")).toBe("mailto:soporte@example.com");
    expect(doc.getElementById("anchor")?.getAttribute("href")).toBe("#top");
    expect(doc.getElementById("svg")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("jsimg")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("srcset")?.hasAttribute("srcset")).toBe(false);
    expect(doc.getElementById("svga")?.hasAttribute("xlink:href")).toBe(false);
    expect(doc.querySelector("table")?.hasAttribute("background")).toBe(false);
  });

  it("links open in a new tab without opener / referrer and show where they go", () => {
    const link = parse(`<a href="https://www.netflix.com/login" target="_top">Iniciar sesión</a>`).querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("title")).toBe("https://www.netflix.com/login");
    expect(link?.textContent).toBe("Iniciar sesión");

    const svgLink = parse(`<svg><a href="https://example.com/svg" target="_self"><text>x</text></a></svg>`).querySelector("svg a");
    expect(svgLink?.getAttribute("target")).toBe("_blank");
    expect(svgLink?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
