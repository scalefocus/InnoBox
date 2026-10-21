// Live-DB integration test (gated) for §14.12 real user monitoring (INNOBOX_SPEC.md): the beacon
// write path, the switch and its audit row, and the admin read path — the 7d raw table, the 30d
// rollup blend, the chart series and the error list. Self-skips when DATABASE_URL is unset.
//
// rum_daily is shared with the worker's suite in the same throwaway database, and the app role
// cannot delete from it, so every rollup assertion is keyed on this suite's own route names. The
// raw table and the error table are cleared first (the app role may delete from both).
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

async function setup() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const pool = new Pool({ connectionString: url });
  await pool.query(`delete from rum_views`);
  await pool.query(`delete from rum_client_errors`);
  const { rows } = await pool.query<{ today: string; yesterday: string }>(
    `select to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD') as today,
            to_char((now() at time zone 'utc')::date - 1, 'YYYY-MM-DD') as yesterday`,
  );
  return { pool, randomUUID, today: rows[0]!.today, yesterday: rows[0]!.yesterday };
}

const view = (route: string, day: string, extra: Record<string, unknown> = {}) => ({
  route,
  day,
  hardLoad: true,
  lcpMs: null as number | null,
  inpMs: null as number | null,
  navMs: null as number | null,
  ttfbMs: null as number | null,
  cls: null as number | null,
  apiMs: [] as number[],
  apiCalls: 0,
  apiErrors: 0,
  clientErrors: 0,
  ...extra,
});

test("a beacon is stored with no user anywhere, and its errors are deduplicated", { skip }, async () => {
  const { pool, today } = await setup();
  const { insertRumBeacon } = await import("./store");
  try {
    const { rows: columns } = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_name in ('rum_views', 'rum_daily', 'rum_client_errors')`,
    );
    assert.ok(columns.length > 20);
    assert.deepEqual(
      columns.filter((c) => /user|actor|email|ip/.test(c.column_name)),
      [],
      "no column could hold a person",
    );

    const result = await insertRumBeacon(pool, {
      sessionId: "dbtest-sess-0001",
      views: [view("/challenges/[number]", today, { lcpMs: 1200, apiMs: [80, 120], apiCalls: 3, apiErrors: 1, clientErrors: 2 })],
      errors: [
        { message: "Cannot read item 41", source: "/_next/a.js:10", frame: "f", route: "/challenges/[number]" },
        { message: "Cannot read item 42", source: "/_next/a.js:10", frame: "g", route: "/challenges/[number]" },
        { message: "Other failure", source: "/_next/b.js:3", frame: "", route: "/" },
      ],
    });
    assert.deepEqual(result, { views: 1, errors: 2 });
    const { rows } = await pool.query(`select session_id, route, lcp_ms, api_ms, api_calls, api_errors, client_errors from rum_views`);
    assert.deepEqual(rows, [
      { session_id: "dbtest-sess-0001", route: "/challenges/[number]", lcp_ms: 1200, api_ms: [80, 120], api_calls: 3, api_errors: 1, client_errors: 2 },
    ]);

    // The same error again, a different number: one row, its count and last_seen move.
    const before = await pool.query<{ count: number; last_seen: Date }>(`select count, last_seen from rum_client_errors where source = '/_next/a.js:10'`);
    assert.equal(before.rows[0]!.count, 2);
    await insertRumBeacon(pool, {
      sessionId: "dbtest-sess-0001",
      views: [],
      errors: [{ message: "Cannot read item 9000", source: "/_next/a.js:10", frame: "h", route: "/admin" }],
    });
    const after = await pool.query<{ count: number; last_seen: Date; route: string; n: number }>(
      `select count, last_seen, route, (select count(*)::int from rum_client_errors) as n from rum_client_errors where source = '/_next/a.js:10'`,
    );
    assert.equal(after.rows[0]!.count, 3);
    assert.equal(after.rows[0]!.route, "/admin", "the most recent route");
    assert.ok(after.rows[0]!.last_seen >= before.rows[0]!.last_seen);
    assert.equal(after.rows[0]!.n, 2);
  } finally {
    await pool.end();
  }
});

test("the switch ships off at 100 %; a change writes one audit row, a no-op writes none", { skip }, async () => {
  const { pool, randomUUID } = await setup();
  const { getRumSettings, setRumSettings } = await import("../../../lib/rum-settings");
  try {
    const stamp = randomUUID().slice(0, 8);
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
      [`dbtest-rum-${stamp}`, `dbtest-rum-${stamp}@example.test`, `Dbtest Rum ${stamp}`],
    );
    const admin = rows[0]!.id;
    const audits = async () =>
      (
        await pool.query<{ after: { enabled: boolean; sampleRate: number } }>(
          `select after from audit_log where action = 'settings.telemetry_changed' and actor_user_id = $1 order by id`,
          [admin],
        )
      ).rows.map((r) => r.after);

    // Start from the shipped defaults, whatever an earlier run left behind.
    await setRumSettings(pool, { enabled: false, sampleRate: 100 }, admin);
    const baseline = (await audits()).length;
    assert.deepEqual(await getRumSettings(pool), { enabled: false, sampleRate: 100 });

    assert.deepEqual(await setRumSettings(pool, { enabled: true }, admin), { enabled: true, sampleRate: 100 });
    assert.deepEqual(await setRumSettings(pool, { sampleRate: 10 }, admin), { enabled: true, sampleRate: 10 });
    await setRumSettings(pool, { sampleRate: 10 }, admin); // no change
    assert.deepEqual((await audits()).slice(baseline), [
      { enabled: true, sampleRate: 100 },
      { enabled: true, sampleRate: 10 },
    ]);
    assert.deepEqual(await getRumSettings(pool), { enabled: true, sampleRate: 10 });

    // A malformed stored rate reads as 100, never as an error.
    await pool.query(`update platform_settings set value = '"lots"'::jsonb where key = 'rum_sample_rate'`);
    assert.equal((await getRumSettings(pool)).sampleRate, 100);
    await setRumSettings(pool, { enabled: false, sampleRate: 100 }, admin);
  } finally {
    await pool.end();
  }
});

test("7d is a true p75 from raw views; 30d blends daily rows by views and sums sessions", { skip }, async () => {
  const { pool, today, yesterday } = await setup();
  const { insertRumBeacon } = await import("./store");
  const { rumSummary } = await import("../admin/rum/store");
  const ROUTE = "/dbtest-web-summary";
  try {
    // Today, raw: four hard loads over two sessions; LCP 100..400 → p75 325. One soft view (no LCP).
    await insertRumBeacon(pool, {
      sessionId: "dbtest-sess-A",
      views: [view(ROUTE, today, { lcpMs: 100, apiMs: [100], apiCalls: 1 }), view(ROUTE, today, { lcpMs: 200, apiMs: [300], apiCalls: 2, apiErrors: 1 })],
      errors: [],
    });
    await insertRumBeacon(pool, {
      sessionId: "dbtest-sess-B",
      views: [view(ROUTE, today, { lcpMs: 300 }), view(ROUTE, today, { lcpMs: 400 }), view(ROUTE, today, { hardLoad: false, inpMs: 90 })],
      errors: [],
    });

    const raw = await rumSummary(pool, "7d");
    assert.equal(raw.source, "raw");
    const r = raw.routes.find((x) => x.route === ROUTE)!;
    assert.equal(r.views, 5);
    assert.equal(r.sessions, 2, "distinct sessions over the range");
    assert.equal(r.p75.lcp, 325, "percentile_cont skips the soft view's null");
    assert.equal(r.p75.inp, 90);
    assert.equal(r.p75.api, 250, "p75 over every timed call: 100, 300 → 250");
    assert.equal(r.apiCalls, 3);
    assert.equal(r.apiErrors, 1);
    assert.equal(raw.total.views, 5, "the raw table was cleared, so the all-routes row is ours");
    assert.equal(raw.total.p75.lcp, 325);

    // Yesterday, rolled up: 5 views at p75 LCP 1000, 4 sessions.
    await pool.query(
      `insert into rum_daily (day, route, views, sessions, p75_lcp_ms, api_calls, api_errors, client_errors)
       values ($1::date, $2, 5, 4, 1000, 0, 0, 0)
       on conflict (day, route) do update set views = 5, sessions = 4, p75_lcp_ms = 1000, api_calls = 0, api_errors = 0, client_errors = 0,
         p75_inp_ms = null, p75_cls = null, p75_ttfb_ms = null, p75_nav_ms = null, p75_api_ms = null`,
      [yesterday, ROUTE],
    );
    const blended = await rumSummary(pool, "30d");
    assert.equal(blended.source, "rollup");
    const b = blended.routes.find((x) => x.route === ROUTE)!;
    assert.equal(b.views, 10);
    assert.equal(b.sessions, 6, "daily distinct sessions add up: 2 today + 4 yesterday");
    assert.equal(b.p75.lcp, 663, "views-weighted: (325×5 + 1000×5) / 10 = 662.5");
    assert.equal(b.name, "Other", "a template outside the registry reads as Other");
  } finally {
    await pool.end();
  }
});

test("the series runs to today with today's point live; errors filter by range and sort", { skip }, async () => {
  const { pool, today } = await setup();
  const { insertRumBeacon } = await import("./store");
  const { rumSeries, rumErrors } = await import("../admin/rum/store");
  try {
    await insertRumBeacon(pool, { sessionId: "dbtest-sess-C", views: [view("/", today, { lcpMs: 900 }), view("/", today, { lcpMs: 1100 })], errors: [] });
    const all = await rumSeries(pool, "all");
    const last = all.points.at(-1)!;
    assert.equal(last.day, today);
    assert.equal(last.views, 2, "today comes from the raw views, not a stale rollup row");
    assert.equal(last.p75Lcp, 1050);
    assert.equal(all.enoughHistory, all.points.length >= 7);
    for (let i = 1; i < all.points.length; i++) {
      assert.ok(all.points[i]!.day > all.points[i - 1]!.day, "one point per day, ascending");
    }
    const week = await rumSeries(pool, "7d");
    assert.ok(week.points.length <= 7);
    assert.equal(week.enoughHistory, all.enoughHistory, "history is judged on the whole series");

    await pool.query(`delete from rum_client_errors`);
    await pool.query(
      `insert into rum_client_errors (fingerprint, message, source, frame, route, first_seen, last_seen, count) values
         ('fp-often', 'often', '/a.js:1', '', '/', now() - interval '20 days', now() - interval '2 days', 50),
         ('fp-recent', 'recent', '/b.js:1', '', '/admin', now() - interval '1 hour', now() - interval '1 hour', 1),
         ('fp-old', 'old', '/c.js:1', '', '/', now() - interval '60 days', now() - interval '40 days', 9)`,
    );
    const byLastSeen = await rumErrors(pool, "30d", "last_seen");
    assert.deepEqual(byLastSeen.errors.map((e) => e.fingerprint), ["fp-recent", "fp-often"]);
    assert.equal(byLastSeen.total, 2);
    assert.equal(byLastSeen.errors[0]!.name, "Administration");
    const byCount = await rumErrors(pool, "90d", "count");
    assert.deepEqual(byCount.errors.map((e) => e.fingerprint), ["fp-often", "fp-old", "fp-recent"]);
  } finally {
    await pool.end();
  }
});
