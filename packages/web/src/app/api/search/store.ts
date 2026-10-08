// Data layer for /api/search (INNOBOX_SPEC.md §13.4): Postgres tsvector full-text search
// over challenge title/description/client_name and solution description/cost_vs_benefits
// (migration 0008), plus exact CH-<n>/SOL-<n> number lookup. Strictly visibility-filtered
// (invariant 2) and anonymity-masked (invariant 3) — candidates come back ranked from
// Postgres, then the exact same canSeeChallenge/canSeeSolution gates used everywhere else
// decide what the viewer is actually allowed to see, so there is no second, divergent
// visibility implementation to drift out of sync.
import type { Pool } from "pg";
import {
  canSeeChallenge,
  canSeeSolution,
  formatChallengeNumber,
  formatSolutionNumber,
  maskAuthor,
  type ChallengeStatus,
  type MaskedAuthor,
  type SolutionStatus,
} from "@innobox/shared";
import { getChallengeByNumber, type Viewer } from "../challenges/store";

export interface ChallengeSearchResult {
  number: string;
  title: string;
  author: MaskedAuthor;
  status: string;
  namespaceSlug: string;
}

export interface SolutionSearchResult {
  number: string;
  description: string;
  author: MaskedAuthor;
  status: string;
  challengeNumber: string;
  challengeTitle: string;
}

export interface SearchResults {
  challenges: ChallengeSearchResult[];
  solutions: SolutionSearchResult[];
}

const CHALLENGE_NUMBER_RE = /^ch-?\s*(\d+)$/i;
const SOLUTION_NUMBER_RE = /^sol-?\s*(\d+)$/i;

const CANDIDATE_LIMIT = 50;
const RESULT_LIMIT = 20;

export async function search(pool: Pool, viewer: Viewer, rawQuery: string): Promise<SearchResults> {
  const query = rawQuery.trim();

  const chNumberMatch = query.match(CHALLENGE_NUMBER_RE);
  if (chNumberMatch) {
    const detail = await getChallengeByNumber(pool, viewer, chNumberMatch[1]!);
    if (!detail) return { challenges: [], solutions: [] };
    return {
      challenges: [{ number: detail.number, title: detail.title, author: detail.author, status: detail.status, namespaceSlug: detail.namespaceSlug }],
      solutions: [],
    };
  }

  const solNumberMatch = query.match(SOLUTION_NUMBER_RE);
  if (solNumberMatch) {
    const { rows } = await pool.query<{
      number: string;
      description: string;
      status: string;
      is_anonymous: boolean;
      author_id: string;
      author_display_name: string;
      namespace_id: string;
      visibility: "org" | "namespace";
      challenge_status: string;
      challenge_author_id: string;
      assignee_id: string | null;
      challenge_number: string;
      challenge_title: string;
    }>(
      `select s.number::text, s.description, s.status, s.is_anonymous, s.author_id, u.display_name as author_display_name,
              c.namespace_id, c.visibility, c.status as challenge_status, c.author_id as challenge_author_id, c.assignee_id,
              c.number::text as challenge_number, c.title as challenge_title
         from solutions s
         join users u on u.id = s.author_id
         join challenges c on c.id = s.challenge_id
        where s.number = $1`,
      [solNumberMatch[1]!],
    );
    const row = rows[0];
    if (!row) return { challenges: [], solutions: [] };
    const challengeVisible = canSeeChallenge(viewer, {
      namespaceId: row.namespace_id,
      visibility: row.visibility,
      status: row.challenge_status as ChallengeStatus,
      authorId: row.challenge_author_id,
    });
    const solutionVisible =
      challengeVisible &&
      canSeeSolution(
        viewer,
        { namespaceId: row.namespace_id, assigneeId: row.assignee_id },
        { status: row.status as SolutionStatus, authorId: row.author_id },
      );
    if (!solutionVisible) return { challenges: [], solutions: [] };
    return {
      challenges: [],
      solutions: [
        {
          number: formatSolutionNumber(row.number),
          description: row.description,
          author: maskAuthor({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name }),
          status: row.status,
          challengeNumber: formatChallengeNumber(row.challenge_number),
          challengeTitle: row.challenge_title,
        },
      ],
    };
  }

  if (query === "") return { challenges: [], solutions: [] };

  const [challengeCandidates, solutionCandidates] = await Promise.all([
    pool.query<{
      number: string;
      title: string;
      status: string;
      is_anonymous: boolean;
      author_id: string;
      author_display_name: string;
      namespace_id: string;
      visibility: "org" | "namespace";
      namespace_slug: string;
    }>(
      `select c.number::text, c.title, c.status, c.is_anonymous, c.author_id, u.display_name as author_display_name,
              c.namespace_id, c.visibility, ns.slug as namespace_slug
         from challenges c
         join users u on u.id = c.author_id
         join namespaces ns on ns.id = c.namespace_id
        where c.search_vector @@ plainto_tsquery('english', $1)
        order by ts_rank(c.search_vector, plainto_tsquery('english', $1)) desc
        limit ${CANDIDATE_LIMIT}`,
      [query],
    ),
    pool.query<{
      number: string;
      description: string;
      status: string;
      is_anonymous: boolean;
      author_id: string;
      author_display_name: string;
      namespace_id: string;
      visibility: "org" | "namespace";
      challenge_status: string;
      challenge_author_id: string;
      assignee_id: string | null;
      challenge_number: string;
      challenge_title: string;
    }>(
      `select s.number::text, s.description, s.status, s.is_anonymous, s.author_id, u.display_name as author_display_name,
              c.namespace_id, c.visibility, c.status as challenge_status, c.author_id as challenge_author_id, c.assignee_id,
              c.number::text as challenge_number, c.title as challenge_title
         from solutions s
         join users u on u.id = s.author_id
         join challenges c on c.id = s.challenge_id
        where s.search_vector @@ plainto_tsquery('english', $1)
        order by ts_rank(s.search_vector, plainto_tsquery('english', $1)) desc
        limit ${CANDIDATE_LIMIT}`,
      [query],
    ),
  ]);

  const challenges: ChallengeSearchResult[] = challengeCandidates.rows
    .filter((row) =>
      canSeeChallenge(viewer, {
        namespaceId: row.namespace_id,
        visibility: row.visibility,
        status: row.status as ChallengeStatus,
        authorId: row.author_id,
      }),
    )
    .slice(0, RESULT_LIMIT)
    .map((row) => ({
      number: formatChallengeNumber(row.number),
      title: row.title,
      author: maskAuthor({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name }),
      status: row.status,
      namespaceSlug: row.namespace_slug,
    }));

  const solutions: SolutionSearchResult[] = solutionCandidates.rows
    .filter((row) => {
      const challengeVisible = canSeeChallenge(viewer, {
        namespaceId: row.namespace_id,
        visibility: row.visibility,
        status: row.challenge_status as ChallengeStatus,
        authorId: row.challenge_author_id,
      });
      if (!challengeVisible) return false;
      return canSeeSolution(
        viewer,
        { namespaceId: row.namespace_id, assigneeId: row.assignee_id },
        { status: row.status as SolutionStatus, authorId: row.author_id },
      );
    })
    .slice(0, RESULT_LIMIT)
    .map((row) => ({
      number: formatSolutionNumber(row.number),
      description: row.description,
      author: maskAuthor({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name }),
      status: row.status,
      challengeNumber: formatChallengeNumber(row.challenge_number),
      challengeTitle: row.challenge_title,
    }));

  return { challenges, solutions };
}
