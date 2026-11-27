import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
    typecheck: {
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test-d.json",
    },
  },
});
