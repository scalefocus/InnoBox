// The unique tag in the names of a spec's own fixtures (INNOBOX_SPEC.md §17). Several workers run
// tests at once against one database (E2E_WORKERS in e2e/playwright.config.ts), so a millisecond
// timestamp alone can repeat in two of them. The worker's parallel index — unique among the workers
// running at the same time, and a letter so that callers keeping only the letters still have it —
// separates those, and the counter keeps two calls within one millisecond apart in one worker.
let last = 0;

/** A base-36 timestamp plus a letter for this worker, unique across the tests running together. */
export function uniqueStamp(): string {
  last = Math.max(Date.now(), last + 1);
  const worker = Number(process.env.TEST_PARALLEL_INDEX ?? 0);
  return `${last.toString(36)}${String.fromCharCode(97 + (worker % 26))}`;
}
