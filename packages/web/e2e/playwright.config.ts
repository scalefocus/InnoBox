// Playwright e2e config (INNOBOX_SPEC.md §17). Drives the real app over the core journeys
// using the dev-auth bypass (INNOBOX_DEV_AUTH — local/e2e only, never production). Reuses a
// dev server if one is already running on the base URL; otherwise starts `pnpm dev` (which
// loads packages/web/.env.local, so INNOBOX_DEV_AUTH + DATABASE_URL come from there).
//
// The suites run against whatever database the dev server points at and create uniquely-named
// (timestamped) fixtures, asserting on those specific rows — so they don't depend on a clean
// database. (A fully isolated e2e database + server, like the dbtest harness, is a later CI step.)
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

// Whether Playwright manages the dev server itself. Omitted when E2E_NO_WEBSERVER=1 — set on the
// Jenkins path, where the suite runs INSIDE the official Playwright Docker image (no pnpm/asdf) and
// the dev server is already started + health-checked on the host by the job. Without this, a host
// server that dies between the job's curl check and Playwright's probe would make Playwright try to
// spawn `pnpm …` inside the image (ENOENT) and mis-report it as "webServer was not able to start";
// omitting the block makes it fail fast with a clear connection error instead. Locally (pnpm
// present) the block stays and reuses the already-listening server.
const webServer =
  process.env.E2E_NO_WEBSERVER === "1"
    ? undefined
    : {
        command: "pnpm --filter @innobox/web dev",
        url: baseURL,
        // Always reuse a server that's already listening. Locally that's your `pnpm dev`; in CI the
        // job starts the dev server and health-checks it before invoking Playwright (more robust than
        // letting Playwright own the server lifecycle, which races on some hosts). If nothing is
        // listening, this command starts one. The server reads INNOBOX_DEV_AUTH + DATABASE_URL +
        // NEXTAUTH_* from the environment (locally via .env.local; in CI via job variables).
        reuseExistingServer: true,
        timeout: 180_000,
        // The suites submit far more than the §2.4 per-user budgets allow in an hour, so a server
        // Playwright starts itself runs with the limits scaled up (non-production only — the
        // variable is ignored under NODE_ENV=production). A reused dev server needs the same
        // variable in its own environment (.env.local).
        env: { ...process.env, RATE_LIMIT_MULTIPLIER: process.env.RATE_LIMIT_MULTIPLIER ?? "50" },
      };

export default defineConfig({
  testDir: ".",
  // Journey specs share database state and drive multi-actor flows, so run serially for
  // determinism rather than in parallel.
  fullyParallel: false,
  workers: 1,
  // Generous timeouts absorb Next.js dev-mode's first-hit route compilation (a cold API route
  // can take several seconds to compile on its first request) so a fresh server doesn't flake.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env.CI,
  // Retries absorb Next dev-mode's first-hit route-compilation flakiness: a spec that times out
  // cold-compiling a route passes on retry once the route is warm. Applied everywhere (dev-mode
  // compile timing bites locally too). A genuinely broken spec still fails every attempt.
  retries: 2,
  // In CI, stop once the suite is clearly broken rather than retrying every spec until the
  // Jenkins pipeline timeout aborts the build (which also swallows the error summary).
  maxFailures: process.env.CI ? 10 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    // §2.4 CSRF: every state-changing /api/* request must carry an Origin equal to the app's own
    // origin. A browser adds it on its own; Playwright's APIRequestContext (context.request — what
    // the e2e/helpers/api.ts fixtures and the specs' direct API calls use) does not, so every
    // request from these contexts sends it. The dev server's NEXTAUTH_URL must match E2E_BASE_URL.
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Jenkins runs the suite inside the official Playwright image as the agent's non-root uid,
    // where Chromium's user-namespace sandbox can't start; E2E_NO_SANDBOX=1 disables it there
    // (throwaway CI container). Unset locally.
    ...(process.env.E2E_NO_SANDBOX === "1" ? { chromiumSandbox: false } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer,
});
