// The e2e suite's test index (INNOBOX_SPEC.md §17), shared by e2e/playwright.config.ts (it balances
// the Jenkins shards by test count) and the quick run (Jenkins' E2E_MODE=QUICK_E2E_TESTS).
//
// A quick run executes a random 20% of the suite's tests in a single shard — a smoke signal in a
// fraction of the time, not a substitute for the full run. Picking individual tests (not whole
// spec files) is safe because no spec chains tests together: there is no serial mode, no
// beforeAll, and every test creates its own uniquely-named fixtures.
//
//   node scripts/e2e-specs.mjs quick
//
// prints one `e2e/<file>.spec.ts:<line>` per picked test on stdout — Playwright's own
// location filter, so the output passes straight to `playwright test` as arguments — and a
// one-line summary on stderr. Locally, from packages/web:
//
//   pnpm e2e $(node scripts/e2e-specs.mjs quick)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The share of the suite a quick run executes. */
export const QUICK_FRACTION = 0.2;

const TEST_CALL = /^[ \t]*test(?:\.(only|skip|fixme))?\(\s*["'`]/gm;

/**
 * Every top-level test call in `source`, with the 1-based line Playwright reports as its location
 * (the line of the `test(` call). `skipped` marks the unconditional `test.skip(` / `test.fixme(`.
 * @param {string} source
 * @returns {{ line: number, skipped: boolean }[]}
 */
export function testsInSource(source) {
  const out = [];
  for (const m of source.matchAll(TEST_CALL)) {
    const at = m.index + m[0].indexOf("test");
    out.push({ line: source.slice(0, at).split("\n").length, skipped: m[1] === "skip" || m[1] === "fixme" });
  }
  return out;
}

/**
 * Every test of every `*.spec.ts` in `dir`, in file then line order.
 * @param {string} dir
 * @returns {{ file: string, line: number, skipped: boolean }[]}
 */
export function specTests(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort()
    .flatMap((file) => testsInSource(readFileSync(path.join(dir, file), "utf8")).map((t) => ({ file, ...t })));
}

/**
 * A uniformly random `fraction` of the runnable (not unconditionally skipped) tests — rounded up,
 * so a non-empty suite always yields at least one — returned in file then line order.
 * @template {{ file: string, line: number, skipped: boolean }} T
 * @param {T[]} tests
 * @param {number} [fraction]
 * @param {() => number} [random] uniform in [0, 1)
 * @returns {T[]}
 */
export function pickQuick(tests, fraction = QUICK_FRACTION, random = Math.random) {
  const pool = tests.filter((t) => !t.skipped);
  // Partial Fisher–Yates: the first `count` slots end up a uniform random sample.
  const count = Math.ceil(pool.length * fraction);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool
    .slice(0, count)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "quick") {
    console.error("usage: node scripts/e2e-specs.mjs quick");
    process.exit(2);
  }
  const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e");
  const all = specTests(e2eDir);
  const picked = pickQuick(all);
  const runnable = all.filter((t) => !t.skipped).length;
  console.error(`quick e2e: ${picked.length} of ${runnable} tests, picked at random`);
  for (const t of picked) console.log(`e2e/${t.file}:${t.line}`);
}
