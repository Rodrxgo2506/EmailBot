import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount rendered components between tests (vitest globals are off, so RTL cannot do it by itself).
afterEach(() => {
  cleanup();
});
