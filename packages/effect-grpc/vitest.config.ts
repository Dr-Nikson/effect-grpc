import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
    silent: "passed-only",
    typecheck: {
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test-d.json",
    },
  },
});
