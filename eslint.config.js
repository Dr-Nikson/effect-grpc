import js from "@eslint/js";
import tseslint from "typescript-eslint";
import effect from "@effect/eslint-plugin";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: {
      "@effect": effect,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./packages/*/tsconfig.json",
        ecmaVersion: 2020,
        sourceType: "module",
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
      },
    },
    files: ["packages/*/src/**/*.{ts,tsx}"],
    rules: {
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": ["error", { functions: false }],
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.internal.ts", "**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  }
);