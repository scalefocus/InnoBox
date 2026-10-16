// Presence READ path (INNOBOX_SPEC.md §14.5) — the queries behind the platform-admin
// "Currently online" panel. Two responsibilities beyond fetching rows:
//
//   • Rolling windows come from users.last_seen_at alone. DAU/WAU/MAU are "distinct users
//     whose LAST activity falls inside the window", which a single column answers exactly:
//     someone last active three days ago counts in WAU and MAU but not DAU. No history
//     table is involved, which is why the tiles work from day one.
//   • Location masking (§9). users.last_route holds an opaque token; the display label —
//     and the decision to withhold it — is resolved HERE, where the anonymity flag is in
//     reach, never on the write path.
import type { Pool } from "pg";
import { PRESENCE_MAU_DAYS, PRESENCE_REAL_PEOPLE_SQL, PRESENCE_WAU_DAYS } from "@innobox/shared/presence";
import {
  PRESENCE_LIST_CAP,
  categoryLabel,
  parseEntityRoute,
  rangeDays,
  windowSeconds,
  type PresenceRange,
  type PresenceWindow,
} from "@/lib/presence";

export interface OnlineUser {
  id: string;
  displayName: string;
  email: string | null;
  /** false → the greyed, "Deactivated" treatment (§13.6). Scrubbed users never appear. */
  active: boolean;
  lastSeenAt: string;
  /** Resolved, anonymity-masked location, or null when the user has no recorded route. */
  location: string | null;
}

export interface PresenceSummary {
  asOf: string;
  window: PresenceWindow;
  dau: number;
  wau: number;
  mau: number;
  /** Users in the window BEFORE the cap — the "showing 200 of 412" denominator. */
  total: number;
  users: OnlineUser[];
}

export interface PresencePoint {
  day: string;
  activeUsers: number;
  /** Rolling 7- / 30-day distinct users, sampled once per closed day by the worker (§14.5);
   *  null where no sample exists — before the snapshot shipped, or a day never swept. */
  wau: number | null;
  mau: number | null;
}

const DAY_SECONDS = 24 * 60 * 60;

// The person filter — scrubbed users and the e-mail service mailbox excluded — is shared with
// the worker's daily snapshot, which is defined as these tiles sampled once a day.
const REAL_PEOPLE = PRESENCE_REAL_PEOPLE_SQL;

async function countActiveWithin(pool: Pool, seconds: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from users u
      where ${REAL_PEOPLE}
        and u.last_seen_at > now() - make_interval(secs => $1)`,
    [seconds],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Resolves `challenge:412` / `solution:87` tokens to labels, masking anonymous targets
 *  down to their bare category (§9, §14.5). One query per entity kind for the whole page. */
async function resolveLocations(pool: Pool, routes: string[]): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  const challengeNumbers: number[] = [];
  const solutionNumbers: number[] = [];

  for (const route of new Set(routes)) {
    const entity = parseEntityRoute(route);
    if (!entity) {
      resolved.set(route, categoryLabel(route));
      continue;
    }
    (entity.kind === "challenge" ? challengeNumbers : solutionNumbers).push(entity.number);
    // Default to the masked category: an entity that turns out to be anonymous, deleted, or
    // simply missing keeps this value. Masking is the fallback, never the exception.
    resolved.set(route, categoryLabel(entity.kind === "challenge" ? "challenges" : "solutions"));
  }

  if (challengeNumbers.length > 0) {
    const { rows } = await pool.query<{ number: number; title: string }>(
      `select number, title from challenges
        where number = any($1::int[]) and not is_anonymous and trashed_at is null`,
      [challengeNumbers],
    );
    for (const r of rows) resolved.set(`challenge:${r.number}`, `Challenge: CH-${r.number} — ${r.title}`);
  }

  if (solutionNumbers.length > 0) {
    // A solution is masked when EITHER it or its challenge is anonymous: naming the parent
    // would surface an anonymous challenge's title through the child.
    const { rows } = await pool.query<{ number: number; challenge_number: number; title: string }>(
      `select s.number, c.number as challenge_number, c.title
         from solutions s
         join challenges c on c.id = s.challenge_id
        where s.number = any($1::int[]) and not s.is_anonymous and not c.is_anonymous
          and s.trashed_at is null and c.trashed_at is null`,
      [solutionNumbers],
    );
    for (const r of rows) {
      resolved.set(`solution:${r.number}`, `Solution: SOL-${r.number} on CH-${r.challenge_number} — ${r.title}`);
    }
  }

  return resolved;
}

/** The panel's main payload: rolling tiles + the capped, most-recent-first window list. */
export async function presenceSummary(pool: Pool, window: PresenceWindow): Promise<PresenceSummary> {
  const seconds = windowSeconds(window);

  const [dau, wau, mau, total] = await Promise.all([
    countActiveWithin(pool, DAY_SECONDS),
    countActiveWithin(pool, PRESENCE_WAU_DAYS * DAY_SECONDS),
    countActiveWithin(pool, PRESENCE_MAU_DAYS * DAY_SECONDS),
    countActiveWithin(pool, seconds),
  ]);

  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    email: string | null;
    active: boolean;
    last_seen_at: Date;
    last_route: string | null;
  }>(
    `select u.id, u.display_name, u.email, u.active, u.last_seen_at, u.last_route
       from users u
      where ${REAL_PEOPLE}
        and u.last_seen_at > now() - make_interval(secs => $1)
      order by u.last_seen_at desc
      limit $2`,
    [seconds, PRESENCE_LIST_CAP],
  );

  const locations = await resolveLocations(
    pool,
    rows.map((r) => r.last_route).filter((r): r is string => r !== null),
  );

  return {
    asOf: new Date().toISOString(),
    window,
    dau,
    wau,
    mau,
    total,
    users: rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      email: r.email,
      active: r.active,
      lastSeenAt: r.last_seen_at.toISOString(),
      location: r.last_route ? (locations.get(r.last_route) ?? null) : null,
    })),
  };
}

/**
 * The chart series: one point per UTC day (invariant 8), CONTIGUOUS from the first recorded day
 * to today, so the time axis never bridges a gap with a straight line (§14.5).
 *
 *   • Closed days come from the worker-maintained aggregate `presence_daily`. A day with no row
 *     is a day nobody was active — the rollup repairs every day still inside the 3-day detail
 *     window — so its daily count is 0. Its weekly/monthly values stay NULL: no sample exists,
 *     and the chart draws a break rather than inventing one.
 *   • TODAY is the day in progress: its daily count is computed live from the transient
 *     `user_activity_days` detail (which always still holds it — the purge is 3 days behind),
 *     and its weekly/monthly values are the live tiles, so the lines end where the tiles stand.
 */
export async function presenceHistory(pool: Pool, range: PresenceRange): Promise<PresencePoint[]> {
  const days = rangeDays(range);
  const { rows } = await pool.query<{ day: string; active_users: number; wau: number | null; mau: number | null }>(
    `with b as (select (now() at time zone 'utc')::date as today),
     bounds as (
       select greatest(
                coalesce((select min(day) from presence_daily), b.today),
                case when $1::int is null then '-infinity'::date else b.today - $1::int end
              ) as first_day,
              b.today
         from b
     ),
     live as (
       select (select count(distinct user_id)::int from user_activity_days, b where day = b.today) as active_users,
              count(*) filter (where u.last_seen_at > now() - make_interval(secs => $2))::int as wau,
              count(*) filter (where u.last_seen_at > now() - make_interval(secs => $3))::int as mau
         from users u
        where ${REAL_PEOPLE}
     )
     select to_char(g.day, 'YYYY-MM-DD') as day,
            case when g.day = bounds.today then live.active_users else coalesce(pd.active_users, 0) end as active_users,
            case when g.day = bounds.today then live.wau else pd.wau end as wau,
            case when g.day = bounds.today then live.mau else pd.mau end as mau
       from bounds
      cross join live
      cross join lateral (
        -- Plain timestamps, never timestamptz: a bare date would resolve to the timestamptz
        -- overload and walk the days in the session TimeZone (invariant 8).
        select d::date as day
          from generate_series(bounds.first_day::timestamp, bounds.today::timestamp, interval '1 day') as d
      ) g
       left join presence_daily pd on pd.day = g.day and g.day < bounds.today
      order by g.day`,
    [days, PRESENCE_WAU_DAYS * DAY_SECONDS, PRESENCE_MAU_DAYS * DAY_SECONDS],
  );
  return rows.map((r) => ({ day: r.day, activeUsers: r.active_users, wau: r.wau, mau: r.mau }));
}
