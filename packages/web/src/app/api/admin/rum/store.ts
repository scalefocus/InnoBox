// Read path for the §14.12 monitoring page (INNOBOX_SPEC.md): the routes table, the chart series
// and the client-error list. Platform admin only (the routes gate it). Nothing read here names a
// person — rum_views and rum_daily have no user column — so none of it is audited.
//
// Where the numbers come from:
//   • 7d   — rum_views directly, the only range the 7-day raw window covers: true p75 per route and
//            for all routes, distinct sessions over the whole range.
//   • 30d, 90d, All — rum_daily for the closed days plus today's rows computed live from
//            rum_views with the very SQL the worker stores (shared rum-sql), then blended by
//            aggregateDailyRows: a views-weighted mean of daily p75, because percentiles cannot be
//            re-aggregated. The page says so in its caption.
//
// Days are UTC throughout: dates leave SQL as 'YYYY-MM-DD' text (node-postgres would otherwise
// turn a `date` into a local-midnight Date), and "today" is the database's UTC day.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool } from "pg";
import {
  RUM_ERROR_LIST_CAP,
  RUM_MIN_CHART_POINTS,
  aggregateDailyRows,
  contiguousSeries,
  rumRangeSource,
  rumRangeStart,
  rumRouteName,
  type RumDailyRow,
  type RumRange,
  type RumRouteSummary,
  type RumSeriesPoint,
} from "@innobox/shared/rum";
import { rumAggregateSql, type RumAggregateRow } from "@innobox/shared/rum-sql";

async function dbToday(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ today: string }>(`select to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD') as today`);
  return rows[0]!.today;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

function toSummary(row: RumAggregateRow): RumRouteSummary {
  return {
    route: row.route,
    name: rumRouteName(row.route),
    views: row.views,
    sessions: row.sessions,
    p75: {
      lcp: row.p75_lcp_ms,
      inp: row.p75_inp_ms,
      cls: num(row.p75_cls),
      ttfb: row.p75_ttfb_ms,
      nav: row.p75_nav_ms,
      api: row.p75_api_ms,
    },
    apiCalls: row.api_calls,
    apiErrors: row.api_errors,
    clientErrors: row.client_errors,
  };
}

function toDaily(row: RumAggregateRow & { day: string }): RumDailyRow {
  const s = toSummary(row);
  return { day: row.day, route: s.route, views: s.views, sessions: s.sessions, p75: s.p75, apiCalls: s.apiCalls, apiErrors: s.apiErrors, clientErrors: s.clientErrors };
}

const EMPTY_TOTAL: RumRouteSummary = {
  route: "*",
  name: rumRouteName("*"),
  views: 0,
  sessions: 0,
  p75: { lcp: null, inp: null, cls: null, ttfb: null, nav: null, api: null },
  apiCalls: 0,
  apiErrors: 0,
  clientErrors: 0,
};

/** Today's per-route rows plus its '*' row, computed live from the raw views. */
async function todayLive(pool: Pool, today: string): Promise<RumDailyRow[]> {
  const { rows } = await pool.query<RumAggregateRow & { day: string }>(
    `select to_char(q.day, 'YYYY-MM-DD') as day, q.route, q.views, q.sessions, q.p75_lcp_ms, q.p75_inp_ms, q.p75_cls,
            q.p75_ttfb_ms, q.p75_nav_ms, q.p75_api_ms, q.api_calls, q.api_errors, q.client_errors
       from (${rumAggregateSql("v.day = $1::date", true)}) q`,
    [today],
  );
  return rows.map(toDaily);
}

export interface RumSummary {
  range: RumRange;
  asOf: string;
  source: "raw" | "rollup";
  routes: RumRouteSummary[];
  total: RumRouteSummary;
}

export async function rumSummary(pool: Pool, range: RumRange): Promise<RumSummary> {
  const today = await dbToday(pool);
  const start = rumRangeStart(range, today);
  const source = rumRangeSource(range);
  const asOf = new Date().toISOString();

  if (source === "raw") {
    const { rows } = await pool.query<RumAggregateRow>(`select * from (${rumAggregateSql("v.day >= $1::date", false)}) q`, [start ?? today]);
    const all = rows.map(toSummary);
    const total = all.find((r) => r.route === "*");
    const routes = all.filter((r) => r.route !== "*" && r.views > 0).sort((a, b) => b.views - a.views || a.name.localeCompare(b.name));
    return { range, asOf, source, routes, total: total && total.views > 0 ? total : EMPTY_TOTAL };
  }

  const { rows } = await pool.query<RumAggregateRow & { day: string }>(
    `select to_char(day, 'YYYY-MM-DD') as day, route, views, sessions, p75_lcp_ms, p75_inp_ms, p75_cls,
            p75_ttfb_ms, p75_nav_ms, p75_api_ms, api_calls, api_errors, client_errors
       from rum_daily
      where day < $1::date and ($2::date is null or day >= $2::date)`,
    [today, start],
  );
  const daily = [...rows.map(toDaily), ...(await todayLive(pool, today))];
  const { routes, total } = aggregateDailyRows(daily);
  return { range, asOf, source, routes, total: total.views > 0 ? total : EMPTY_TOTAL };
}

export interface RumSeries {
  range: RumRange;
  enoughHistory: boolean;
  points: RumSeriesPoint[];
}

/** One point per UTC day, from the first recorded day to today (live), trimmed to the range. The
 *  "enough history" test counts the whole series, not the range: a 7d view of a year-old install
 *  is a chart, not the young-install note. */
export async function rumSeries(pool: Pool, range: RumRange): Promise<RumSeries> {
  const today = await dbToday(pool);
  const { rows } = await pool.query<{ day: string; views: number; p75_lcp_ms: number | null; p75_inp_ms: number | null }>(
    `select to_char(day, 'YYYY-MM-DD') as day, views, p75_lcp_ms, p75_inp_ms
       from rum_daily where route = '*' and day < $1::date order by day`,
    [today],
  );
  const live = (await todayLive(pool, today)).find((r) => r.route === "*" && r.views > 0);
  const recorded: RumSeriesPoint[] = rows.map((r) => ({ day: r.day, views: r.views, p75Lcp: r.p75_lcp_ms, p75Inp: r.p75_inp_ms }));
  if (live) recorded.push({ day: today, views: live.views, p75Lcp: live.p75.lcp, p75Inp: live.p75.inp });
  const full = contiguousSeries(recorded, today);
  const start = rumRangeStart(range, today);
  return { range, enoughHistory: full.length >= RUM_MIN_CHART_POINTS, points: start ? full.filter((p) => p.day >= start) : full };
}

export interface RumErrorRow {
  fingerprint: string;
  message: string;
  source: string;
  frame: string;
  route: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export type RumErrorSort = "last_seen" | "count";

export function parseRumErrorSort(raw: string | null | undefined): RumErrorSort {
  return raw === "count" ? "count" : "last_seen";
}

/** The deduplicated errors last seen inside the range, capped at 50, plus how many there are. */
export async function rumErrors(pool: Pool, range: RumRange, sort: RumErrorSort): Promise<{ errors: RumErrorRow[]; total: number }> {
  const today = await dbToday(pool);
  const start = rumRangeStart(range, today);
  const where = `($1::date is null or last_seen >= ($1::date)::timestamp at time zone 'utc')`;
  const order = sort === "count" ? "count desc, last_seen desc" : "last_seen desc, count desc";
  const [list, total] = await Promise.all([
    pool.query<{ fingerprint: string; message: string; source: string; frame: string; route: string; first_seen: Date; last_seen: Date; count: number }>(
      `select fingerprint, message, source, frame, route, first_seen, last_seen, count
         from rum_client_errors where ${where} order by ${order} limit $2`,
      [start, RUM_ERROR_LIST_CAP],
    ),
    pool.query<{ n: number }>(`select count(*)::int as n from rum_client_errors where ${where}`, [start]),
  ]);
  return {
    errors: list.rows.map((r) => ({
      fingerprint: r.fingerprint,
      message: r.message,
      source: r.source,
      frame: r.frame,
      route: r.route,
      name: rumRouteName(r.route),
      firstSeen: r.first_seen.toISOString(),
      lastSeen: r.last_seen.toISOString(),
      count: r.count,
    })),
    total: total.rows[0]?.n ?? 0,
  };
}
