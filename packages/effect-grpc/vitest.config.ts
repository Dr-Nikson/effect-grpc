import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    typecheck: {
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test-d.json",
    },
  },
});
