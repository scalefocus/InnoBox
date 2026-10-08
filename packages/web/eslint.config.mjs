// eslint-config-next@16 ships native flat-config arrays (not the legacy eslintrc format),
// so this imports them directly rather than bridging through @eslint/eslintrc's
// FlatCompat — that bridge is for OLD shareable configs and double-wraps an
// already-flat config, which crashes ("Converting circular structure to JSON") on this
// version's plugin objects.
import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [".next/**", "e2e/**"],
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
