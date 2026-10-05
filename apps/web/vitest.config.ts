import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Component tests opt into jsdom per file (`// @vitest-environment jsdom`); logic tests stay in node.
    environment: "node",
    setupFiles: ["./src/test/setup.ts"]
  }
});
