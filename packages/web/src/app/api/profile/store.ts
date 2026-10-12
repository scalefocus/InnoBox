// Data layer for /api/profile (INNOBOX_SPEC.md §13.5). Own profile shows everything about
// the viewer's own contributions (no visibility gate needed — a user can always see their
// own items regardless of status/anonymity). The items they FOLLOW are a different matter: a
// follow outlives the owner's access (a membership loss, a withdrawal, a re-triage), so those
// lists apply the full §4.3 predicate for the owner. Another user's public profile shows only their
// non-anonymous, org-visible contributions — the same invariant-2/3 rules applied elsewhere,
// just scoped to "authored by this other user" instead of "matches this filter".
import type { Pool } from "pg";
import {
  NOTIFICATION_PREFERENCE_COLUMN,
  NOTIFICATION_PREFERENCES,
  formatChallengeNumber,
  formatSolutionNumber,
  type ChallengeStatus,
  type NotificationPreferences,
  type SolutionStatus,
} from "@innobox/shared";
import { pushChallengeVisibilityConditions, pushSolutionVisibilityConditions, type Viewer } from "../challenges/store";

export interface OwnProfile {
  user: { id: string; displayName: string; email: string | null; department: string | null; jobTitle: string | null; officeLocation: string | null };
  emailNotificationsEnabled: boolean;
  /** §12.1 per-event preferences. */
  notificationPreferences: NotificationPreferences;
  /** §13.10 the random feedback-survey opt-out ("Ask me for feedback"). */
  surveysEnabled: boolean;
  challengesByStatus: Record<string, number>;
  solutionsByStatus: Record<string, number>;
  likesReceived: number;
  following: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
  recentActivity: { type: "challenge" | "solution"; number: string; challengeNumber: string; label: string; status: string; at: string }[];
}

/** The owner's "items I follow" reads, visibility-filtered in SQL before the limit (invariant 2). */
function followedQueries(pool: Pool, viewer: Viewer) {
  const challengeParams: unknown[] = [viewer.userId];
  const challengePush = (v: unknown) => {
    challengeParams.push(v);
    return `$${challengeParams.length}`;
  };
  const challengeConditions = [`f.user_id = $1`, `f.parent_type = 'challenge'`];
  pushChallengeVisibilityConditions(viewer, challengePush, challengeConditions);

  const solutionParams: unknown[] = [viewer.userId];
  const solutionPush = (v: unknown) => {
    solutionParams.push(v);
    return `$${solutionParams.length}`;
  };
  const solutionConditions = [`f.user_id = $1`, `f.parent_type = 'solution'`];
  pushChallengeVisibilityConditions(viewer, solutionPush, solutionConditions);
  pushSolutionVisibilityConditions(viewer, solutionPush, solutionConditions);

  return [
    pool.query<{ number: string; title: string; status: string }>(
      `select c.number::text, c.title, c.status
         from follows f join challenges c on c.id = f.parent_id
        where ${challengeConditions.join(" and ")}
        order by f.created_at desc limit 50`,
      challengeParams,
    ),
    pool.query<{ number: string; description: string; status: string; challenge_number: string }>(
      `select s.number::text, s.description, s.status, c.number::text as challenge_number
         from follows f join solutions s on s.id = f.parent_id join challenges c on c.id = s.challenge_id
        where ${solutionConditions.join(" and ")}
        order by f.created_at desc limit 50`,
      solutionParams,
    ),
  ] as const;
}

export async function getOwnProfile(pool: Pool, viewer: Viewer): Promise<OwnProfile | null> {
  const userId = viewer.userId;
  const { rows: userRows } = await pool.query<{
    id: string;
    display_name: string;
    email: string | null;
    department: string | null;
    job_title: string | null;
    office_location: string | null;
    email_notifications_enabled: boolean;
    notify_followed_comments: boolean;
    notify_followed_status: boolean;
    notify_followed_solutions: boolean;
    surveys_enabled: boolean;
  }>(
    `select id, display_name, email, department, job_title, office_location, email_notifications_enabled,
            notify_followed_comments, notify_followed_status, notify_followed_solutions, surveys_enabled
       from users where id = $1`,
    [userId],
  );
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
      ...followedQueries(pool, viewer),
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
    notificationPreferences: {
      followedComments: userRow.notify_followed_comments,
      followedStatus: userRow.notify_followed_status,
      followedSolutions: userRow.notify_followed_solutions,
    },
    surveysEnabled: userRow.surveys_enabled,
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

/** §12.1: writes any subset of the three per-event toggles. Silent (not audited, like the e-mail
 *  switch) and forward-only — nothing already delivered is deleted, nothing missed is replayed. */
export async function setNotificationPreferences(pool: Pool, userId: string, prefs: Partial<NotificationPreferences>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  for (const key of NOTIFICATION_PREFERENCES) {
    const v = prefs[key];
    if (typeof v !== "boolean") continue;
    params.push(v);
    sets.push(`${NOTIFICATION_PREFERENCE_COLUMN[key]} = $${params.length}`); // column from the fixed map
  }
  if (sets.length === 0) return;
  await pool.query(`update users set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
}

export interface PublicProfile {
  user: {
    id: string;
    displayName: string;
    department: string | null;
    jobTitle: string | null;
    officeLocation: string | null;
    /** §13.5/§13.6: false for a deactivated user — the page still renders, with the greyed
     *  bubble and a muted "Deactivated" notice. */
    active: boolean;
    /** Always false here: a scrubbed user has no public profile (null, a 404). Carried so the
     *  profile is a person payload like every other (§13.6). */
    scrubbed: false;
  };
  contributions: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
}

/** Non-anonymous, org-visible contributions only (§13.5, invariants 2-3) — this is what any
 *  authenticated viewer may see about another user, regardless of their own roles. A
 *  deactivated user's profile still renders (so the §13.8 card's "View profile" link always
 *  lands somewhere); only an unknown id or a GDPR-scrubbed row is null — the same not-found. */
export async function getPublicProfile(pool: Pool, userId: string): Promise<PublicProfile | null> {
  const { rows: userRows } = await pool.query<{
    id: string;
    display_name: string;
    department: string | null;
    job_title: string | null;
    office_location: string | null;
    active: boolean;
    scrubbed: boolean;
  }>(
    `select id, display_name, department, job_title, office_location, active, scrubbed_at is not null as scrubbed
       from users where id = $1`,
    [userId],
  );
  const userRow = userRows[0];
  if (!userRow || userRow.scrubbed) return null;

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
          -- §13.5: a solution inherits its parent challenge's visibility (§4.3), so the parent
          -- must pass the same public test as a listed challenge.
          and c.status not in ('awaiting_triage', 'withdrawn')
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
      active: userRow.active,
      scrubbed: false,
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
