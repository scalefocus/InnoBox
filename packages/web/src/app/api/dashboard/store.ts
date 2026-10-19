// Data layer for /api/dashboard (INNOBOX_SPEC.md §13.2): visibility-filtered KPI tiles and
// spotlight cards for the Home page. Every query applies the full §4.3 predicate per viewer —
// the shared SQL twins of canSeeChallenge (namespace rule AND state rule) and, for the solution
// KPIs and spotlights, canSeeSolution. The solution statuses counted here are never
// awaiting_triage/withdrawn themselves, but their PARENT challenge can be (withdrawn, or moved
// back to awaiting_triage by an admin), and such a solution must neither count nor surface its
// challenge's title to a viewer who cannot see that challenge (invariant 2).
import type { Pool } from "pg";
import { formatChallengeNumber, formatSolutionNumber, maskAuthor, type ChallengeStatus, type MaskedAuthor, type SolutionStatus } from "@innobox/shared";
import {
  pushChallengeVisibilityConditions,
  pushSolutionVisibilityConditions,
  type ChallengeListItem,
  type Viewer,
} from "../challenges/store";
import { listFeaturedForViewer } from "../challenges/featured";
import { getHypeEnabled } from "../../../lib/hype-settings";
import { getHypedBoard, withHypePoints, type HypedBoard } from "../hypes/store";

export const CHALLENGE_KPI_STATUSES: ChallengeStatus[] = ["in_review", "valid", "solved", "rejected"];
export const SOLUTION_KPI_STATUSES: SolutionStatus[] = ["in_review", "valid", "in_implementation", "implemented"];

export interface DashboardKpis {
  challenges: Record<string, number>;
  solutions: Record<string, number>;
}

export interface SpotlightSolution {
  number: string;
  description: string;
  author: MaskedAuthor;
  challengeNumber: string;
  challengeTitle: string;
  updatedAt: string;
}

export interface DashboardData {
  /** §13.2 Featured: the viewer's VISIBLE pins only, newest first (empty → no section). Each card
   *  carries `hype` while hype is on (§26.5). */
  featured: (ChallengeListItem & { hype?: number })[];
  /** §26.5 "Hyped this week" — null while hype is off. */
  hyped: HypedBoard | null;
  kpis: DashboardKpis;
  spotlights: {
    lastImplemented: SpotlightSolution | null;
    lastInImplementation: SpotlightSolution | null;
  };
}

/** A fresh parameter list plus its `$N` pusher, for one query. */
function queryParams(): { params: unknown[]; push: (v: unknown) => string } {
  const params: unknown[] = [];
  return {
    params,
    push: (v) => {
      params.push(v);
      return `$${params.length}`;
    },
  };
}

/** The §4.3 conditions for a `solutions s join challenges c` read: the parent challenge's gate
 *  plus the solution's own `proposed` narrowing (`true` for platform admins). */
function solutionVisibility(viewer: Viewer, push: (v: unknown) => string): string {
  const conditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  pushSolutionVisibilityConditions(viewer, push, conditions);
  return conditions.length > 0 ? conditions.join(" and ") : "true";
}

export async function getDashboard(pool: Pool, viewer: Viewer): Promise<DashboardData> {
  const challengeQuery = queryParams();
  const challengeConditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, challengeQuery.push, challengeConditions);
  challengeConditions.push(`c.status = ANY(${challengeQuery.push(CHALLENGE_KPI_STATUSES)})`);
  const { rows: challengeRows } = await pool.query<{ status: string; count: string }>(
    `select c.status, count(*)::text as count
       from challenges c
      where ${challengeConditions.join(" and ")}
      group by c.status`,
    challengeQuery.params,
  );

  const solutionQuery = queryParams();
  const solutionVisible = solutionVisibility(viewer, solutionQuery.push);
  const { rows: solutionRows } = await pool.query<{ status: string; count: string }>(
    `select s.status, count(*)::text as count
       from solutions s
       join challenges c on c.id = s.challenge_id
      where ${solutionVisible} and s.status = ANY(${solutionQuery.push(SOLUTION_KPI_STATUSES)})
      group by s.status`,
    solutionQuery.params,
  );

  const challenges: Record<string, number> = Object.fromEntries(CHALLENGE_KPI_STATUSES.map((s) => [s, 0]));
  for (const row of challengeRows) challenges[row.status] = Number(row.count);
  const solutions: Record<string, number> = Object.fromEntries(SOLUTION_KPI_STATUSES.map((s) => [s, 0]));
  for (const row of solutionRows) solutions[row.status] = Number(row.count);

  const spotlight = async (status: SolutionStatus): Promise<SpotlightSolution | null> => {
    const { params, push } = queryParams();
    const visible = solutionVisibility(viewer, push);
    const { rows } = await pool.query<{
      number: string;
      description: string;
      is_anonymous: boolean;
      author_id: string;
      author_display_name: string;
      author_active: boolean;
      author_scrubbed: boolean;
      challenge_number: string;
      challenge_title: string;
      updated_at: Date;
    }>(
      `select s.number::text, s.description, s.is_anonymous, s.author_id, u.display_name as author_display_name,
              u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
              c.number::text as challenge_number, c.title as challenge_title, s.updated_at
         from solutions s
         join challenges c on c.id = s.challenge_id
         join users u on u.id = s.author_id
        where ${visible} and s.status = ${push(status)}
        order by s.updated_at desc
        limit 1`,
      params,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      number: formatSolutionNumber(row.number),
      description: row.description,
      author: maskAuthor({
        isAnonymous: row.is_anonymous,
        authorId: row.author_id,
        authorDisplayName: row.author_display_name,
        authorActive: row.author_active,
        authorScrubbed: row.author_scrubbed,
      }),
      challengeNumber: formatChallengeNumber(row.challenge_number),
      challengeTitle: row.challenge_title,
      updatedAt: row.updated_at.toISOString(),
    };
  };

  const [lastImplemented, lastInImplementation, pins, hypeOn] = await Promise.all([
    spotlight("implemented"),
    spotlight("in_implementation"),
    listFeaturedForViewer(pool, viewer),
    getHypeEnabled(pool),
  ]);
  const [featured, hyped] = hypeOn ? await Promise.all([withHypePoints(pool, pins), getHypedBoard(pool, viewer)]) : [pins, null];

  return { featured, hyped, kpis: { challenges, solutions }, spotlights: { lastImplemented, lastInImplementation } };
}
