// Data layer for GET /api/implementation-board (INNOBOX_SPEC.md §46). One read: the five columns of
// solutions from `accepted_internally` to `implemented` that the viewer can see, under a challenge
// that is `valid` or `solved`, an implemented one for 90 days (§46.2) — each column with its per-viewer
// count and its first 100 cards in the column's order — plus the Namespace filter's options, worked out
// before any filter (§46.5). Cards, counts and options all come from one `where` clause built from the
// two shared SQL forms of §4.3 (challenge and solution, each with its trash rule), so a new filter
// cannot forget either (invariant 2). Authors are masked by the shared code (invariant 3); `moves` and
// `moveMode` are worked out per viewer and seen by nobody else. Imports stay relative so the gated
// dbtest can run under the plain node test runner.
import type { Pool } from "pg";
import {
  IMPLEMENTATION_BOARD_COLUMNS,
  IMPLEMENTATION_BOARD_COLUMN_MAX,
  IMPLEMENTATION_BOARD_WINDOW_DAYS,
  boardMoves,
  compareBoardCards,
  formatChallengeNumber,
  formatSolutionNumber,
  isChallengeMemberSql,
  isReviewEnforcer,
  isSolutionMemberSql,
  maskAuthor,
  maskTeam,
  solutionAuthorIdsSql,
  solutionTeamJsonSql,
  type BoardColumn,
  type BoardFilters,
  type BoardMoveMode,
  type ChallengeStatus,
  type MaskedAuthor,
  type TeamAuthor,
  type TeamMemberRow,
  type TopicRef,
} from "@innobox/shared";
import {
  pushChallengeVisibilityConditions,
  pushSolutionVisibilityConditions,
  pushTopicFilter,
  reviewRoles,
  type Viewer,
} from "../challenges/store";
import { getHypeEnabled } from "../../../lib/hype-settings";

export interface BoardCard {
  /** `SOL-<n>`. */
  number: string;
  status: BoardColumn;
  /** UTC ISO — the start of the time in stage, the column's order and the 90 days (§46.2). */
  statusChangedAt: string;
  /** The first member of the solution's team (§39.7), masked. */
  author: MaskedAuthor;
  authors: TeamAuthor[];
  /** The solution's own like count (§46.4). */
  likeCount: number;
  /** The solution's own all-time hype number — present only while hype is on (§26.8). */
  hype?: number;
  /** §46.6: the columns this viewer may move the card to, in board order — usually empty. */
  moves: BoardColumn[];
  /** §46.6: present only with a non-empty `moves` — serves the first-use report alone. */
  moveMode?: BoardMoveMode;
  challengeNumber: string;
  challengeTitle: string;
  challengeStatus: ChallengeStatus;
  namespaceSlug: string;
  impactAreaName: string;
  topics: TopicRef[];
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  assigneeActive: boolean | null;
  assigneeScrubbed: boolean | null;
}

export interface BoardColumnData {
  status: BoardColumn;
  /** The whole column's count for this viewer under the filters — never capped. */
  total: number;
  /** Its first 100 cards, in the column's order. */
  cards: BoardCard[];
}

export interface ImplementationBoard {
  columns: BoardColumnData[];
  /** §46.5: the namespaces with at least one card on the viewer's unfiltered board, by slug. */
  namespaces: { id: string; slug: string }[];
}

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

/** §46.2 rules 1–5 and §4.3 for this viewer — the board's one `where` clause, before any filter. */
function boardConditions(viewer: Viewer, push: (v: unknown) => string): string[] {
  const conditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  pushSolutionVisibilityConditions(viewer, push, conditions);
  conditions.push(`s.status = ANY(${push([...IMPLEMENTATION_BOARD_COLUMNS])}::text[])`);
  conditions.push(`c.status IN ('valid', 'solved')`);
  conditions.push(`(s.status <> 'implemented' OR s.status_changed_at > now() - make_interval(days => ${push(IMPLEMENTATION_BOARD_WINDOW_DAYS)}::int))`);
  return conditions;
}

/** §46.5: every filter narrows, and they combine with `and`. No id is checked against its table: a
 *  well-formed id that matches nothing gives empty columns (invariant 2). */
function pushFilters(viewer: Viewer, filters: BoardFilters, push: (v: unknown) => string, conditions: string[]): void {
  if (filters.namespaceId) conditions.push(`c.namespace_id = ${push(filters.namespaceId)}`);
  if (filters.impactAreaId) conditions.push(`c.impact_area_id = ${push(filters.impactAreaId)}`);
  pushTopicFilter({ topicId: filters.topicId }, push, conditions);
  if (filters.involving) {
    const me = push(viewer.userId);
    conditions.push(`(${isSolutionMemberSql("s", me)} OR ${isChallengeMemberSql("c", me)} OR c.assignee_id = ${me})`);
  }
  if (filters.following) {
    const me = push(viewer.userId);
    conditions.push(
      `exists (select 1 from follows f where f.user_id = ${me}
                 and ((f.parent_type = 'solution' and f.parent_id = s.id) or (f.parent_type = 'challenge' and f.parent_id = c.id)))`,
    );
  }
}

interface BoardRow {
  id: string;
  number: string;
  status: BoardColumn;
  status_changed_at: Date;
  is_anonymous: boolean;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  author_scrubbed: boolean;
  team: TeamMemberRow[];
  author_ids: string[];
  like_count: string;
  challenge_number: string;
  challenge_title: string;
  challenge_status: ChallengeStatus;
  namespace_id: string;
  namespace_slug: string;
  impact_area_name: string;
  topics: TopicRef[];
  assignee_id: string | null;
  assignee_display_name: string | null;
  assignee_active: boolean | null;
  assignee_scrubbed: boolean | null;
  total: string;
}

export async function getImplementationBoard(pool: Pool, viewer: Viewer, filters: BoardFilters): Promise<ImplementationBoard> {
  const cardsQuery = queryParams();
  const conditions = boardConditions(viewer, cardsQuery.push);
  pushFilters(viewer, filters, cardsQuery.push, conditions);
  const cap = cardsQuery.push(IMPLEMENTATION_BOARD_COLUMN_MAX);
  // §46.2 order: in progress — oldest change first, then the lower number; Implemented — newest
  // first, then the higher number. Counted and ranked per column, then capped.
  const { rows } = await pool.query<BoardRow>(
    `select * from (
       select s.id, s.number::text, s.status, s.status_changed_at, s.is_anonymous, s.author_id,
              u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
              ${solutionTeamJsonSql("s")} as team, ${solutionAuthorIdsSql("s")} as author_ids,
              (select count(*) from likes l where l.parent_type = 'solution' and l.parent_id = s.id) as like_count,
              c.number::text as challenge_number, c.title as challenge_title, c.status as challenge_status,
              c.namespace_id, ns.slug as namespace_slug, ia.name as impact_area_name,
              (select coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'active', t.active) order by lower(t.name)), '[]'::json)
                 from challenge_topics ct join topics t on t.id = ct.topic_id where ct.challenge_id = c.id) as topics,
              c.assignee_id, au.display_name as assignee_display_name, au.active as assignee_active,
              au.scrubbed_at is not null as assignee_scrubbed,
              count(*) over (partition by s.status) as total,
              row_number() over (
                partition by s.status
                order by case when s.status = 'implemented' then null else s.status_changed_at end asc,
                         case when s.status = 'implemented' then s.status_changed_at end desc,
                         case when s.status = 'implemented' then -s.number else s.number end asc
              ) as rank_in_column
         from solutions s
         join challenges c on c.id = s.challenge_id
         join users u on u.id = s.author_id
         join namespaces ns on ns.id = c.namespace_id
         join impact_areas ia on ia.id = c.impact_area_id
         left join users au on au.id = c.assignee_id
        where ${conditions.join(" and ")}
     ) ranked
     where rank_in_column <= ${cap}`,
    cardsQuery.params,
  );

  const hypeOn = await getHypeEnabled(pool);
  const hype = hypeOn ? await solutionHypePoints(pool, rows.map((r) => r.id)) : null;

  const columns: BoardColumnData[] = IMPLEMENTATION_BOARD_COLUMNS.map((status) => {
    const inColumn = rows.filter((r) => r.status === status);
    const cards = inColumn
      .map((r) => toCard(viewer, r, hype))
      .sort((a, b) => compareBoardCards({ ...a, number: a.number }, { ...b, number: b.number }));
    return { status, total: inColumn[0] ? Number(inColumn[0].total) : 0, cards };
  });

  return { columns, namespaces: await boardNamespaces(pool, viewer) };
}

/** §46.5: the Namespace options — the viewer's unfiltered board's namespaces, alphabetical by slug.
 *  The same `where` clause as the cards, so it names nothing the cards do not already show. */
async function boardNamespaces(pool: Pool, viewer: Viewer): Promise<{ id: string; slug: string }[]> {
  const q = queryParams();
  const conditions = boardConditions(viewer, q.push);
  const { rows } = await pool.query<{ id: string; slug: string }>(
    `select distinct ns.id, ns.slug
       from solutions s
       join challenges c on c.id = s.challenge_id
       join namespaces ns on ns.id = c.namespace_id
      where ${conditions.join(" and ")}
      order by ns.slug`,
    q.params,
  );
  return rows;
}

/** The solution's own all-time hype number (§26.4) — for the cards only, while hype is on. */
async function solutionHypePoints(pool: Pool, solutionIds: string[]): Promise<Map<string, number>> {
  if (solutionIds.length === 0) return new Map();
  const { rows } = await pool.query<{ parent_id: string; points: number }>(
    `select parent_id, sum(weight)::int as points from hypes where parent_type = 'solution' and parent_id = any($1::uuid[]) group by parent_id`,
    [solutionIds],
  );
  return new Map(rows.map((r) => [r.parent_id, r.points]));
}

function toCard(viewer: Viewer, r: BoardRow, hype: Map<string, number> | null): BoardCard {
  const authors = maskTeam(
    maskAuthor({
      isAnonymous: r.is_anonymous,
      authorId: r.author_id,
      authorDisplayName: r.author_display_name,
      authorActive: r.author_active,
      authorScrubbed: r.author_scrubbed,
    }),
    r.team ?? [],
  );
  // §46.6: the moves are the detail page's rule — an admin of the challenge's namespace (or a platform
  // admin) overrides; a committee member who is not an author of the solution, or the challenge's
  // assignee, takes the §8.2 arrows; nobody else moves anything.
  const roles = reviewRoles(viewer, r.namespace_id, r.assignee_id, r.author_ids ?? []);
  const { moves, mode } = boardMoves({
    status: r.status,
    isAdmin: viewer.roles.isNamespaceAdmin(r.namespace_id),
    isEnforcer: isReviewEnforcer(roles),
  });
  const card: BoardCard = {
    number: formatSolutionNumber(r.number),
    status: r.status,
    statusChangedAt: r.status_changed_at.toISOString(),
    author: authors[0]!,
    authors,
    likeCount: Number(r.like_count),
    moves,
    challengeNumber: formatChallengeNumber(r.challenge_number),
    challengeTitle: r.challenge_title,
    challengeStatus: r.challenge_status,
    namespaceSlug: r.namespace_slug,
    impactAreaName: r.impact_area_name,
    topics: r.topics ?? [],
    assigneeId: r.assignee_id,
    assigneeDisplayName: r.assignee_display_name,
    assigneeActive: r.assignee_active,
    assigneeScrubbed: r.assignee_scrubbed,
  };
  if (hype) card.hype = hype.get(r.id) ?? 0;
  if (mode) card.moveMode = mode;
  return card;
}
