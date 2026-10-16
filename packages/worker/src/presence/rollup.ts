// The §14.5 presence rollup sweep — what makes long-lived presence history NON-PERSONAL.
//
// Three statements, in this order, and the order is the whole point:
//   1. ROLL each closed UTC day from the per-person detail (`user_activity_days`) into the
//      aggregate `presence_daily` (day → distinct-user count, no user ids).
//   2. SNAPSHOT the just-closed day's rolling WAU / MAU (§14.5 "Weekly / monthly history"),
//      once. After the rollup, so a day with activity already has its row and the snapshot
//      only fills the two counts.
//   3. PURGE detail rows older than the retention floor.
//
// The rollup window (closed days still within retention) deliberately OVERLAPS the purge
// floor by a wide margin: a day is rolled for ~2 days before it becomes purgeable, so an
// hourly sweep would have to miss dozens of runs before a day could be purged unrolled. The
// rollup is an upsert over that whole window rather than "yesterday only", so a sweep that
// did not run (worker down, leadership change) is repaired by the next one.
//
// The snapshot is the opposite: it CANNOT be repaired, and must not be. A rolling distinct
// count is only knowable at the moment it is taken — `last_seen_at` only moves forward, so
// "last seen within the trailing 7 days" is exact for the 7 days ending NOW, and for no other
// window. The first sweep of a UTC day therefore writes yesterday's pair, and every later sweep
// leaves it alone (a later sample would measure a later window and silently move the point).
// A day whose following UTC day saw no sweep at all keeps NULL, which the chart draws as a
// break.
//
// Days are UTC buckets (invariant 8): `(now() at time zone 'utc')::date`, never
// `current_date`, whose value follows the session TimeZone.
import type { Pool } from "pg";
import { PRESENCE_MAU_DAYS, PRESENCE_REAL_PEOPLE_SQL, PRESENCE_WAU_DAYS } from "@innobox/shared/presence";

/** Days of per-person detail kept before the purge (§14.5). */
export const PRESENCE_DETAIL_RETENTION_DAYS = 3;

const DAY_SECONDS = 24 * 60 * 60;

export interface PresenceRollupSummary {
  /** Closed days (re)written into presence_daily this sweep. */
  rolled: number;
  /** True when this sweep wrote yesterday's WAU / MAU (the first sweep of the UTC day). */
  snapshot: boolean;
  /** Per-person detail rows erased this sweep. */
  purged: number;
}

export async function runPresenceRollupSweep(
  pool: Pool,
  opts: { retentionDays?: number } = {},
): Promise<PresenceRollupSummary> {
  const retentionDays = opts.retentionDays ?? PRESENCE_DETAIL_RETENTION_DAYS;

  const rolled = await pool.query(
    `insert into presence_daily (day, active_users)
     select day, count(distinct user_id)
       from user_activity_days
      where day < (now() at time zone 'utc')::date
        and day >= (now() at time zone 'utc')::date - $1::int
      group by day
     on conflict (day) do update set active_users = excluded.active_users`,
    [retentionDays],
  );

  // The tiles' own formula and person filter (shared with api/admin/presence/store.ts), sampled
  // now. A day nobody was active on has no rollup row, so the snapshot inserts it with a zero
  // count; otherwise it touches only wau / mau, and only while they are still NULL.
  const snapshot = await pool.query(
    `insert into presence_daily (day, active_users, wau, mau)
     select (now() at time zone 'utc')::date - 1, 0,
            count(*) filter (where u.last_seen_at > now() - make_interval(secs => $1)),
            count(*) filter (where u.last_seen_at > now() - make_interval(secs => $2))
       from users u
      where ${PRESENCE_REAL_PEOPLE_SQL}
     on conflict (day) do update set wau = excluded.wau, mau = excluded.mau
      where presence_daily.wau is null`,
    [PRESENCE_WAU_DAYS * DAY_SECONDS, PRESENCE_MAU_DAYS * DAY_SECONDS],
  );

  // Only after the rollup — never in the same statement, and never before it.
  const purged = await pool.query(
    `delete from user_activity_days
      where day < (now() at time zone 'utc')::date - $1::int`,
    [retentionDays],
  );

  return { rolled: rolled.rowCount ?? 0, snapshot: (snapshot.rowCount ?? 0) > 0, purged: purged.rowCount ?? 0 };
}
