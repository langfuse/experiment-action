import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import sonarjsPlugin from "eslint-plugin-sonarjs";

export default [
  eslint.configs.recommended,
  prettierConfig,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      prettier: prettierPlugin,
      import: importPlugin,
      sonarjs: sonarjsPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
        node: true,
      },
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript handles this.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-constraint": "error",
      "prettier/prettier": "error",
      "no-redeclare": "off",
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          pathGroups: [
            {
              pattern: "@/**",
              group: "internal",
              position: "before",
            },
          ],
          pathGroupsExcludedImportTypes: ["builtin", "external"],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "no-empty": "warn",

      // Additional correctness + hygiene rules.
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      // `eslint-plugin-etc`'s rule by the same spirit crashes on ESLint 9;
      // sonarjs/no-commented-code is the maintained equivalent.
      "sonarjs/no-commented-code": "error",
      "no-console": "error",
      "no-param-reassign": ["error", { props: false }],
      "prefer-const": "error",
    },
  },
  {
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // The runner wrappers are standalone .mjs scripts that aren't part of
    // the TypeScript surface, so skip lint for them.
    ignores: [
      "dist/",
      "node_modules/",
      "lib/",
      "coverage/",
      "src/executors/wrappers/**",
      // E2E fixtures import user-side packages (@langfuse/client, @langfuse/otel)
      // that aren't in our dev deps — they're standalone example scripts, not
      // ours to typecheck or lint.
      "tests/fixtures/**",
    ],
  },
];
