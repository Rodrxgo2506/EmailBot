import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Booting PGlite and applying every migration takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
});
