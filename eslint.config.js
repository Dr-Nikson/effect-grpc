import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const requireInternalTag = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing: "An export of a *.internal.ts file needs a JSDoc comment with an @internal tag.",
    },
  },
  create(context) {
    return {
      ExportNamedDeclaration(node) {
        const jsdoc = context.sourceCode
          .getCommentsBefore(node)
          .findLast((comment) => comment.type === "Block" && comment.value.startsWith("*"));
        if (jsdoc === undefined || !jsdoc.value.includes("@internal")) {
          context.report({ node, messageId: "missing" });
        }
      },
    };
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
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
      "no-console": "error",
    },
  },
  {
    files: ["**/*.internal.ts", "**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  {
    files: ["packages/*/src/**/*.internal.ts"],
    plugins: { local: { rules: { "require-internal-tag": requireInternalTag } } },
    rules: { "local/require-internal-tag": "error" },
  },
  {
    ignores: ["**/src/generated/**"],
  },
  {
    files: ["**/*.test-d.ts", "packages/effect-grpc/src/**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        project: "./packages/*/tsconfig.test-d.json",
        ecmaVersion: 2020,
        sourceType: "module",
      }
    }
  }
);