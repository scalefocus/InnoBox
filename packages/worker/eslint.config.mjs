// @innobox/worker — plain TS service, no framework plugin needed. Same rationale as
// packages/shared/eslint.config.mjs.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Express handler signatures (e.g. 4-arg error middleware) require unused params to
      // stay in place for arity — the underscore prefix is the established "intentionally
      // unused" signal across this codebase.
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
