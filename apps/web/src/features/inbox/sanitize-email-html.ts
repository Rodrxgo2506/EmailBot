/*
 * Defense in depth for untrusted email HTML, applied BEFORE it is placed in the
 * sandboxed iframe of EmailBody (which already has no scripts, no same-origin
 * and a CSP that blocks remote resources). Parsing uses DOMParser: the parsed
 * document is inert (no script runs, nothing is fetched).
 *
 *  - removes active or navigating content: scripts, frames, plugins, forms and
 *    their controls, <meta> (refresh), <base>, <link>, <template>;
 *  - removes every on* event attribute, form targets and srcset;
 *  - keeps only safe URL schemes (http, https, mailto, tel, cid, relative and
 *    #anchors; data: only for images);
 *  - links open in a new tab without opener / referrer and show their target.
 */

const REMOVED_ELEMENTS = [
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "meta",
  "base",
  "link",
  "template",
  "input",
  "button",
  "select",
  "option",
  "textarea"
].join(",");

const REMOVED_ATTRIBUTES = new Set(["action", "formaction", "form", "srcdoc", "srcset", "ping", "http-equiv"]);
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "background", "poster", "cite", "longdesc", "lowsrc", "dynsrc"]);
const SAFE_LINK = /^(?:https?:|mailto:|tel:|#|\/|\.{0,2}\/|[^:/?#]*(?:[/?#]|$))/i;
const SAFE_IMAGE = /^(?:https?:|cid:|data:image\/(?:png|gif|jpe?g|webp|bmp);)/i;

/** Strip whitespace / control characters a browser would ignore inside a scheme ("java\nscript:"). */
function normalizedUrl(value: string): string {
  return value.replace(/[\x00-\x20\x7f-\x9f]+/g, "");
}

function isSafeUrl(attribute: string, value: string): boolean {
  const url = normalizedUrl(value);
  if (url === "") return true;
  if (attribute === "href" || attribute === "xlink:href" || attribute === "cite" || attribute === "longdesc") return SAFE_LINK.test(url);
  return SAFE_IMAGE.test(url) || (SAFE_LINK.test(url) && !/^(?:mailto|tel):/i.test(url));
}

export function sanitizeEmailHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const element of document.querySelectorAll(REMOVED_ELEMENTS)) element.remove();
  // Unwrap forms: their text stays readable, nothing can be submitted.
  for (const form of document.querySelectorAll("form")) form.replaceWith(...form.childNodes);

  for (const element of document.querySelectorAll("*")) {
    for (const { name, value } of [...element.attributes]) {
      const attribute = name.toLowerCase();
      if (attribute.startsWith("on") || REMOVED_ATTRIBUTES.has(attribute)) element.removeAttribute(name);
      else if (URL_ATTRIBUTES.has(attribute) && !isSafeUrl(attribute, value)) element.removeAttribute(name);
    }
    if (element.localName === "a" || element.localName === "area") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
      const href = element.getAttribute("href");
      if (href && !element.hasAttribute("title")) element.setAttribute("title", href);
    }
  }

  // <style> of the original <head> is kept (inline styles only; the CSP blocks remote ones).
  const styles = [...document.head.querySelectorAll("style")].map((style) => style.outerHTML).join("");
  return styles + document.body.innerHTML;
}
