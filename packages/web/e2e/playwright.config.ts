// Playwright e2e config (INNOBOX_SPEC.md §17). Drives the real app over the core journeys
// using the dev-auth bypass (INNOBOX_DEV_AUTH — local/e2e only, never production). Reuses a
// dev server if one is already running on the base URL; otherwise starts `pnpm dev` (which
// loads packages/web/.env.local, so INNOBOX_DEV_AUTH + DATABASE_URL come from there).
//
// The suites run against whatever database the dev server points at and create uniquely-named
// (timestamped) fixtures, asserting on those specific rows — so they don't depend on a clean
// database. (A fully isolated e2e database + server, like the dbtest harness, is a later CI step.)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

// ── Sharding (Jenkins) ────────────────────────────────────────────────────────────────────────
// E2E_SHARD=i with E2E_SHARD_TOTAL=n (1 ≤ i ≤ n ≤ 9) runs the i-th of n slices of the suite;
// Jenkins (its E2E_SHARDS parameter) runs all n at once against the SAME dev server and database
// (one `next dev` per checkout is all Next allows, and the agent can't afford more). Playwright's
// own --shard can't be used: it splits blindly, and these specs below change PLATFORM-WIDE state
// (the AI provider + its switches, the system banner, platform settings, channel webhooks, the
// featured list) that another spec running concurrently would observe. They are pinned to shard
// 1, where they keep running serially as before; every other spec only touches its own
// uniquely-named fixtures. The rest are dealt out greedily by test count so the slices come out
// roughly equal (shard 1 gets no more once its pinned specs exceed a fair share). Every spec
// lands in exactly one shard. E2E_SHARD unset → the whole suite, as before.
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
  "featured.spec.ts",
  "gamification.spec.ts",
  "survey.spec.ts",
];

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

/** The spec files of shard `shard` of `total`. */
function shardSpecs(shard: number, total: number): string[] {
  const testCount = (file: string) =>
    (readFileSync(path.join(e2eDir, file), "utf8").match(/^\s*test(?:\.(?:only|skip|fixme))?\(\s*["'`]/gm) ?? []).length;
  const specs = readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts")).sort();
  const slices = Array.from({ length: total }, () => ({ files: [] as string[], tests: 0 }));
  for (const f of specs.filter((s) => PLATFORM_STATE_SPECS.includes(s))) {
    slices[0].files.push(f);
    slices[0].tests += testCount(f);
  }
  const rest = specs
    .filter((s) => !PLATFORM_STATE_SPECS.includes(s))
    .map((f) => ({ f, n: testCount(f) }))
    .sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));
  for (const { f, n } of rest) {
    // The lightest slice so far; ties go to the lowest index, so the split is deterministic.
    const target = slices.reduce((min, s) => (s.tests < min.tests ? s : min));
    target.files.push(f);
    target.tests += n;
  }
  return slices[shard - 1].files;
}

const shardEnv = process.env.E2E_SHARD;
const shardTotalEnv = process.env.E2E_SHARD_TOTAL ?? "2";
let shard: { index: number; total: number } | null = null;
if (shardEnv !== undefined) {
  const index = Number(shardEnv);
  const total = Number(shardTotalEnv);
  if (!Number.isInteger(total) || total < 1 || total > 9 || !Number.isInteger(index) || index < 1 || index > total) {
    throw new Error(`E2E_SHARD must be 1..E2E_SHARD_TOTAL and E2E_SHARD_TOTAL 1..9, got "${shardEnv}" of "${shardTotalEnv}"`);
  }
  shard = { index, total };
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
  ...(shard
    ? {
        testMatch: shardSpecs(shard.index, shard.total).map((f) => `**/${f}`),
        // All shards run at once from the same checkout, so each writes its own results.
        outputDir: `../test-results/shard-${shard.index}`,
      }
    : {}),
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
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", ...(shard ? { outputFolder: `../playwright-report/shard-${shard.index}` } : {}) }]]
    : "list",
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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer,
});
