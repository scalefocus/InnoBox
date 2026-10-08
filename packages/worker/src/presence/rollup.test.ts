// Unit tests for the §14.5 presence rollup sweep against a fake Pool. The SQL predicates are
// asserted textually (the fake Pool doesn't execute SQL), which is the point: the ORDER of the
// two statements and the OVERLAP between the rollup window and the purge floor are the
// properties that keep aggregate history complete and per-person detail bounded. Get either
// wrong and the failure is silent — a day rolled from already-purged detail records a count
// that is too low, forever, with nothing left to recompute it from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESENCE_DETAIL_RETENTION_DAYS, runPresenceRollupSweep } from "./rollup.js";

function makeFakePool(opts: { rolled?: number; purged?: number } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("insert into presence_daily")) return { rows: [], rowCount: opts.rolled ?? 0 };
      if (sql.includes("delete from user_activity_days")) return { rows: [], rowCount: opts.purged ?? 0 };
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

test("rolls BEFORE it purges — never the other way round", async () => {
  const { pool, calls } = makeFakePool();
  await runPresenceRollupSweep(pool as never);
  assert.equal(calls.length, 2);
  assert.ok(call(calls, 0).sql.includes("insert into presence_daily"), "the rollup must run first");
  assert.ok(call(calls, 1).sql.includes("delete from user_activity_days"), "the purge must run second");
});

test("aggregates distinct users per closed day and carries no user ids into presence_daily", async () => {
  const { pool, calls } = makeFakePool({ rolled: 3 });
  const summary = await runPresenceRollupSweep(pool as never);
  const rollup = call(calls, 0).sql;
  assert.ok(rollup.includes("count(distinct user_id)"), "a day's count is DISTINCT users");
  assert.ok(/insert into presence_daily \(day, active_users\)/.test(rollup), "only day + count are stored");
  // The aggregate table's column list is (day, active_users) — no user id column exists to
  // write into, so a future edit cannot quietly turn it into an attendance record.
  assert.ok(!/insert into presence_daily \([^)]*user_id/.test(rollup), "no user id reaches the aggregate table");
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
  const purge = call(calls, 1);
  // Both are bounded by the SAME retention parameter: the rollup covers [today-N, today-1]
  // and the purge removes < today-N. A day is therefore rolled on every sweep for ~N-1 days
  // before it becomes purgeable.
  assert.deepEqual(rollup.params, [PRESENCE_DETAIL_RETENTION_DAYS]);
  assert.deepEqual(purge.params, [PRESENCE_DETAIL_RETENTION_DAYS]);
  assert.ok(rollup.sql.includes("day >= (now() at time zone 'utc')::date - $1::int"));
  assert.ok(purge.sql.includes("day < (now() at time zone 'utc')::date - $1::int"));
  assert.equal(PRESENCE_DETAIL_RETENTION_DAYS, 3); // §14.5 pins the retention floor
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
  const { pool, calls } = makeFakePool({ rolled: 1, purged: 42 });
  const summary = await runPresenceRollupSweep(pool as never, { retentionDays: 10 });
  assert.deepEqual(call(calls, 0).params, [10]);
  assert.deepEqual(call(calls, 1).params, [10]);
  assert.deepEqual(summary, { rolled: 1, purged: 42 });
});
