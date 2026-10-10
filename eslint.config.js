// @ts-check
import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

/** Modules the Gateway must never import (architecture §9.4 T-B2-4, ADR-0002 point 3). */
const BANNED_IMPORTS = [
  {
    name: "child_process",
    message:
      "The Gateway never spawns processes or builds shell strings (T-B2-4). Use the OpenHands REST/WS client instead.",
  },
  {
    name: "node:child_process",
    message:
      "The Gateway never spawns processes or builds shell strings (T-B2-4). Use the OpenHands REST/WS client instead.",
  },
];

export default [
  {
    // `test/fixtures/**` deliberately violates these rules; it is linted on purpose by
    // `test/eslint-child-process-ban.test.ts` (T-AC-6), not by the repo-wide `eslint .` run.
    ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/**", ".claude/**"],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: BANNED_IMPORTS,
          patterns: [
            {
              group: ["node:child_process/*", "child_process/*"],
              message: "The Gateway never spawns processes (T-B2-4).",
            },
          ],
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["error"] }],
      // TypeScript (via `tsc --noEmit`, run in CI alongside lint) already catches genuinely
      // undefined identifiers; `no-undef` cannot see ambient/global types (`NodeJS`, DOM
      // globals) and produces false positives on them, which is why typescript-eslint's own
      // docs recommend disabling it for TypeScript files.
      "no-undef": "off",
    },
  },
];
