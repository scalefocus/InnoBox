// Unit tests for the §14.5 presence rollup sweep against a fake Pool. The SQL predicates are
// asserted textually (the fake Pool doesn't execute SQL), which is the point: the ORDER of the
// statements and the OVERLAP between the rollup window and the purge floor are the properties
// that keep aggregate history complete and per-person detail bounded. Get either wrong and the
// failure is silent — a day rolled from already-purged detail records a count that is too low,
// forever, with nothing left to recompute it from. The snapshot's behaviour against real rows
// (write-once, the zero row, the person filter) is covered in rollup.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESENCE_DETAIL_RETENTION_DAYS, runPresenceRollupSweep } from "./rollup.js";

const ROLLUP = "insert into presence_daily (day, active_users)\n";
const SNAPSHOT = "insert into presence_daily (day, active_users, wau, mau)";
const PURGE = "delete from user_activity_days";

function makeFakePool(opts: { rolled?: number; snapshot?: number; purged?: number } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes(SNAPSHOT)) return { rows: [], rowCount: opts.snapshot ?? 0 };
      if (sql.includes(ROLLUP)) return { rows: [], rowCount: opts.rolled ?? 0 };
      if (sql.includes(PURGE)) return { rows: [], rowCount: opts.purged ?? 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, calls };
}

/** Indexed access under `noUncheckedIndexedAccess` — assert the call happened, then use it. */
function call(calls: { sql: string; params: unknown[] }[], i: number): { sql: string; params: unknown[] } {
  const entry = calls[i];
  assert.ok(entry, `expected a query at index ${i}`);
  return entry;
}

test("rolls, then snapshots, then purges — never the other way round", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  assert.equal(calls.length, 3);
  assert.ok(call(calls, 0).sql.includes(ROLLUP), "the rollup must run first");
  assert.ok(call(calls, 1).sql.includes(SNAPSHOT), "the snapshot follows the rollup, so active days already have a row");
  assert.ok(call(calls, 2).sql.includes(PURGE), "the purge must run last");
});

test("aggregates distinct users per closed day and carries no user ids into presence_daily", async () => {
  const { pool, calls } = makeFakePool({ rolled: 3 });
  const summary = await runPresenceRollupSweep(pool as never);
  const rollup = call(calls, 0).sql;
  assert.ok(rollup.includes("count(distinct user_id)"), "a day's count is DISTINCT users");
  assert.ok(/insert into presence_daily \(day, active_users\)/.test(rollup), "only day + count are stored");
  // The aggregate table's column lists are counts only — no user id column exists to write
  // into, so a future edit cannot quietly turn it into an attendance record.
  for (const { sql } of calls) {
    assert.ok(!/insert into presence_daily \([^)]*user_id/.test(sql), "no user id reaches the aggregate table");
  }
  // Idempotent: a sweep that already ran must be repairable by the next one.
  assert.ok(rollup.includes("on conflict (day) do update"), "re-rolling a day must correct it");
  assert.equal(summary.rolled, 3);
});

test("only CLOSED days are rolled — today is still accruing", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  // The live, in-progress day is served straight from the detail table by the read path
  // (api/admin/presence/store.ts); freezing it into the aggregate early would understate it.
  assert.ok(call(calls, 0).sql.includes("day < (now() at time zone 'utc')::date"));
});

test("the rollup window overlaps the purge floor, so no day can be purged unrolled", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  const rollup = call(calls, 0);
  const purge = call(calls, 2);
  // Both are bounded by the SAME retention parameter: the rollup covers [today-N, today-1]
  // and the purge removes < today-N. A day is therefore rolled on every sweep for ~N-1 days
  // before it becomes purgeable.
  assert.deepEqual(rollup.params, [PRESENCE_DETAIL_RETENTION_DAYS]);
  assert.deepEqual(purge.params, [PRESENCE_DETAIL_RETENTION_DAYS]);
  assert.ok(rollup.sql.includes("day >= (now() at time zone 'utc')::date - $1::int"));
  assert.ok(purge.sql.includes("day < (now() at time zone 'utc')::date - $1::int"));
  assert.equal(PRESENCE_DETAIL_RETENTION_DAYS, 3); // §14.5 pins the retention floor
});

test("the snapshot samples yesterday's rolling 7- and 30-day counts with the tiles' formula", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  const snapshot = call(calls, 1);
  // The just-closed UTC day, never today (still accruing) and never an older one (its window
  // can no longer be measured).
  assert.ok(snapshot.sql.includes("(now() at time zone 'utc')::date - 1"));
  // The tiles' formula: last_seen_at inside a trailing window of exact seconds.
  assert.deepEqual(snapshot.params, [7 * 24 * 60 * 60, 30 * 24 * 60 * 60]);
  assert.ok(snapshot.sql.includes("u.last_seen_at > now() - make_interval(secs => $1)"));
  assert.ok(snapshot.sql.includes("u.last_seen_at > now() - make_interval(secs => $2)"));
  // The tiles' person filter, imported rather than copied.
  assert.ok(snapshot.sql.includes("u.scrubbed_at is null"));
  assert.ok(snapshot.sql.includes("email_service_account"));
});

test("the snapshot is write-once and never touches the daily count of an existing row", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  const sql = call(calls, 1).sql;
  assert.ok(sql.includes("where presence_daily.wau is null"), "a written sample must never be replaced");
  const update = sql.slice(sql.indexOf("do update"));
  assert.ok(!update.includes("active_users"), "the conflict branch leaves active_users to the rollup");
});

test("day buckets are UTC, never the server's local date (invariant 8)", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  for (const { sql } of calls) {
    assert.ok(sql.includes("now() at time zone 'utc'"), "must anchor to UTC explicitly");
    // Bare current_date follows the session TimeZone, which would shift every bucket.
    assert.ok(!/\bcurrent_date\b/.test(sql), "current_date is session-timezone dependent");
  }
});

test("retention is overridable (for tests/ops) and reported in the summary", async () => {
  const { pool, calls } = makeFakePool({ rolled: 1, snapshot: 1, purged: 42 });
  const summary = await runPresenceRollupSweep(pool as never, { retentionDays: 10 });
  assert.deepEqual(call(calls, 0).params, [10]);
  assert.deepEqual(call(calls, 2).params, [10]);
  assert.deepEqual(summary, { rolled: 1, snapshot: true, purged: 42 });
});

test("a sweep that finds yesterday already sampled reports no snapshot", async () => {
  const { pool } = makeFakePool({ snapshot: 0 });
  const summary = await runPresenceRollupSweep(pool as never);
  assert.equal(summary.snapshot, false);
});
