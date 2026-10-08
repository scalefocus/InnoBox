// The §14.5 presence rollup sweep — what makes long-lived presence history NON-PERSONAL.
//
// Two statements, in this order, and the order is the whole point:
//   1. ROLL each closed UTC day from the per-person detail (`user_activity_days`) into the
//      aggregate `presence_daily` (day → distinct-user count, no user ids).
//   2. PURGE detail rows older than the retention floor.
//
// The rollup window (closed days still within retention) deliberately OVERLAPS the purge
// floor by a wide margin: a day is rolled for ~2 days before it becomes purgeable, so an
// hourly sweep would have to miss dozens of runs before a day could be purged unrolled. The
// rollup is an upsert over that whole window rather than "yesterday only", so a sweep that
// did not run (worker down, leadership change) is repaired by the next one.
//
// Days are UTC buckets (invariant 8): `(now() at time zone 'utc')::date`, never
// `current_date`, whose value follows the session TimeZone.
import type { Pool } from "pg";

/** Days of per-person detail kept before the purge (§14.5). */
export const PRESENCE_DETAIL_RETENTION_DAYS = 3;

export interface PresenceRollupSummary {
  /** Closed days (re)written into presence_daily this sweep. */
  rolled: number;
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

  // Only after the rollup — never in the same statement, and never before it.
  const purged = await pool.query(
    `delete from user_activity_days
      where day < (now() at time zone 'utc')::date - $1::int`,
    [retentionDays],
  );

  return { rolled: rolled.rowCount ?? 0, purged: purged.rowCount ?? 0 };
}
