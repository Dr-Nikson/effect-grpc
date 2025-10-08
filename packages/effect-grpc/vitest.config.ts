import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: {
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test-d.json",
    },
  },
});
