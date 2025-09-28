import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      // TypeScript specific rules
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",

      // General code quality rules
      "no-console": "warn",
      "no-debugger": "error",
      "prefer-const": "error",
      "no-var": "error",

      // Import/export rules
      "no-duplicate-imports": "error",

      // Best practices
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      // Allow console in tests
      "no-console": "off",
      // Allow any in tests for mocking
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.ts", "demos/**/*.ts", "demos/**/*.tsx"],
    rules: {
      // Allow console in scripts and demos
      "no-console": "off",
    },
  },
  {
    ignores: [
      // Build outputs
      "dist/**",
      "coverage/**",

      // Dependencies
      "node_modules/**",

      // Demo build outputs
      "demos/*/dist/**",
      "demos/*/node_modules/**",

      // Config files
      "*.config.js",
      "*.config.ts",
      "*.config.mjs",

      // Generated files
      "**/*.d.ts",

      // Logs
      "**/*.log",
      "**/npm-debug.log*",
      "**/yarn-debug.log*",
      "**/yarn-error.log*",
    ],
  },
);
