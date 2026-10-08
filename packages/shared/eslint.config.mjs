// @innobox/shared — plain TS library, no framework plugin needed (unlike @innobox/web's
// next/core-web-vitals config). typescript-eslint's recommended set catches real bugs
// (unused vars, floating promises) without imposing a house style beyond what's already
// enforced by tsconfig's strict mode.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Test doubles/mocks are allowed to be loosely typed — production code (everything
    // else) stays strict.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
