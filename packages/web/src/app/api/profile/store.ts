// Data layer for /api/profile (INNOBOX_SPEC.md §13.5). Own profile shows everything about
// the viewer's own contributions (no visibility gate needed — a user can always see their
// own items regardless of status/anonymity). Another user's public profile shows only their
// non-anonymous, org-visible contributions — the same invariant-2/3 rules applied elsewhere,
// just scoped to "authored by this other user" instead of "matches this filter".
import type { Pool } from "pg";
import { formatChallengeNumber, formatSolutionNumber, type ChallengeStatus, type SolutionStatus } from "@innobox/shared";

export interface OwnProfile {
  user: { id: string; displayName: string; email: string | null; department: string | null; jobTitle: string | null; officeLocation: string | null };
  emailNotificationsEnabled: boolean;
  challengesByStatus: Record<string, number>;
  solutionsByStatus: Record<string, number>;
  likesReceived: number;
  following: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
  recentActivity: { type: "challenge" | "solution"; number: string; challengeNumber: string; label: string; status: string; at: string }[];
}

export async function getOwnProfile(pool: Pool, userId: string): Promise<OwnProfile | null> {
  const { rows: userRows } = await pool.query<{
    id: string;
    display_name: string;
    email: string | null;
    department: string | null;
    job_title: string | null;
    office_location: string | null;
    email_notifications_enabled: boolean;
  }>(`select id, display_name, email, department, job_title, office_location, email_notifications_enabled from users where id = $1`, [userId]);
  const userRow = userRows[0];
  if (!userRow) return null;

  const [challengeStatusRows, solutionStatusRows, likeRows, followedChallenges, followedSolutions, recentChallenges, recentSolutions] =
    await Promise.all([
      pool.query<{ status: ChallengeStatus; count: string }>(
        `select status, count(*)::text as count from challenges where author_id = $1 group by status`,
        [userId],
      ),
      pool.query<{ status: SolutionStatus; count: string }>(
        `select status, count(*)::text as count from solutions where author_id = $1 group by status`,
        [userId],
      ),
      pool.query<{ count: string }>(
        `select count(*)::text as count
           from likes l
          where (l.parent_type = 'challenge' and exists(select 1 from challenges c where c.id = l.parent_id and c.author_id = $1))
             or (l.parent_type = 'solution' and exists(select 1 from solutions s where s.id = l.parent_id and s.author_id = $1))`,
        [userId],
      ),
      pool.query<{ number: string; title: string; status: string }>(
        `select c.number::text, c.title, c.status
           from follows f join challenges c on c.id = f.parent_id
          where f.user_id = $1 and f.parent_type = 'challenge'
          order by f.created_at desc limit 50`,
        [userId],
      ),
      pool.query<{ number: string; description: string; status: string; challenge_number: string }>(
        `select s.number::text, s.description, s.status, c.number::text as challenge_number
           from follows f join solutions s on s.id = f.parent_id join challenges c on c.id = s.challenge_id
          where f.user_id = $1 and f.parent_type = 'solution'
          order by f.created_at desc limit 50`,
        [userId],
      ),
      pool.query<{ number: string; title: string; status: string; at: Date }>(
        `select number::text, title, status, greatest(created_at, updated_at) as at
           from challenges where author_id = $1
          order by at desc limit 20`,
        [userId],
      ),
      pool.query<{ number: string; description: string; status: string; at: Date; challenge_number: string }>(
        `select s.number::text, s.description, s.status, greatest(s.created_at, s.updated_at) as at, c.number::text as challenge_number
           from solutions s join challenges c on c.id = s.challenge_id
          where s.author_id = $1
          order by at desc limit 20`,
        [userId],
      ),
    ]);

  const challengesByStatus: Record<string, number> = {};
  for (const row of challengeStatusRows.rows) challengesByStatus[row.status] = Number(row.count);
  const solutionsByStatus: Record<string, number> = {};
  for (const row of solutionStatusRows.rows) solutionsByStatus[row.status] = Number(row.count);

  const recentActivity = [
    ...recentChallenges.rows.map((r) => ({
      type: "challenge" as const,
      number: formatChallengeNumber(r.number),
      challengeNumber: formatChallengeNumber(r.number),
      label: r.title,
      status: r.status,
      at: r.at.toISOString(),
    })),
    ...recentSolutions.rows.map((r) => ({
      type: "solution" as const,
      number: formatSolutionNumber(r.number),
      challengeNumber: formatChallengeNumber(r.challenge_number),
      label: r.description,
      status: r.status,
      at: r.at.toISOString(),
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 20);

  return {
    user: {
      id: userRow.id,
      displayName: userRow.display_name,
      email: userRow.email,
      department: userRow.department,
      jobTitle: userRow.job_title,
      officeLocation: userRow.office_location,
    },
    emailNotificationsEnabled: userRow.email_notifications_enabled,
    challengesByStatus,
    solutionsByStatus,
    likesReceived: Number(likeRows.rows[0]?.count ?? 0),
    following: {
      challenges: followedChallenges.rows.map((r) => ({ number: formatChallengeNumber(r.number), title: r.title, status: r.status })),
      solutions: followedSolutions.rows.map((r) => ({
        number: formatSolutionNumber(r.number),
        description: r.description,
        status: r.status,
        challengeNumber: formatChallengeNumber(r.challenge_number),
      })),
    },
    recentActivity,
  };
}

export async function setEmailNotificationsEnabled(pool: Pool, userId: string, enabled: boolean): Promise<void> {
  await pool.query(`update users set email_notifications_enabled = $2, updated_at = now() where id = $1`, [userId, enabled]);
}

export interface PublicProfile {
  user: { id: string; displayName: string; department: string | null; jobTitle: string | null; officeLocation: string | null };
  contributions: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
}

/** Non-anonymous, org-visible contributions only (§13.5, invariants 2-3) — this is what any
 *  authenticated viewer may see about another user, regardless of their own roles. */
export async function getPublicProfile(pool: Pool, userId: string): Promise<PublicProfile | null> {
  const { rows: userRows } = await pool.query<{
    id: string;
    display_name: string;
    department: string | null;
    job_title: string | null;
    office_location: string | null;
    active: boolean;
  }>(
    `select id, display_name, department, job_title, office_location, active from users where id = $1`,
    [userId],
  );
  const userRow = userRows[0];
  if (!userRow || !userRow.active) return null;

  const [challengeRows, solutionRows] = await Promise.all([
    pool.query<{ number: string; title: string; status: string }>(
      `select number::text, title, status from challenges
        where author_id = $1 and is_anonymous = false and visibility = 'org'
          and status not in ('awaiting_triage', 'withdrawn')
        order by created_at desc limit 50`,
      [userId],
    ),
    pool.query<{ number: string; description: string; status: string; challenge_number: string }>(
      `select s.number::text, s.description, s.status, c.number::text as challenge_number
         from solutions s join challenges c on c.id = s.challenge_id
        where s.author_id = $1 and s.is_anonymous = false and c.visibility = 'org'
          and s.status not in ('proposed', 'withdrawn')
        order by s.created_at desc limit 50`,
      [userId],
    ),
  ]);

  return {
    user: {
      id: userRow.id,
      displayName: userRow.display_name,
      department: userRow.department,
      jobTitle: userRow.job_title,
      officeLocation: userRow.office_location,
    },
    contributions: {
      challenges: challengeRows.rows.map((r) => ({ number: formatChallengeNumber(r.number), title: r.title, status: r.status })),
      solutions: solutionRows.rows.map((r) => ({
        number: formatSolutionNumber(r.number),
        description: r.description,
        status: r.status,
        challengeNumber: formatChallengeNumber(r.challenge_number),
      })),
    },
  };
}
