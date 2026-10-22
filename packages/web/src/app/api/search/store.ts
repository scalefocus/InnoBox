// Data layer for /api/search (INNOBOX_SPEC.md §13.4): Postgres tsvector full-text search
// over challenge title/description/client_name and solution description/cost_vs_benefits
// (migration 0008), plus exact CH-<n>/SOL-<n> number lookup. Strictly visibility-filtered
// (invariant 2) and anonymity-masked (invariant 3) — candidates are narrowed in SQL by the same
// §4.3 predicates the gallery uses (the challenge gate, plus the solution's own `proposed` rule),
// BEFORE the candidate limit, so items the viewer cannot see never displace ones they can. The
// JS canSeeChallenge/canSeeSolution gates then re-check every row as defence in depth.
//
// §13.1's gallery filters (status / impact area / namespace / author) narrow the results
// alongside the query. They are the CHALLENGE gallery's filters, so for a solution hit the
// status, impact-area and namespace filters apply to its parent challenge, while the author
// filter applies to the solution's own (named) authors — any member of its team (§39.12). The
// author filter is anonymity-safe the
// same way the gallery's is: whenever it is set, anonymous items are excluded outright rather
// than matched against their true author, so it can never distinguish "no match" from "hidden
// because anonymous" — for anyone, revealers included (the audited reveal is the only path to
// an anonymous author's identity, §9).
import type { Pool } from "pg";
import {
  canSeeChallenge,
  canSeeSolution,
  challengeAuthorIdsSql,
  challengeTeamJsonSql,
  escapeLike,
  formatChallengeNumber,
  formatSolutionNumber,
  isChallengeMemberSql,
  maskAuthor,
  maskTeam,
  solutionTeamJsonSql,
  type ChallengeStatus,
  type ChallengeVisibility,
  type MaskedAuthor,
  type SolutionStatus,
  type TeamMemberRow,
  type TopicRef,
} from "@innobox/shared";
import {
  CHALLENGE_SELECT,
  pushChallengeVisibilityConditions,
  pushSolutionVisibilityConditions,
  pushTopicFilter,
  teamNameMatchSql,
  toListItem,
  type ChallengeListItem,
  type ChallengeRow,
  type Viewer,
} from "../challenges/store";
import { isEntityNumber, type GalleryFilters } from "../challenges/validation";

export interface ChallengeSearchResult {
  number: string;
  title: string;
  /** The first member of the team (§39.7). */
  author: MaskedAuthor;
  /** §39.7: every member in team order, masked — the compact form. */
  authors: MaskedAuthor[];
  status: string;
  namespaceSlug: string;
  /** §34.6: the challenge's topics, alphabetical. */
  topics: TopicRef[];
}

export interface SolutionSearchResult {
  number: string;
  description: string;
  /** The first member of the team (§39.7). */
  author: MaskedAuthor;
  /** §39.7: every member in team order, masked. */
  authors: MaskedAuthor[];
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
  // §34.6: a solution hit is filtered by its parent challenge's topics, as by its impact area.
  pushTopicFilter(filters, push, conditions);
  if (filters.namespaceId) conditions.push(`c.namespace_id = ${push(filters.namespaceId)}`);
}

/** The author filter over an item alias (`c` or `s`): any member of the team's name (§39.12).
 *  Anonymous items are excluded unconditionally while it is set (see the header). */
function pushAuthorCondition(filters: GalleryFilters, alias: "c" | "s", push: Push, conditions: string[]): void {
  if (!filters.authorName) return;
  // §2.4: the name is a literal substring — `%`, `_` and `\` match themselves.
  const pattern = push(`%${escapeLike(filters.authorName)}%`);
  conditions.push(`${alias}.is_anonymous = false and ${teamNameMatchSql(alias === "c" ? "challenge" : "solution", pattern)}`);
}

/** §39.7: an item's team, masked — the first entry is `author`. */
function teamOf(row: {
  is_anonymous: boolean;
  author_id: string | null;
  author_display_name: string | null;
  author_active: boolean | null;
  author_scrubbed: boolean | null;
  external_company?: string | null;
  team: TeamMemberRow[];
}): MaskedAuthor[] {
  return maskTeam(
    maskAuthor({
      isAnonymous: row.is_anonymous,
      authorId: row.author_id,
      authorDisplayName: row.author_display_name,
      authorActive: row.author_active,
      authorScrubbed: row.author_scrubbed,
      externalCompany: row.external_company ?? null,
    }),
    row.team ?? [],
  );
}

interface ChallengeCandidate {
  number: string;
  title: string;
  status: string;
  is_anonymous: boolean;
  /** Null for a challenge accepted from the public form (§24.6), with its author columns. */
  author_id: string | null;
  author_display_name: string | null;
  author_active: boolean | null;
  author_scrubbed: boolean | null;
  external_company: string | null;
  team: TeamMemberRow[];
  id: string;
  namespace_id: string;
  visibility: ChallengeVisibility;
  assignee_id: string | null;
  namespace_slug: string;
  topics: TopicRef[];
}

interface SolutionCandidate {
  number: string;
  description: string;
  status: string;
  is_anonymous: boolean;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  author_scrubbed: boolean;
  team: TeamMemberRow[];
  challenge_id: string;
  namespace_id: string;
  visibility: ChallengeVisibility;
  challenge_status: string;
  challenge_author_ids: string[];
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
            u.active as author_active, u.scrubbed_at is not null as author_scrubbed, ps.company as external_company,
            ${challengeTeamJsonSql("c")} as team,
            c.id, c.namespace_id, c.visibility, c.assignee_id, ns.slug as namespace_slug,
            (select coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'active', t.active) order by lower(t.name)), '[]'::json)
               from challenge_topics ct join topics t on t.id = ct.topic_id where ct.challenge_id = c.id) as topics
       from challenges c
       left join users u on u.id = c.author_id
       left join public_submissions ps on ps.id = c.public_submission_id
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
  // The parent challenge's §4.3 gate and the solution's own `proposed` narrowing, both in SQL so
  // they apply before the candidate limit.
  pushChallengeVisibilityConditions(viewer, push, conditions);
  pushSolutionVisibilityConditions(viewer, push, conditions);
  pushChallengeFilterConditions(filters, push, conditions);
  pushAuthorCondition(filters, "s", push, conditions);

  const { rows } = await pool.query<SolutionCandidate>(
    `select s.number::text, s.description, s.status, s.is_anonymous, s.author_id, u.display_name as author_display_name,
            u.active as author_active, u.scrubbed_at is not null as author_scrubbed, ${solutionTeamJsonSql("s")} as team,
            c.id as challenge_id, c.namespace_id, c.visibility, c.status as challenge_status,
            ${challengeAuthorIdsSql("c")} as challenge_author_ids, c.assignee_id,
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
        id: row.id,
        namespaceId: row.namespace_id,
        visibility: row.visibility,
        status: row.status as ChallengeStatus,
        authorIds: (row.team ?? []).map((m) => m.id),
        assigneeId: row.assignee_id,
        trashed: false, // §10.4: the SQL predicate already dropped trashed rows
      }),
    )
    .slice(0, RESULT_LIMIT)
    .map((row) => {
      const authors = teamOf(row);
      return {
        number: formatChallengeNumber(row.number),
        title: row.title,
        author: authors[0]!,
        authors,
        status: row.status,
        namespaceSlug: row.namespace_slug,
        topics: row.topics ?? [],
      };
    });
}

function toSolutionResults(viewer: Viewer, rows: SolutionCandidate[]): SolutionSearchResult[] {
  return rows
    .filter((row) => {
      const challengeVisible = canSeeChallenge(viewer, {
        id: row.challenge_id,
        namespaceId: row.namespace_id,
        visibility: row.visibility,
        status: row.challenge_status as ChallengeStatus,
        authorIds: row.challenge_author_ids,
        assigneeId: row.assignee_id,
        trashed: false, // §10.4: dropped in SQL
      });
      if (!challengeVisible) return false;
      return canSeeSolution(
        viewer,
        { namespaceId: row.namespace_id, assigneeId: row.assignee_id },
        { status: row.status as SolutionStatus, authorIds: (row.team ?? []).map((m) => m.id), trashed: false },
      );
    })
    .slice(0, RESULT_LIMIT)
    .map((row) => {
      const authors = teamOf(row);
      return {
        number: formatSolutionNumber(row.number),
        description: row.description,
        author: authors[0]!,
        authors,
        status: row.status,
        challengeNumber: formatChallengeNumber(row.challenge_number),
        challengeTitle: row.challenge_title,
      };
    });
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

// ── §25.6 search_challenges: paginated, challenges only ─────────────────────────────────

export interface ChallengeSearchPageInput {
  /** Free text (§13.4 full-text) or an exact `CH-<n>`; empty browses everything visible. */
  query: string;
  filters: GalleryFilters;
  /** The caller's own challenges only. */
  mine?: boolean;
  /** Only challenges the caller follows. */
  following?: boolean;
  limit: number;
  offset: number;
}

/**
 * The §13.4 search over challenges with the §13.1 filters, a page at a time and with the gallery's
 * list-item shape (counts included) — what the §25 `search_challenges` tool returns. Same
 * visibility predicate (and so the §25.5 restricted filter on an agent's viewer), same
 * anonymity-safe author filter, same masking. One extra row is read to say whether more exist.
 */
export async function searchChallengePage(pool: Pool, viewer: Viewer, input: ChallengeSearchPageInput): Promise<{ items: ChallengeListItem[]; hasMore: boolean }> {
  const params: unknown[] = [];
  const push: Push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const viewerParam = push(viewer.userId);
  const conditions: string[] = [];
  let orderBy = "c.created_at desc";
  const query = input.query.trim();
  const numberMatch = query.match(CHALLENGE_NUMBER_RE);
  if (numberMatch) {
    if (!isEntityNumber(numberMatch[1]!)) return { items: [], hasMore: false };
    conditions.push(`c.number = ${push(numberMatch[1])}`);
  } else if (query !== "") {
    const q = push(query);
    conditions.push(`c.search_vector @@ plainto_tsquery('english', ${q})`);
    orderBy = `ts_rank(c.search_vector, plainto_tsquery('english', ${q})) desc, c.created_at desc`;
  }
  pushChallengeVisibilityConditions(viewer, push, conditions);
  pushChallengeFilterConditions(input.filters, push, conditions);
  pushAuthorCondition(input.filters, "c", push, conditions);
  // §39.10: "mine" means "a member of".
  if (input.mine) conditions.push(isChallengeMemberSql("c", push(viewer.userId)));
  if (input.following) {
    conditions.push(`exists (select 1 from follows ff where ff.parent_type = 'challenge' and ff.parent_id = c.id and ff.user_id = ${push(viewer.userId)})`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await pool.query<ChallengeRow>(
    `${CHALLENGE_SELECT.replaceAll("$viewer", viewerParam)} ${where} order by ${orderBy} limit ${input.limit + 1} offset ${input.offset}`,
    params,
  );
  const visible = rows.filter((row) =>
    canSeeChallenge(viewer, {
      id: row.id,
      namespaceId: row.namespace_id,
      visibility: row.visibility,
      status: row.status as ChallengeStatus,
      authorIds: (row.team ?? []).map((m) => m.id),
      assigneeId: row.assignee_id,
      trashed: row.trashed_at !== null,
    }),
  );
  return { items: visible.slice(0, input.limit).map(toListItem), hasMore: rows.length > input.limit };
}
