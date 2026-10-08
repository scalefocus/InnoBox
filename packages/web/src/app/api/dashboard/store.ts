// Data layer for /api/dashboard (INNOBOX_SPEC.md §13.2): visibility-filtered KPI tiles and
// spotlight cards for the Home page. Mirrors challenges/store.ts's visibility pattern (skip
// the namespace restriction entirely for platform admins; otherwise org-visible or member
// namespaces only) — none of the KPI/spotlight statuses fall in the awaiting_triage/withdrawn
// special-hidden set, so no extra author/admin carve-out is needed here.
import type { Pool } from "pg";
import { formatChallengeNumber, formatSolutionNumber, maskAuthor, type ChallengeStatus, type MaskedAuthor, type SolutionStatus } from "@innobox/shared";
import type { Viewer } from "../challenges/store";

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
  kpis: DashboardKpis;
  spotlights: {
    lastImplemented: SpotlightSolution | null;
    lastInImplementation: SpotlightSolution | null;
  };
}

/** Builds the `visibility = 'org' or namespace_id = ANY(...)` clause for a viewer, or no
 *  restriction at all for platform admins (who see every namespace). Returns the clause
 *  text (referencing `$N`) and appends the param when needed. */
function visibilityClause(viewer: Viewer, params: unknown[], namespaceColumn: string): string {
  if (viewer.roles.isPlatformAdmin) return "true";
  params.push(viewer.roles.memberNamespaces());
  return `(${namespaceColumn}.visibility = 'org' or ${namespaceColumn}.namespace_id = ANY($${params.length}::uuid[]))`;
}

export async function getDashboard(pool: Pool, viewer: Viewer): Promise<DashboardData> {
  const challengeParams: unknown[] = [];
  const challengeVisibility = visibilityClause(viewer, challengeParams, "c");
  challengeParams.push(CHALLENGE_KPI_STATUSES);
  const { rows: challengeRows } = await pool.query<{ status: string; count: string }>(
    `select status, count(*)::text as count
       from challenges c
      where ${challengeVisibility} and status = ANY($${challengeParams.length})
      group by status`,
    challengeParams,
  );

  const solutionParams: unknown[] = [];
  const solutionVisibility = visibilityClause(viewer, solutionParams, "c");
  solutionParams.push(SOLUTION_KPI_STATUSES);
  const { rows: solutionRows } = await pool.query<{ status: string; count: string }>(
    `select s.status, count(*)::text as count
       from solutions s
       join challenges c on c.id = s.challenge_id
      where ${solutionVisibility} and s.status = ANY($${solutionParams.length})
      group by s.status`,
    solutionParams,
  );

  const challenges: Record<string, number> = Object.fromEntries(CHALLENGE_KPI_STATUSES.map((s) => [s, 0]));
  for (const row of challengeRows) challenges[row.status] = Number(row.count);
  const solutions: Record<string, number> = Object.fromEntries(SOLUTION_KPI_STATUSES.map((s) => [s, 0]));
  for (const row of solutionRows) solutions[row.status] = Number(row.count);

  const spotlight = async (status: SolutionStatus): Promise<SpotlightSolution | null> => {
    const params: unknown[] = [];
    const visibility = visibilityClause(viewer, params, "c");
    params.push(status);
    const { rows } = await pool.query<{
      number: string;
      description: string;
      is_anonymous: boolean;
      author_id: string;
      author_display_name: string;
      challenge_number: string;
      challenge_title: string;
      updated_at: Date;
    }>(
      `select s.number::text, s.description, s.is_anonymous, s.author_id, u.display_name as author_display_name,
              c.number::text as challenge_number, c.title as challenge_title, s.updated_at
         from solutions s
         join challenges c on c.id = s.challenge_id
         join users u on u.id = s.author_id
        where ${visibility} and s.status = $${params.length}
        order by s.updated_at desc
        limit 1`,
      params,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      number: formatSolutionNumber(row.number),
      description: row.description,
      author: maskAuthor({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name }),
      challengeNumber: formatChallengeNumber(row.challenge_number),
      challengeTitle: row.challenge_title,
      updatedAt: row.updated_at.toISOString(),
    };
  };

  const [lastImplemented, lastInImplementation] = await Promise.all([
    spotlight("implemented"),
    spotlight("in_implementation"),
  ]);

  return { kpis: { challenges, solutions }, spotlights: { lastImplemented, lastInImplementation } };
}
