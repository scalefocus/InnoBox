// Data layer for /api/leaderboards (INNOBOX_SPEC.md §13.3): top 10 per metric/window,
// computed over org-visible, non-anonymous, non-rejected contributions only (§4.3, §9) — so a
// public leaderboard never hints at restricted, un-triaged, un-reviewed or anonymous work.
//
// "Org-visible" is the full §4.3 test an arbitrary authenticated viewer would pass — the same
// predicate the public profile uses (§13.5) — applied to the item AND, for a solution (and a
// like on one), to its parent challenge:
//   - a challenge counts only if it is `org`-visible and not `awaiting_triage` / `withdrawn`;
//   - a solution counts only if it is not `proposed` / `withdrawn` AND its parent challenge
//     passes the challenge test (it inherits the parent's visibility, §4.3).
// On top of that every metric excludes anonymous items unconditionally (after a self-reveal,
// is_anonymous flips false and they start counting) and `rejected` contributions.
//
// Ranked by count descending; ties break by earliest achiever — the earliest qualifying
// timestamp ascending. For "solutions implemented" that timestamp is when the solution
// ENTERED `implemented` (`status_changed_at`), not its last edit (`updated_at`), so a later
// unrelated touch never reorders a tie or drops an achievement out of the 30-day window.
//
// §23 adds a fifth metric, **points**: the sum of a user's ledger points whose item passes the same
// live org-visible test, windowed and tie-broken by the award's occurred_at, excluding users who
// hide their gamification. The ranked boards are cached briefly per (metric, window) — the same
// results the §23.5 leader badges are derived from.
import type { Pool } from "pg";
import type { LeaderboardMetric, LeaderboardWindow } from "@innobox/shared";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  /** §13.6: false for a deactivated user — the row renders the greyed bubble. */
  active: boolean;
  /** §13.6: true for a GDPR-scrubbed user — the row renders the neutral "Deleted User" bubble. */
  scrubbed: boolean;
  count: number;
}

export const LEADERBOARD_SIZE = 10;

/** §4.3 org-visible challenge test (alias `c`) — what every authenticated viewer can see. */
const CHALLENGE_ORG_VISIBLE = `c.visibility = 'org' and c.status not in ('awaiting_triage', 'withdrawn')`;
/** §4.3 org-visible solution test (alias `s`) — always paired with CHALLENGE_ORG_VISIBLE on its parent. */
const SOLUTION_ORG_VISIBLE = `s.status not in ('proposed', 'withdrawn')`;

function windowStart(window: LeaderboardWindow): Date | null {
  if (window === "all") return null;
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/** `limit` exists for the dbtest (which shares a database with other suites and so cannot rely
 *  on its fixtures ranking in the top 10); the route always uses the §13.3 top 10. */
export async function getLeaderboard(
  pool: Pool,
  metric: LeaderboardMetric,
  window: LeaderboardWindow,
  limit: number = LEADERBOARD_SIZE,
): Promise<LeaderboardEntry[]> {
  const since = windowStart(window);

  let sql: string;
  switch (metric) {
    case "solutions_implemented":
      sql = `
        select s.author_id as user_id, count(*)::int as cnt, min(s.status_changed_at) as first_at
          from solutions s
          join challenges c on c.id = s.challenge_id
         where s.status = 'implemented' and s.is_anonymous = false
           and ${CHALLENGE_ORG_VISIBLE}
           and ($1::timestamptz is null or s.status_changed_at >= $1)
         group by s.author_id`;
      break;
    case "challenges_submitted":
      sql = `
        select c.author_id as user_id, count(*)::int as cnt, min(c.created_at) as first_at
          from challenges c
         where c.is_anonymous = false and c.author_id is not null and ${CHALLENGE_ORG_VISIBLE} and c.status <> 'rejected'
           and ($1::timestamptz is null or c.created_at >= $1)
         group by c.author_id`;
      break;
    case "solutions_proposed":
      sql = `
        select s.author_id as user_id, count(*)::int as cnt, min(s.created_at) as first_at
          from solutions s
          join challenges c on c.id = s.challenge_id
         where s.is_anonymous = false and ${SOLUTION_ORG_VISIBLE} and s.status <> 'rejected'
           and ${CHALLENGE_ORG_VISIBLE}
           and ($1::timestamptz is null or s.created_at >= $1)
         group by s.author_id`;
      break;
    case "points":
      // §23.9: rows whose item no longer exists, or is no longer org-visible, drop out of the
      // ranking (not out of the person's total); users who hide their gamification are excluded.
      sql = `
        select gl.user_id, sum(gl.points)::int as cnt, min(gl.occurred_at) filter (where gl.points > 0) as first_at
          from gamification_ledger gl
          join users pu on pu.id = gl.user_id and pu.gamification_public
          left join challenges c on gl.item_type = 'challenge' and c.id = gl.item_id
          left join solutions s on gl.item_type = 'solution' and s.id = gl.item_id
          left join challenges sc on sc.id = s.challenge_id
         where ($1::timestamptz is null or gl.occurred_at >= $1)
           and (
             (gl.item_type = 'challenge' and ${CHALLENGE_ORG_VISIBLE})
             or (gl.item_type = 'solution' and ${SOLUTION_ORG_VISIBLE}
                 and sc.visibility = 'org' and sc.status not in ('awaiting_triage', 'withdrawn'))
           )
         group by gl.user_id
        having sum(gl.points) > 0`;
      break;
    case "likes_received":
      sql = `
        select author_id as user_id, count(*)::int as cnt, min(liked_at) as first_at
          from (
            select c.author_id, l.created_at as liked_at
              from likes l
              join challenges c on c.id = l.parent_id
             where l.parent_type = 'challenge'
               and c.is_anonymous = false and c.author_id is not null and ${CHALLENGE_ORG_VISIBLE} and c.status <> 'rejected'
               and ($1::timestamptz is null or l.created_at >= $1)
            union all
            select s.author_id, l.created_at as liked_at
              from likes l
              join solutions s on s.id = l.parent_id
              join challenges c on c.id = s.challenge_id
             where l.parent_type = 'solution'
               and s.is_anonymous = false and ${SOLUTION_ORG_VISIBLE} and s.status <> 'rejected'
               and ${CHALLENGE_ORG_VISIBLE}
               and ($1::timestamptz is null or l.created_at >= $1)
          ) contributions
         group by author_id`;
      break;
  }

  const { rows } = await pool.query<{ user_id: string; display_name: string; active: boolean; scrubbed: boolean; cnt: number }>(
    `select t.user_id, u.display_name, u.active, u.scrubbed_at is not null as scrubbed, t.cnt
       from (${sql}) t
       join users u on u.id = t.user_id
      order by t.cnt desc, t.first_at asc, t.user_id asc
      limit $2`,
    [since, limit],
  );
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, active: r.active, scrubbed: r.scrubbed, count: r.cnt }));
}

/** How long a ranked board is reused. Every viewer sees the same board (it is viewer-independent),
 *  so a short process-local cache is safe; the leader badges (§23.5) read the same entries. */
export const BOARD_CACHE_MS = 30_000;
const boardCache = new Map<string, { at: number; entries: Promise<LeaderboardEntry[]> }>();

/** The §13.3 top 10 for a (metric, window), cached for BOARD_CACHE_MS. */
export function getCachedLeaderboard(pool: Pool, metric: LeaderboardMetric, window: LeaderboardWindow): Promise<LeaderboardEntry[]> {
  const key = `${metric}:${window}`;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < BOARD_CACHE_MS) return hit.entries;
  const entries = getLeaderboard(pool, metric, window);
  boardCache.set(key, { at: Date.now(), entries });
  entries.catch(() => boardCache.delete(key)); // never cache a failure
  return entries;
}

/** Test hook: forget every cached board. */
export function clearLeaderboardCache(): void {
  boardCache.clear();
}
