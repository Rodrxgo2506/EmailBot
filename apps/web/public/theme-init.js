/*
 * Sets <html data-theme> before the first paint (no light/dark flash): the choice saved by the
 * navbar toggle, otherwise the operating system's preference. A separate file because the
 * Content-Security-Policy only allows same-origin scripts (no inline script).
 * Keep the key and the rule in sync with src/lib/theme.ts (checked by theme.test.ts).
 */
(function () {
  var theme = null;
  try {
    theme = window.localStorage.getItem("emailbot.theme");
  } catch (error) {
    theme = null;
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
