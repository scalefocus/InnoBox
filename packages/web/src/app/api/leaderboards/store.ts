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
import type { Pool } from "pg";
import type { LeaderboardMetric, LeaderboardWindow } from "@innobox/shared";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  /** §13.6: false for a deactivated user — the row renders the greyed bubble. */
  active: boolean;
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
         where c.is_anonymous = false and ${CHALLENGE_ORG_VISIBLE} and c.status <> 'rejected'
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
    case "likes_received":
      sql = `
        select author_id as user_id, count(*)::int as cnt, min(liked_at) as first_at
          from (
            select c.author_id, l.created_at as liked_at
              from likes l
              join challenges c on c.id = l.parent_id
             where l.parent_type = 'challenge'
               and c.is_anonymous = false and ${CHALLENGE_ORG_VISIBLE} and c.status <> 'rejected'
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

  const { rows } = await pool.query<{ user_id: string; display_name: string; active: boolean; cnt: number }>(
    `select t.user_id, u.display_name, u.active, t.cnt
       from (${sql}) t
       join users u on u.id = t.user_id
      order by t.cnt desc, t.first_at asc, t.user_id asc
      limit $2`,
    [since, limit],
  );
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, active: r.active, count: r.cnt }));
}
