import { build } from "vite";

// Vite sets process.env.NODE_ENV=production itself before it loads
// vite.config.ts, so the config cannot tell a deployment build
// (NODE_ENV=production set by the environment) from a local `pnpm build`.
// Keep the value the environment set; vite.config.ts validates strictly on it.
process.env.EMAILBOT_BUILD_NODE_ENV = process.env.NODE_ENV ?? "";

await build();
