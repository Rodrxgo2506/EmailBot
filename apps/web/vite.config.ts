import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { buildContentSecurityPolicy } from "./src/lib/csp";
import { parseWebEnv } from "./src/lib/env-schema";

// Single .env at the monorepo root. Only VITE_* variables reach the browser,
// so server secrets (service role key, OAuth secrets) are never bundled.
const ENV_DIR = "../../";

/** File emitted next to index.html with the policy, for servers that send it as a header. */
export const CSP_FILE = "csp-policy.txt";

/**
 * Production builds only: injects the Content Security Policy into index.html
 * and emits it as CSP_FILE. The dev server is left alone (Vite's HMR client
 * needs inline scripts and its own websocket).
 */
function contentSecurityPolicy(policy: string): Plugin {
  return {
    name: "emailbot-content-security-policy",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      // Right after <meta charset>, before any script or stylesheet it must govern.
      handler: (html) => {
        const charset = /<meta charset="UTF-8"\s*\/?>/i;
        if (!charset.test(html)) throw new Error("index.html must declare <meta charset> for the CSP to be injected");
        return html.replace(charset, (tag) => `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      }
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: CSP_FILE, source: `${policy}\n` });
    }
  };
}

export default defineConfig(({ command, mode }) => {
  // Deployment builds (NODE_ENV=production in the environment or in .env)
  // fail fast instead of bundling a localhost / non-HTTPS API or Supabase URL.
  // scripts/build.mjs records the environment's NODE_ENV because Vite
  // overwrites it before loading this file. A plain local `pnpm build` stays
  // lenient; the bundle itself still refuses a missing VITE_API_URL.
  const viteEnv = loadEnv(mode, ENV_DIR, "VITE_");
  const deployment =
    process.env.EMAILBOT_BUILD_NODE_ENV === "production" || loadEnv(mode, ENV_DIR, "").VITE_USER_NODE_ENV === "production";
  if (command === "build" && deployment) {
    const result = parseWebEnv(viteEnv, { production: true, strict: true });
    if (!result.ok) {
      throw new Error(`Invalid production web configuration:\n  - ${result.issues.join("\n  - ")}`);
    }
  }

  // Lenient local builds without configuration still get a policy (local defaults).
  const parsed = parseWebEnv(viteEnv, { production: false });
  const policy = buildContentSecurityPolicy(
    parsed.ok
      ? { apiUrl: parsed.env.apiUrl, supabaseUrl: parsed.env.supabaseUrl }
      : { apiUrl: "http://localhost:3000", supabaseUrl: "http://127.0.0.1:54321" }
  );

  return {
    plugins: [react(), tailwindcss(), contentSecurityPolicy(policy)],
    envDir: ENV_DIR,
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
    },
    server: { port: 5173 }
  };
});
