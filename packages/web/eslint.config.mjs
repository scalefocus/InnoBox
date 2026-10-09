// eslint-config-next@16 ships native flat-config arrays (not the legacy eslintrc format),
// so this imports them directly rather than bridging through @eslint/eslintrc's
// FlatCompat — that bridge is for OLD shareable configs and double-wraps an
// already-flat config, which crashes ("Converting circular structure to JSON") on this
// version's plugin objects.
//
// This package pins ESLint 9 (shared/worker run 10): the eslint-plugin-react, -jsx-a11y and
// -import that eslint-config-next bundles cap their peer range at ESLint 9 and crash on 10
// (`context.getFilename is not a function`, `scopeManager.addGlobals is not a function`
// from Next's bundled Babel parser). Lift the pin once those plugins support ESLint 10.
import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    // Flat config does not read .gitignore. Playwright's output dirs hold minified,
    // vendored JS (the trace viewer) and survive between runs on a persistent Jenkins
    // workspace, so an E2E run would otherwise fail the next build's Lint stage.
    ignores: [".next/**", "e2e/**", "playwright-report/**", "test-results/**"],
  },
  {
    rules: {
      // eslint-plugin-react-hooks v6 (bundled by eslint-config-next@16) added this rule as
      // an error by default. It flags the app's established "fetch on mount, setState in
      // the .then()" pattern used consistently across every list/detail page — not a bug,
      // just a React-Compiler-era style this codebase hasn't adopted. Downgrading to a
      // warning (same treatment as exhaustive-deps below) surfaces it without blocking
      // `pnpm lint`/CI over an app-wide data-fetching rewrite that's out of scope here.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
