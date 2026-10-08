// Data layer for /api/leaderboards (INNOBOX_SPEC.md §13.3): top 10 per metric/window,
// computed over org-visible, non-anonymous, non-rejected contributions only (so a public
// leaderboard never hints at restricted or spammy work) — anonymous items are excluded
// unconditionally; after self-reveal (is_anonymous flips false) they start counting, per
// spec. Ties break by earliest achiever (the earliest qualifying timestamp ascending).
import type { Pool } from "pg";
import type { LeaderboardMetric, LeaderboardWindow } from "@innobox/shared";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  count: number;
}

function windowStart(window: LeaderboardWindow): Date | null {
  if (window === "all") return null;
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

export async function getLeaderboard(pool: Pool, metric: LeaderboardMetric, window: LeaderboardWindow): Promise<LeaderboardEntry[]> {
  const since = windowStart(window);

  let sql: string;
  switch (metric) {
    case "solutions_implemented":
      sql = `
        select s.author_id as user_id, u.display_name, count(*)::int as cnt, min(s.updated_at) as first_at
          from solutions s
          join challenges c on c.id = s.challenge_id
          join users u on u.id = s.author_id
         where s.status = 'implemented' and s.is_anonymous = false and c.visibility = 'org'
           and ($1::timestamptz is null or s.updated_at >= $1)
         group by s.author_id, u.display_name
         order by cnt desc, first_at asc
         limit 10`;
      break;
    case "challenges_submitted":
      sql = `
        select c.author_id as user_id, u.display_name, count(*)::int as cnt, min(c.created_at) as first_at
          from challenges c
          join users u on u.id = c.author_id
         where c.is_anonymous = false and c.visibility = 'org' and c.status not in ('rejected', 'withdrawn')
           and ($1::timestamptz is null or c.created_at >= $1)
         group by c.author_id, u.display_name
         order by cnt desc, first_at asc
         limit 10`;
      break;
    case "solutions_proposed":
      sql = `
        select s.author_id as user_id, u.display_name, count(*)::int as cnt, min(s.created_at) as first_at
          from solutions s
          join challenges c on c.id = s.challenge_id
          join users u on u.id = s.author_id
         where s.is_anonymous = false and c.visibility = 'org' and s.status not in ('rejected', 'withdrawn')
           and ($1::timestamptz is null or s.created_at >= $1)
         group by s.author_id, u.display_name
         order by cnt desc, first_at asc
         limit 10`;
      break;
    case "likes_received":
      sql = `
        select author_id as user_id, display_name, count(*)::int as cnt, min(liked_at) as first_at
          from (
            select c.author_id, u.display_name, l.created_at as liked_at
              from likes l
              join challenges c on c.id = l.parent_id
              join users u on u.id = c.author_id
             where l.parent_type = 'challenge'
               and c.is_anonymous = false and c.visibility = 'org' and c.status not in ('rejected', 'withdrawn')
               and ($1::timestamptz is null or l.created_at >= $1)
            union all
            select s.author_id, u.display_name, l.created_at as liked_at
              from likes l
              join solutions s on s.id = l.parent_id
              join challenges c on c.id = s.challenge_id
              join users u on u.id = s.author_id
             where l.parent_type = 'solution'
               and s.is_anonymous = false and c.visibility = 'org' and s.status not in ('rejected', 'withdrawn')
               and ($1::timestamptz is null or l.created_at >= $1)
          ) contributions
         group by author_id, display_name
         order by cnt desc, first_at asc
         limit 10`;
      break;
  }

  const { rows } = await pool.query<{ user_id: string; display_name: string; cnt: number }>(sql, [since]);
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, count: r.cnt }));
}
