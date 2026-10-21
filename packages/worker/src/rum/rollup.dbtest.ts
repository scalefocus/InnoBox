// Live-DB integration test (gated) for the §14.12 monitoring sweep (INNOBOX_SPEC.md): the rollup
// writes per-route and all-routes rows with true percentiles, is idempotent, repairs an open day
// when late beacons arrive, leaves days outside the window alone, and the trims delete only what
// is past retention. Self-skips when DATABASE_URL is unset.
//
// rum_daily is shared with the web suite and the app role cannot delete from it, so assertions
// are keyed on this suite's own route names; the raw table is cleared first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

const R1 = "/dbtest-worker-one";
const R2 = "/dbtest-worker-two";

test("rum sweep: rolls the open window per route and for all routes, idempotently, then trims", { skip }, async () => {
  const { Pool } = await import("pg");
  const { runRumSweep } = await import("./rollup.js");
  const pool = new Pool({ connectionString: url });

  const addView = (route: string, daysAgo: number, lcp: number | null, session: string, apiMs: number[] = []) =>
    pool.query(
      `insert into rum_views (day, session_id, route, hard_load, lcp_ms, api_ms, api_calls, api_errors, client_errors)
       values ((now() at time zone 'utc')::date - $1::int, $2, $3, $4, $5, $6::int[], $7, 0, 1)`,
      [daysAgo, session, route, lcp !== null, lcp, apiMs, apiMs.length],
    );
  const daily = async (route: string, daysAgo: number) =>
    (
      await pool.query<{ views: number; sessions: number; p75_lcp_ms: number | null; p75_api_ms: number | null; client_errors: number }>(
        `select views, sessions, p75_lcp_ms, p75_api_ms, client_errors from rum_daily
          where route = $1 and day = (now() at time zone 'utc')::date - $2::int`,
        [route, daysAgo],
      )
    ).rows[0];

  try {
    await pool.query(`delete from rum_views`);
    // Yesterday: R1 with LCP 100..400 over two sessions, R2 one soft view; a view 3 days back.
    await addView(R1, 1, 100, "s-1", [100, 300]);
    await addView(R1, 1, 200, "s-1");
    await addView(R1, 1, 300, "s-2");
    await addView(R1, 1, 400, "s-2");
    await addView(R2, 1, null, "s-3");
    await addView(R1, 3, 1000, "s-4");

    const first = await runRumSweep(pool);
    assert.ok(first.rolled >= 4, "per-route rows and the all-routes rows for two days");
    assert.deepEqual(await daily(R1, 1), { views: 4, sessions: 2, p75_lcp_ms: 325, p75_api_ms: 250, client_errors: 4 });
    assert.deepEqual(await daily(R2, 1), { views: 1, sessions: 1, p75_lcp_ms: null, p75_api_ms: null, client_errors: 1 });
    const star = await daily("*", 1);
    assert.equal(star!.views, 5, "the all-routes row counts every route");
    assert.equal(star!.sessions, 3);
    assert.equal(star!.p75_lcp_ms, 325, "a real percentile over all views, the soft view's null skipped");
    assert.equal((await daily(R1, 3))!.p75_lcp_ms, 1000);

    // Idempotent: a second sweep over the same raw rows changes nothing.
    await runRumSweep(pool);
    assert.deepEqual(await daily(R1, 1), { views: 4, sessions: 2, p75_lcp_ms: 325, p75_api_ms: 250, client_errors: 4 });

    // A late beacon for yesterday (a tab hidden before midnight, flushed after): repaired.
    await addView(R1, 1, 5000, "s-5");
    await runRumSweep(pool);
    assert.deepEqual(await daily(R1, 1), { views: 5, sessions: 3, p75_lcp_ms: 400, p75_api_ms: 250, client_errors: 5 });

    // Outside the window: raw views 8 days back are trimmed, and their day is never recomputed.
    await pool.query(
      `insert into rum_daily (day, route, views, sessions, api_calls, api_errors, client_errors)
       values ((now() at time zone 'utc')::date - 8, $1, 77, 7, 0, 0, 0)
       on conflict (day, route) do update set views = 77, sessions = 7`,
      [R1],
    );
    await addView(R1, 8, 1, "s-6");
    const trimmed = await runRumSweep(pool);
    assert.equal(trimmed.trimmedViews, 1);
    assert.equal((await daily(R1, 8))!.views, 77, "a closed day outside the window is left alone");
    const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from rum_views where day < (now() at time zone 'utc')::date - 7`);
    assert.equal(rows[0]!.n, 0);
    const { rows: kept } = await pool.query<{ n: number }>(`select count(*)::int as n from rum_views where route = $1`, [R1]);
    assert.equal(kept[0]!.n, 6, "views inside the window are kept");

    // Errors: deleted 90 days after last_seen, not before.
    await pool.query(`delete from rum_client_errors where fingerprint like 'dbtest-worker-%'`);
    await pool.query(
      `insert into rum_client_errors (fingerprint, message, source, frame, route, first_seen, last_seen, count) values
         ('dbtest-worker-stale', 'm', '/a.js:1', '', '/', now() - interval '200 days', now() - interval '91 days', 1),
         ('dbtest-worker-fresh', 'm', '/a.js:2', '', '/', now() - interval '200 days', now() - interval '89 days', 1)`,
    );
    const swept = await runRumSweep(pool);
    assert.ok(swept.trimmedErrors >= 1);
    const { rows: left } = await pool.query<{ fingerprint: string }>(
      `select fingerprint from rum_client_errors where fingerprint like 'dbtest-worker-%' order by fingerprint`,
    );
    assert.deepEqual(left.map((r) => r.fingerprint), ["dbtest-worker-fresh"]);
  } finally {
    await pool.query(`delete from rum_views where route in ($1, $2)`, [R1, R2]).catch(() => {});
    await pool.end();
  }
});
