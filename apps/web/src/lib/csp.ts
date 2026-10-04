/*
 * Content Security Policy of the web app, derived from the build
 * configuration (API and Supabase origins). Used by vite.config.ts, which
 * injects it as <meta http-equiv="Content-Security-Policy"> into index.html
 * (works on any static host) and also emits it for servers that send it as a
 * header (deploy/web/nginx.conf adds frame-ancestors, which a <meta> cannot).
 *
 * Exceptions, and why:
 *  - style-src 'unsafe-inline': sonner (toasts) and react-remove-scroll
 *    (Radix dialogs) insert <style> elements at runtime; a static host cannot
 *    issue per-response nonces. Scripts stay 'self' only.
 *  - img-src https: data: blob:, font-src data:: email HTML is shown in a
 *    sandboxed srcdoc iframe, which inherits this policy; its own stricter
 *    policy only loads remote images after the user opts in.
 *  - connect-src lists the API (https + wss for Socket.IO /realtime) and
 *    Supabase (Auth over https) explicitly; nothing else.
 */

export interface CspOrigins {
  apiUrl: string;
  supabaseUrl: string;
}

function origin(url: string): string {
  return new URL(url).origin;
}

/** Socket.IO connects with the same host over ws(s). */
function websocketOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}`;
}

export function buildContentSecurityPolicy({ apiUrl, supabaseUrl }: CspOrigins): string {
  const secure = new URL(apiUrl).protocol === "https:" && new URL(supabaseUrl).protocol === "https:";
  const connect = [...new Set(["'self'", origin(apiUrl), websocketOrigin(apiUrl), origin(supabaseUrl)])];

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connect],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["worker-src", ["'none'"]]
  ];
  if (secure) directives.push(["upgrade-insecure-requests", []]);

  return directives.map(([name, values]) => [name, ...values].join(" ")).join("; ");
}
