// The real-user-monitoring aggregate SQL (INNOBOX_SPEC.md §14.12), shared by the worker's hourly
// rollup (worker rum/rollup.ts) and the web read path (api/admin/rum/store.ts) — the 7d table,
// today's live rollup rows and today's chart point. One definition, so the stored daily rows and
// the live ones are the same arithmetic.
//
// Every measure is a true 75th percentile (`percentile_cont`, which skips nulls — a soft
// navigation has no LCP and does not drag the percentile down). The API percentile runs over
// every timed call, unnested from the views. Grouping sets add one row with route '*' over all
// routes, so the all-routes figures are real percentiles too, never a blend of per-route ones.
// Also at `@innobox/shared/rum-sql`.

/**
 * The aggregate select over `rum_views v` rows matching `where` (a SQL condition on `v`, with
 * its own placeholders). `perDay` groups by (day, route) — the rollup's shape, one row per day —
 * otherwise by route alone over the whole matched span (the raw 7d range). Columns: day (perDay
 * only), route, views, sessions, p75_lcp_ms, p75_inp_ms, p75_cls, p75_ttfb_ms, p75_nav_ms,
 * p75_api_ms, api_calls, api_errors, client_errors.
 */
export function rumAggregateSql(where: string, perDay: boolean): string {
  const keys = perDay ? "v.day, " : "";
  const sets = perDay ? "grouping sets ((v.day, v.route), (v.day))" : "grouping sets ((v.route), ())";
  const join = perDay ? "a.day = m.day and a.route = m.route" : "a.route = m.route";
  return `
    select ${perDay ? "m.day, " : ""}m.route, m.views, m.sessions,
           m.p75_lcp_ms, m.p75_inp_ms, m.p75_cls, m.p75_ttfb_ms, m.p75_nav_ms,
           a.p75_api_ms, m.api_calls, m.api_errors, m.client_errors
      from (
        select ${keys}coalesce(v.route, '*') as route,
               count(*)::int as views,
               count(distinct v.session_id)::int as sessions,
               round(percentile_cont(0.75) within group (order by v.lcp_ms))::int as p75_lcp_ms,
               round(percentile_cont(0.75) within group (order by v.inp_ms))::int as p75_inp_ms,
               round((percentile_cont(0.75) within group (order by v.cls))::numeric, 4) as p75_cls,
               round(percentile_cont(0.75) within group (order by v.ttfb_ms))::int as p75_ttfb_ms,
               round(percentile_cont(0.75) within group (order by v.nav_ms))::int as p75_nav_ms,
               coalesce(sum(v.api_calls), 0)::int as api_calls,
               coalesce(sum(v.api_errors), 0)::int as api_errors,
               coalesce(sum(v.client_errors), 0)::int as client_errors
          from rum_views v
         where ${where}
         group by ${sets}
      ) m
      left join (
        select ${keys}coalesce(v.route, '*') as route,
               round(percentile_cont(0.75) within group (order by t.ms))::int as p75_api_ms
          from rum_views v
         cross join lateral unnest(v.api_ms) as t(ms)
         where ${where}
         group by ${sets}
      ) a on ${join}`;
}

/** The columns `rumAggregateSql` returns, as node-postgres hands them over (numeric → string). */
export interface RumAggregateRow {
  day?: string | Date;
  route: string;
  views: number;
  sessions: number;
  p75_lcp_ms: number | null;
  p75_inp_ms: number | null;
  p75_cls: string | number | null;
  p75_ttfb_ms: number | null;
  p75_nav_ms: number | null;
  p75_api_ms: number | null;
  api_calls: number;
  api_errors: number;
  client_errors: number;
}
