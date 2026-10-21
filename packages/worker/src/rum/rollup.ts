// The §14.12 real-user-monitoring sweep (INNOBOX_SPEC.md), part of the hourly housekeeping sweep.
// Leader-only and pure-DB, so it runs without Entra credentials.
//
// Two steps, in this order, and the order matters:
//   1. ROLLUP — recompute every UTC day still inside the raw window (today and the 7 days before)
//      from rum_views into rum_daily, per route plus the '*' all-routes row, with the SQL the web
//      read path uses for today's live rows (shared rum-sql). An upsert over the whole window
//      rather than "yesterday only": a day whose late beacons arrived after midnight (a tab hidden
//      at 23:58 flushes at 00:01 with its view's own day) is repaired by the next sweep, and a
//      sweep the worker missed is made good by the following one.
//   2. TRIM — delete raw views older than the window, and error rows not seen for 90 days.
// The window and the retention are the same 7 days and the rollup runs first, so every day gets
// its final recompute from complete raw rows before any of them is deleted.
//
// Days are UTC buckets: `(now() at time zone 'utc')::date`, never `current_date`.
import type { Pool } from "pg";
import { RUM_ERROR_RETENTION_DAYS, RUM_RAW_RETENTION_DAYS } from "@innobox/shared/rum";
import { rumAggregateSql } from "@innobox/shared/rum-sql";

export interface RumSweepSummary {
  /** (day, route) rows written or refreshed in rum_daily. */
  rolled: number;
  /** Raw views deleted for age. */
  trimmedViews: number;
  /** Deduplicated error rows deleted for age. */
  trimmedErrors: number;
}

const TODAY = "(now() at time zone 'utc')::date";

export async function runRumSweep(pool: Pool): Promise<RumSweepSummary> {
  const rolled = await pool.query(
    `insert into rum_daily (day, route, views, sessions, p75_lcp_ms, p75_inp_ms, p75_cls, p75_ttfb_ms,
                            p75_nav_ms, p75_api_ms, api_calls, api_errors, client_errors)
     ${rumAggregateSql(`v.day >= ${TODAY} - $1::int`, true)}
     on conflict (day, route) do update set
       views = excluded.views, sessions = excluded.sessions,
       p75_lcp_ms = excluded.p75_lcp_ms, p75_inp_ms = excluded.p75_inp_ms, p75_cls = excluded.p75_cls,
       p75_ttfb_ms = excluded.p75_ttfb_ms, p75_nav_ms = excluded.p75_nav_ms, p75_api_ms = excluded.p75_api_ms,
       api_calls = excluded.api_calls, api_errors = excluded.api_errors, client_errors = excluded.client_errors`,
    [RUM_RAW_RETENTION_DAYS],
  );

  // Only after the rollup — never before it.
  const views = await pool.query(`delete from rum_views where day < ${TODAY} - $1::int`, [RUM_RAW_RETENTION_DAYS]);
  const errors = await pool.query(`delete from rum_client_errors where last_seen < now() - make_interval(days => $1::int)`, [
    RUM_ERROR_RETENTION_DAYS,
  ]);

  return { rolled: rolled.rowCount ?? 0, trimmedViews: views.rowCount ?? 0, trimmedErrors: errors.rowCount ?? 0 };
}
