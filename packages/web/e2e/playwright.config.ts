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

// ── Workers ───────────────────────────────────────────────────────────────────────────────────
// E2E_WORKERS (1-16, default 4; Jenkins passes its E2E_WORKERS parameter) spec files run at once,
// all against the SAME dev server and database (one `next dev` per checkout is all Next allows, and
// the agent can't afford more). Every spec only touches its own uniquely-named fixtures
// (helpers/stamp.ts) — except these, which change PLATFORM-WIDE state (the AI provider + its
// switches, the system banner, platform settings, channel webhooks, the featured list, …) that
// another of them running at the same time would observe. They form the "platform-state" project,
// held to one worker so they run one after another, while the other workers share the rest of the
// suite. Run back to back they are about a quarter of the tests, which sets the floor on the
// suite's wall time: past about 4 workers, more only adds load on the one dev server.
// A NEW spec that changes platform-wide state must be added here.
const PLATFORM_STATE_SPECS = [
  "admin-ai.spec.ts",
  "admin-banner.spec.ts",
  "admin-settings.spec.ts",
  "admin-webhooks.spec.ts",
  "ai-draft.spec.ts",
  "ai-similar.spec.ts",
  "ai-summary.spec.ts",
  "ai-triage.spec.ts",
  "feature-ideas.spec.ts",
  "featured.spec.ts",
  "gamification.spec.ts",
  "hype.spec.ts",
  "public-submissions.spec.ts",
  "survey.spec.ts",
  "topics.spec.ts",
];

const PLATFORM_STATE_GLOBS = PLATFORM_STATE_SPECS.map((f) => `**/${f}`);

const workersEnv = process.env.E2E_WORKERS ?? "4";
const workers = Number(workersEnv);
if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
  throw new Error(`E2E_WORKERS must be a whole number from 1 to 16, got "${workersEnv}"`);
}

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
  // Whole spec files are dealt out to the workers, and a file's tests run in order in one worker,
  // so two tests of the same file never overlap. Splitting files would buy nothing: the
  // platform-state chain is far longer than any one file.
  fullyParallel: false,
  workers,
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
    // request from these contexts sends it. The dev server's PUBLIC_BASE_URL must match E2E_BASE_URL.
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Jenkins runs the suite inside the official Playwright image as the agent's non-root uid,
    // where Chromium's user-namespace sandbox can't start; E2E_NO_SANDBOX=1 disables it there
    // (throwaway CI container). Unset locally.
    ...(process.env.E2E_NO_SANDBOX === "1" ? { chromiumSandbox: false } : {}),
  },
  projects: [
    // Listed first, so its files head the queue: whenever its one worker frees up it takes the
    // next of them at once, and the chain that bounds the run never waits behind other files.
    { name: "platform-state", testMatch: PLATFORM_STATE_GLOBS, workers: 1, use: { ...devices["Desktop Chrome"] } },
    { name: "isolated", testIgnore: PLATFORM_STATE_GLOBS, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer,
});
