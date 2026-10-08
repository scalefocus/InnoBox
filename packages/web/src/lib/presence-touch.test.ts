// Unit tests for the presence WRITE path (INNOBOX_SPEC.md §14.5) against a fake Pool. The
// three properties asserted here are the ones that make it safe to hang off every
// authenticated request: it never awaits, it never throws, and it writes at most once per
// user per minute no matter how many API calls a single page fans out to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESENCE_THROTTLE_MS } from "./presence";
import { resetPresenceThrottle, touchPresence } from "./presence-touch";

function makeFakePool(opts: { fail?: boolean } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return opts.fail ? Promise.reject(new Error("db down")) : Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  return { pool, queries };
}

/** Indexed access under `noUncheckedIndexedAccess` — assert the write happened, then use it. */
function write(queries: { sql: string; params: unknown[] }[], i: number): { sql: string; params: unknown[] } {
  const entry = queries[i];
  assert.ok(entry, `expected a write at index ${i}`);
  return entry;
}

test("an unlisted path writes nothing — the allowlist is the gate", () => {
  resetPresenceThrottle();
  const { pool, queries } = makeFakePool();
  assert.equal(touchPresence(pool as never, "u1", "/api/notifications", "GET"), "skipped");
  assert.equal(touchPresence(pool as never, "u1", null, "GET"), "skipped");
  assert.equal(queries.length, 0);
});

test("one write per user per 60s, however many API calls a page makes", () => {
  resetPresenceThrottle();
  const { pool, queries } = makeFakePool();
  const t0 = 1_800_000_000_000;
  // A challenge page fans out to several allowlisted calls in the same instant.
  assert.equal(touchPresence(pool as never, "u1", "/api/challenges/412", "GET", t0), "written");
  assert.equal(touchPresence(pool as never, "u1", "/api/challenges/412/solutions", "GET", t0 + 20), "throttled");
  assert.equal(touchPresence(pool as never, "u1", "/api/dashboard", "GET", t0 + 5_000), "throttled");
  assert.equal(queries.length, 1);
  // Just inside the window is still throttled; the boundary itself writes again.
  assert.equal(touchPresence(pool as never, "u1", "/api/dashboard", "GET", t0 + PRESENCE_THROTTLE_MS - 1), "throttled");
  assert.equal(touchPresence(pool as never, "u1", "/api/dashboard", "GET", t0 + PRESENCE_THROTTLE_MS), "written");
  assert.equal(queries.length, 2);
});

test("the throttle is per user — one busy user cannot mask another's activity", () => {
  resetPresenceThrottle();
  const { pool, queries } = makeFakePool();
  const t0 = 1_800_000_000_000;
  assert.equal(touchPresence(pool as never, "u1", "/api/dashboard", "GET", t0), "written");
  assert.equal(touchPresence(pool as never, "u2", "/api/dashboard", "GET", t0), "written");
  assert.equal(queries.length, 2);
});

test("a 'locate' request sets the route; a location-less touch preserves it", () => {
  resetPresenceThrottle();
  const { pool, queries } = makeFakePool();
  const t0 = 1_800_000_000_000;
  touchPresence(pool as never, "u1", "/api/challenges/412", "GET", t0);
  assert.deepEqual(write(queries, 0).params, ["u1", "challenge:412"]);

  touchPresence(pool as never, "u2", "/api/likes", "POST", t0);
  // null + coalesce($2, last_route) → the stored location survives, so liking a challenge
  // doesn't move the user "nowhere" mid-read.
  assert.deepEqual(write(queries, 1).params, ["u2", null]);
  assert.ok(write(queries, 1).sql.includes("coalesce($2, last_route)"));
});

test("the write records the UTC activity day and skips deactivated/scrubbed rows", () => {
  resetPresenceThrottle();
  const { pool, queries } = makeFakePool();
  touchPresence(pool as never, "u1", "/api/dashboard", "GET");
  const { sql } = write(queries, 0);
  assert.ok(sql.includes("insert into user_activity_days"), "the chart's day set must be fed");
  assert.ok(sql.includes("(now() at time zone 'utc')::date"), "buckets are UTC (invariant 8)");
  assert.ok(sql.includes("on conflict (user_id, day) do nothing"), "one row per user per day");
  // A scrubbed user must never reacquire presence data after erasure (§3).
  assert.ok(sql.includes("active and scrubbed_at is null"));
});

test("a failing write is swallowed — presence can never fail the request it rides on", async () => {
  resetPresenceThrottle();
  const { pool, queries } = makeFakePool({ fail: true });
  // Synchronous: the caller does not await the write, so a rejected query cannot surface
  // as an unhandled rejection or a 500 on someone's challenge page.
  assert.equal(touchPresence(pool as never, "u1", "/api/dashboard", "GET"), "written");
  assert.equal(queries.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
});
