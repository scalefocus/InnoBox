// Data layer for /api/search (INNOBOX_SPEC.md §13.4): Postgres tsvector full-text search
// over challenge title/description/client_name and solution description/cost_vs_benefits
// (migration 0008), plus exact CH-<n>/SOL-<n> number lookup. Strictly visibility-filtered
// (invariant 2) and anonymity-masked (invariant 3) — candidates are pre-narrowed in SQL by the
// same §4.3 predicate the gallery uses, then the exact same canSeeChallenge/canSeeSolution
// gates used everywhere else decide what the viewer is actually allowed to see, so there is no
// second, divergent visibility implementation to drift out of sync.
//
// §13.1's gallery filters (status / impact area / namespace / author) narrow the results
// alongside the query. They are the CHALLENGE gallery's filters, so for a solution hit the
// status, impact-area and namespace filters apply to its parent challenge, while the author
// filter applies to the solution's own (named) author. The author filter is anonymity-safe the
// same way the gallery's is: whenever it is set, anonymous items are excluded outright rather
// than matched against their true author, so it can never distinguish "no match" from "hidden
// because anonymous" — for anyone, revealers included (the audited reveal is the only path to
// an anonymous author's identity, §9).
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
import { pushChallengeVisibilityConditions, type Viewer } from "../challenges/store";
import { isEntityNumber, type GalleryFilters } from "../challenges/validation";

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

const EMPTY: SearchResults = { challenges: [], solutions: [] };

type Push = (v: unknown) => string;

/** The gallery filters that live on the challenge row (alias `c`) — for a solution hit, its parent. */
function pushChallengeFilterConditions(filters: GalleryFilters, push: Push, conditions: string[]): void {
  if (filters.status) conditions.push(`c.status = ${push(filters.status)}`);
  if (filters.impactAreaId) conditions.push(`c.impact_area_id = ${push(filters.impactAreaId)}`);
  if (filters.namespaceId) conditions.push(`c.namespace_id = ${push(filters.namespaceId)}`);
}

/** The author filter over an item alias (`c` or `s`) joined to its author as `u`. Anonymous
 *  items are excluded unconditionally while it is set (see the header). */
function pushAuthorCondition(filters: GalleryFilters, alias: "c" | "s", push: Push, conditions: string[]): void {
  if (!filters.authorName) return;
  conditions.push(`${alias}.is_anonymous = false and u.display_name ILIKE ${push(`%${filters.authorName}%`)}`);
}

interface ChallengeCandidate {
  number: string;
  title: string;
  status: string;
  is_anonymous: boolean;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  namespace_id: string;
  visibility: "org" | "namespace";
  namespace_slug: string;
}

interface SolutionCandidate {
  number: string;
  description: string;
  status: string;
  is_anonymous: boolean;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  namespace_id: string;
  visibility: "org" | "namespace";
  challenge_status: string;
  challenge_author_id: string;
  assignee_id: string | null;
  challenge_number: string;
  challenge_title: string;
}

/** `match` is either the exact number lookup or the full-text predicate. */
type Match = { kind: "number"; number: string } | { kind: "text"; query: string };

async function challengeCandidates(pool: Pool, viewer: Viewer, match: Match, filters: GalleryFilters): Promise<ChallengeCandidate[]> {
  const params: unknown[] = [];
  const push: Push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  let orderBy = "c.created_at desc";
  if (match.kind === "number") {
    conditions.push(`c.number = ${push(match.number)}`);
  } else {
    const q = push(match.query);
    conditions.push(`c.search_vector @@ plainto_tsquery('english', ${q})`);
    orderBy = `ts_rank(c.search_vector, plainto_tsquery('english', ${q})) desc`;
  }
  pushChallengeVisibilityConditions(viewer, push, conditions);
  pushChallengeFilterConditions(filters, push, conditions);
  pushAuthorCondition(filters, "c", push, conditions);

  const { rows } = await pool.query<ChallengeCandidate>(
    `select c.number::text, c.title, c.status, c.is_anonymous, c.author_id, u.display_name as author_display_name,
            u.active as author_active, c.namespace_id, c.visibility, ns.slug as namespace_slug
       from challenges c
       join users u on u.id = c.author_id
       join namespaces ns on ns.id = c.namespace_id
      where ${conditions.join(" and ")}
      order by ${orderBy}
      limit ${CANDIDATE_LIMIT}`,
    params,
  );
  return rows;
}

async function solutionCandidates(pool: Pool, viewer: Viewer, match: Match, filters: GalleryFilters): Promise<SolutionCandidate[]> {
  const params: unknown[] = [];
  const push: Push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  let orderBy = "s.created_at desc";
  if (match.kind === "number") {
    conditions.push(`s.number = ${push(match.number)}`);
  } else {
    const q = push(match.query);
    conditions.push(`s.search_vector @@ plainto_tsquery('english', ${q})`);
    orderBy = `ts_rank(s.search_vector, plainto_tsquery('english', ${q})) desc`;
  }
  // The parent challenge's §4.3 gate in SQL; the solution-level `proposed` narrowing runs in
  // canSeeSolution below.
  pushChallengeVisibilityConditions(viewer, push, conditions);
  pushChallengeFilterConditions(filters, push, conditions);
  pushAuthorCondition(filters, "s", push, conditions);

  const { rows } = await pool.query<SolutionCandidate>(
    `select s.number::text, s.description, s.status, s.is_anonymous, s.author_id, u.display_name as author_display_name,
            u.active as author_active, c.namespace_id, c.visibility, c.status as challenge_status,
            c.author_id as challenge_author_id, c.assignee_id,
            c.number::text as challenge_number, c.title as challenge_title
       from solutions s
       join users u on u.id = s.author_id
       join challenges c on c.id = s.challenge_id
      where ${conditions.join(" and ")}
      order by ${orderBy}
      limit ${CANDIDATE_LIMIT}`,
    params,
  );
  return rows;
}

function toChallengeResults(viewer: Viewer, rows: ChallengeCandidate[]): ChallengeSearchResult[] {
  return rows
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
      author: maskAuthor({
        isAnonymous: row.is_anonymous,
        authorId: row.author_id,
        authorDisplayName: row.author_display_name,
        authorActive: row.author_active,
      }),
      status: row.status,
      namespaceSlug: row.namespace_slug,
    }));
}

function toSolutionResults(viewer: Viewer, rows: SolutionCandidate[]): SolutionSearchResult[] {
  return rows
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
      author: maskAuthor({
        isAnonymous: row.is_anonymous,
        authorId: row.author_id,
        authorDisplayName: row.author_display_name,
        authorActive: row.author_active,
      }),
      status: row.status,
      challengeNumber: formatChallengeNumber(row.challenge_number),
      challengeTitle: row.challenge_title,
    }));
}

export async function search(pool: Pool, viewer: Viewer, rawQuery: string, filters: GalleryFilters = {}): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query === "") return EMPTY;

  // Exact number lookups — still narrowed by the filters, like every other result.
  const chNumberMatch = query.match(CHALLENGE_NUMBER_RE);
  if (chNumberMatch) {
    const number = chNumberMatch[1]!;
    if (!isEntityNumber(number)) return EMPTY; // §2.4: malformed → no match, no DB round-trip
    return { challenges: toChallengeResults(viewer, await challengeCandidates(pool, viewer, { kind: "number", number }, filters)), solutions: [] };
  }
  const solNumberMatch = query.match(SOLUTION_NUMBER_RE);
  if (solNumberMatch) {
    const number = solNumberMatch[1]!;
    if (!isEntityNumber(number)) return EMPTY;
    return { challenges: [], solutions: toSolutionResults(viewer, await solutionCandidates(pool, viewer, { kind: "number", number }, filters)) };
  }

  const match: Match = { kind: "text", query };
  const [challengeRows, solutionRows] = await Promise.all([
    challengeCandidates(pool, viewer, match, filters),
    solutionCandidates(pool, viewer, match, filters),
  ]);
  return { challenges: toChallengeResults(viewer, challengeRows), solutions: toSolutionResults(viewer, solutionRows) };
}
