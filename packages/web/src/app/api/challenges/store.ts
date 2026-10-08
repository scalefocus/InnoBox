// Data layer for challenges/solutions/likes (INNOBOX_SPEC.md §13.1 first slice). Visibility
// (§4.3, invariant 2) and anonymity masking (§9, invariant 3) are applied here, not left to
// the caller — every read path funnels through canSeeChallenge/canSeeSolution/maskAuthor so
// there is exactly one place that can get it wrong. Every write commits atomically with its
// audit row (§15). Imports stay relative (not @/) so the gated dbtest can run under the
// plain node test runner (mirrors packages/web/src/app/api/admin/store.ts).
import type { Pool, PoolClient } from "pg";
import {
  blocksAcceptedInternally,
  canAssignAtStatus,
  canAuthorEditChallenge,
  canAuthorEditSolution,
  canAuthorResubmit,
  canAuthorWithdrawChallenge,
  canAuthorWithdrawSolution,
  canSeeChallenge,
  canSeeSolution,
  challengeEnforcedTargets,
  decideTransition,
  formatChallengeNumber,
  formatSolutionNumber,
  isChallengeEnforcedTransition,
  isChallengeStatus,
  isSolutionEnforcedTransition,
  isSolutionStatus,
  maskAuthor,
  siblingsToAutoClose,
  solutionEnforcedTargets,
  validateChallengeFields,
  validateSolutionFields,
  type AttachmentView,
  type ChallengeStatus,
  type MaskedAuthor,
  type RoleSet,
  type SolutionStatus,
  type TransitionMode,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { isScanAvailable } from "../../../lib/clamav";
import { getAttachmentLimits } from "../admin/settings/store";
import { bindStagedAttachments, hasUncleanStagedAttachments, listAttachmentsForParent } from "../attachments/store";
import { isEntityNumber, isUuid, type ChallengeListFilters } from "./validation";

export interface Viewer {
  userId: string;
  roles: RoleSet;
}

export interface ChallengeListItem {
  id: string;
  number: string;
  title: string;
  author: MaskedAuthor;
  namespaceSlug: string;
  impactAreaName: string;
  status: ChallengeStatus;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  solutionCount: number;
  /** §13.1: created after the viewer last left the Challenges surface (and visible to them). */
  isNew: boolean;
}

export interface SolutionListItem {
  id: string;
  number: string;
  description: string;
  costVsBenefits: string | null;
  author: MaskedAuthor;
  isMine: boolean;
  status: SolutionStatus;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  canOverrideStatus: boolean;
  /** §7.2/§8.2 enforced transitions this viewer (committee/assignee, non-admin) may take from
   *  the current status. Empty for admins (they use the free-set override) and everyone else. */
  allowedTransitions: SolutionStatus[];
  /** §10.1 author actions available to this viewer on their own solution. */
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  /** §10.3 permanent delete — platform admins only, on any status. */
  canDelete: boolean;
  /** §11 attachments visible to this viewer (anonymity-safe; never carries uploaded_by). */
  attachments: AttachmentView[];
}

export interface ChallengeDetail extends ChallengeListItem {
  description: string;
  clientName: string | null;
  impactAreaId: string;
  visibility: "org" | "namespace";
  namespaceId: string;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  updatedAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  isMine: boolean;
  canPropose: boolean;
  canOverrideStatus: boolean;
  /** §7.2 enforced transitions this viewer (committee/assignee, non-admin) may take. */
  allowedTransitions: ChallengeStatus[];
  /** §10.1 author actions available to this viewer on their own challenge. */
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  /** §10.3 permanent delete — platform admins only, on any status. */
  canDelete: boolean;
  solutions: SolutionListItem[];
  /** §11 attachments on the challenge itself, visible to this viewer (anonymity-safe). */
  attachments: AttachmentView[];
}

interface ChallengeRow {
  id: string;
  number: string;
  title: string;
  description: string;
  status: string;
  visibility: "org" | "namespace";
  namespace_id: string;
  namespace_slug: string;
  impact_area_id: string;
  impact_area_name: string;
  client_name: string | null;
  author_id: string;
  author_display_name: string;
  is_anonymous: boolean;
  assignee_id: string | null;
  assignee_display_name: string | null;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
  resolved_at: Date | null;
  like_count: string;
  liked_by_viewer: boolean;
  followed_by_viewer: boolean;
  solution_count: string;
  is_new: boolean;
}

interface SolutionRow {
  id: string;
  number: string;
  challenge_id: string;
  description: string;
  cost_vs_benefits: string | null;
  status: string;
  author_id: string;
  author_display_name: string;
  is_anonymous: boolean;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
  like_count: string;
  liked_by_viewer: boolean;
  followed_by_viewer: boolean;
}

const CHALLENGE_SELECT = `
  select c.id, c.number::text, c.title, c.description, c.status, c.visibility,
         c.namespace_id, ns.slug as namespace_slug,
         c.impact_area_id, ia.name as impact_area_name,
         c.client_name, c.author_id, u.display_name as author_display_name, c.is_anonymous,
         c.assignee_id, au.display_name as assignee_display_name,
         c.created_at, c.updated_at, c.edited_at, c.resolved_at,
         (select count(*) from likes l where l.parent_type = 'challenge' and l.parent_id = c.id) as like_count,
         exists(select 1 from likes lv where lv.parent_type = 'challenge' and lv.parent_id = c.id and lv.user_id = $viewer) as liked_by_viewer,
         exists(select 1 from follows fv where fv.parent_type = 'challenge' and fv.parent_id = c.id and fv.user_id = $viewer) as followed_by_viewer,
         (select count(*) from solutions s where s.challenge_id = c.id
            and s.status not in ('rejected','not_selected','withdrawn','proposed')) as solution_count,
         (c.created_at > coalesce((select su.challenges_seen_at from users su where su.id = $viewer), '-infinity'::timestamptz)) as is_new
    from challenges c
    join users u on u.id = c.author_id
    left join users au on au.id = c.assignee_id
    join namespaces ns on ns.id = c.namespace_id
    join impact_areas ia on ia.id = c.impact_area_id
`;

function toListItem(row: ChallengeRow): ChallengeListItem {
  return {
    id: row.id,
    number: formatChallengeNumber(row.number),
    title: row.title,
    author: maskAuthor({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name }),
    namespaceSlug: row.namespace_slug,
    impactAreaName: row.impact_area_name,
    status: row.status as ChallengeStatus,
    createdAt: row.created_at.toISOString(),
    likeCount: Number(row.like_count),
    likedByViewer: row.liked_by_viewer,
    followedByViewer: row.followed_by_viewer,
    solutionCount: Number(row.solution_count),
    isNew: row.is_new,
  };
}

/** True when the viewer may traverse the §7.2/§8.2 enforced graph for a challenge/solution in
 *  this namespace — a committee member of the namespace, or the challenge's assignee. */
function isEnforcer(viewer: Viewer, namespaceId: string, assigneeId: string | null): boolean {
  return viewer.roles.isCommittee(namespaceId) || (assigneeId !== null && assigneeId === viewer.userId);
}

/** §2.4 existence-not-disclosed: the visibility gate every by-number write path runs BEFORE any
 *  permission (403) or state (409) check, so an item the caller cannot see answers exactly like
 *  one that does not exist. Takes the raw challenge columns the write paths already select. */
function isChallengeRowVisible(
  viewer: Viewer,
  row: { namespace_id: string; visibility: "org" | "namespace"; status: string; author_id: string },
): boolean {
  return canSeeChallenge(viewer, {
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.status as ChallengeStatus,
    authorId: row.author_id,
  });
}

/** The columns isSolutionRowVisible needs, as the `solutions s join challenges c` reads name them. */
interface SolutionVisibilityColumns {
  status: string;
  author_id: string;
  namespace_id: string;
  visibility: "org" | "namespace";
  challenge_status: string;
  challenge_author_id: string;
  assignee_id: string | null;
}

const SOLUTION_VISIBILITY_SELECT = `s.status, s.author_id, c.namespace_id, c.visibility, c.status as challenge_status,
            c.author_id as challenge_author_id, c.assignee_id`;

/** The solution counterpart: the parent challenge must be visible AND the solution itself (a
 *  `proposed` solution is narrower still, §4.3). */
function isSolutionRowVisible(viewer: Viewer, row: SolutionVisibilityColumns): boolean {
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
}

function toDetail(row: ChallengeRow, viewer: Viewer, solutions: SolutionListItem[], attachments: AttachmentView[] = []): ChallengeDetail {
  const isAdmin = viewer.roles.isNamespaceAdmin(row.namespace_id);
  const isMine = viewer.userId === row.author_id;
  const status = row.status as ChallengeStatus;
  return {
    ...toListItem(row),
    description: row.description,
    clientName: row.client_name,
    impactAreaId: row.impact_area_id,
    visibility: row.visibility,
    namespaceId: row.namespace_id,
    assigneeId: row.assignee_id,
    assigneeDisplayName: row.assignee_display_name,
    updatedAt: row.updated_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    isMine,
    canPropose: row.status === "valid",
    canOverrideStatus: isAdmin,
    allowedTransitions:
      !isAdmin && isEnforcer(viewer, row.namespace_id, row.assignee_id)
        ? challengeEnforcedTargets(status)
        : [],
    canEdit: isMine && canAuthorEditChallenge(status),
    canWithdraw: isMine && canAuthorWithdrawChallenge(status),
    canResubmit: isMine && canAuthorResubmit(status),
    canDelete: viewer.roles.isPlatformAdmin,
    solutions,
    attachments,
  };
}

function toSolutionItem(
  row: SolutionRow,
  viewer: Viewer,
  challenge: { namespaceId: string; assigneeId: string | null },
  attachments: AttachmentView[] = [],
): SolutionListItem {
  const isAdmin = viewer.roles.isNamespaceAdmin(challenge.namespaceId);
  const isMine = viewer.userId === row.author_id;
  const status = row.status as SolutionStatus;
  return {
    id: row.id,
    number: formatSolutionNumber(row.number),
    description: row.description,
    costVsBenefits: row.cost_vs_benefits,
    author: maskAuthor({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name }),
    isMine,
    status,
    createdAt: row.created_at.toISOString(),
    likeCount: Number(row.like_count),
    likedByViewer: row.liked_by_viewer,
    followedByViewer: row.followed_by_viewer,
    canOverrideStatus: isAdmin,
    allowedTransitions:
      !isAdmin && isEnforcer(viewer, challenge.namespaceId, challenge.assigneeId)
        ? solutionEnforcedTargets(status)
        : [],
    canEdit: isMine && canAuthorEditSolution(status),
    canWithdraw: isMine && canAuthorWithdrawSolution(status),
    canResubmit: isMine && canAuthorResubmit(status),
    canDelete: viewer.roles.isPlatformAdmin,
    attachments,
  };
}

/** Build the full challenge detail for a viewer, including §11 attachments on the challenge
 *  and on each visible solution (anonymity-safe projection). Used by the two full read paths
 *  (`getChallengeByNumber`, `reloadChallengeDetail`); the leaner write paths return the detail
 *  without attachments (the client re-fetches immediately after a mutation). */
async function buildDetailWithAttachments(db: Pool | PoolClient, viewer: Viewer, row: ChallengeRow): Promise<ChallengeDetail> {
  const solutionRows = await fetchSolutionRows(db, row.id, viewer.userId);
  const challengeCtx = { namespaceId: row.namespace_id, assigneeId: row.assignee_id };
  const solutions: SolutionListItem[] = [];
  for (const s of solutionRows) {
    if (!canSeeSolution(viewer, challengeCtx, { status: s.status as SolutionStatus, authorId: s.author_id })) continue;
    const solutionAttachments = await listAttachmentsForParent(db, viewer, "solution", s.id);
    solutions.push(toSolutionItem(s, viewer, challengeCtx, solutionAttachments));
  }
  const challengeAttachments = await listAttachmentsForParent(db, viewer, "challenge", row.id);
  return toDetail(row, viewer, solutions, challengeAttachments);
}

async function fetchSolutionRows(db: Pool | PoolClient, challengeId: string, viewerId: string): Promise<SolutionRow[]> {
  const { rows } = await db.query<SolutionRow>(
    `select s.id, s.number::text, s.challenge_id, s.description, s.cost_vs_benefits, s.status,
            s.author_id, u.display_name as author_display_name, s.is_anonymous,
            s.created_at, s.updated_at, s.edited_at,
            (select count(*) from likes l where l.parent_type = 'solution' and l.parent_id = s.id) as like_count,
            exists(select 1 from likes lv where lv.parent_type = 'solution' and lv.parent_id = s.id and lv.user_id = $2) as liked_by_viewer,
            exists(select 1 from follows fv where fv.parent_type = 'solution' and fv.parent_id = s.id and fv.user_id = $2) as followed_by_viewer
       from solutions s
       join users u on u.id = s.author_id
      where s.challenge_id = $1
      order by s.created_at asc`,
    [challengeId, viewerId],
  );
  return rows;
}

// ── Impact areas ─────────────────────────────────────────────────────────────────────────

export interface ImpactAreaRecord {
  id: string;
  name: string;
  active: boolean;
}

export async function listActiveImpactAreas(pool: Pool): Promise<ImpactAreaRecord[]> {
  const { rows } = await pool.query<ImpactAreaRecord>(
    `select id, name, active from impact_areas where active = true order by name`,
  );
  return rows;
}

// ── List / detail ────────────────────────────────────────────────────────────────────────

/** The §4.3 row-level visibility predicate over `challenges c`, shared by the gallery list and
 *  the §13.1 new-count so the two can never disagree about what the viewer may see: namespace
 *  membership (or org visibility), and awaiting_triage/withdrawn only for the author and the
 *  namespace's admins. Platform admins see everything. */
export function pushChallengeVisibilityConditions(viewer: Viewer, push: (v: unknown) => string, conditions: string[]): void {
  if (viewer.roles.isPlatformAdmin) return;
  const memberNamespaceIds = viewer.roles.memberNamespaces();
  conditions.push(`(c.visibility = 'org' OR c.namespace_id = ANY(${push(memberNamespaceIds)}::uuid[]))`);

  const namespaceAdminIds = viewer.roles.grants
    .filter((g) => g.role === "namespace_admin" && g.namespaceId !== null)
    .map((g) => g.namespaceId as string);
  const authorParam = push(viewer.userId);
  if (namespaceAdminIds.length > 0) {
    conditions.push(
      `(c.status NOT IN ('awaiting_triage','withdrawn') OR c.author_id = ${authorParam} OR c.namespace_id = ANY(${push(namespaceAdminIds)}::uuid[]))`,
    );
  } else {
    conditions.push(`(c.status NOT IN ('awaiting_triage','withdrawn') OR c.author_id = ${authorParam})`);
  }
}

// ── §6.1 duplicate warning ───────────────────────────────────────────────────────────────

export interface SimilarChallenge {
  number: string;
  title: string;
  status: ChallengeStatus;
  author: MaskedAuthor;
}

/** At most this many matches are shown in the warning. */
export const SIMILAR_LIMIT = 5;
/** The minimum rank: a candidate must share at least this many distinct stemmed terms with the
 *  submission (title + description). One shared word ("process", "team") is noise; two is the
 *  smallest overlap that reads as "about the same thing". A one-term submission needs one. */
export const SIMILAR_MIN_SHARED_TERMS = 2;
/** Terms the query is built from: every title term, then description terms, up to this cap. */
const SIMILAR_MAX_TERMS = 48;

/**
 * Ranks the viewer's VISIBLE challenges (the gallery's own predicate, invariant 2) against what
 * they are about to submit, over the §13.4 full-text index. Excludes rejected and withdrawn —
 * keeps solved, the most useful hit. Terms are OR-ed (a phrase-AND would match almost nothing
 * once a description is involved), candidates are ordered by ts_rank with the title weighted
 * highest, and only those sharing SIMILAR_MIN_SHARED_TERMS distinct terms survive. Authors are
 * masked per §9. Advisory: nothing here can block a submission.
 */
export async function findSimilarChallenges(pool: Pool, viewer: Viewer, input: { title: string; description: string }): Promise<SimilarChallenge[]> {
  // Distinct stems, title first, capped — computed by Postgres's own English parser so the query
  // terms are exactly the lexemes stored in challenges.search_vector.
  const { rows: termRows } = await pool.query<{ term: string }>(
    `select term from (
       select t.term, min(t.ord) as ord
         from (
           select l as term, 0 as ord from unnest(tsvector_to_array(to_tsvector('english', $1))) l
           union all
           select l as term, 1 as ord from unnest(tsvector_to_array(to_tsvector('english', $2))) l
         ) t
        group by t.term
     ) d
     order by ord, term
     limit ${SIMILAR_MAX_TERMS}`,
    [input.title, input.description],
  );
  const terms = termRows.map((r) => r.term);
  if (terms.length === 0) return [];
  const minShared = Math.min(SIMILAR_MIN_SHARED_TERMS, terms.length);

  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const termsParam = push(terms);
  // Each stem is quoted as a tsquery literal, so punctuation inside a lexeme can never be read
  // as tsquery syntax.
  const tsquery = `to_tsquery('simple', (select string_agg(quote_literal(t), ' | ') from unnest(${termsParam}::text[]) t))`;
  const conditions: string[] = [`c.search_vector @@ ${tsquery}`, `c.status not in ('rejected', 'withdrawn')`];
  pushChallengeVisibilityConditions(viewer, push, conditions);

  const { rows } = await pool.query<{
    number: string;
    title: string;
    status: string;
    is_anonymous: boolean;
    author_id: string;
    author_display_name: string;
    shared: number;
  }>(
    `select * from (
       select c.number::text, c.title, c.status, c.is_anonymous, c.author_id, u.display_name as author_display_name,
              ts_rank(c.search_vector, ${tsquery}) as rank,
              (select count(*)::int from unnest(tsvector_to_array(c.search_vector)) l where l = any(${termsParam}::text[])) as shared
         from challenges c
         join users u on u.id = c.author_id
        where ${conditions.join(" and ")}
        order by rank desc, c.created_at desc
        limit 50
     ) ranked
     where shared >= ${push(minShared)}
     order by rank desc
     limit ${SIMILAR_LIMIT}`,
    params,
  );
  return rows.map((r) => ({
    number: formatChallengeNumber(r.number),
    title: r.title,
    status: r.status as ChallengeStatus,
    author: maskAuthor({ isAnonymous: r.is_anonymous, authorId: r.author_id, authorDisplayName: r.author_display_name }),
  }));
}

/** §13.1: challenges visible to the viewer and created since they last left the Challenges
 *  surface. A bare count for the nav bubble — nothing else leaves this function. A viewer whose
 *  marker is NULL (never visited) counts everything they can see. */
export async function countNewChallenges(pool: Pool, viewer: Viewer): Promise<number> {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  conditions.push(`c.created_at > coalesce((select su.challenges_seen_at from users su where su.id = ${push(viewer.userId)}), '-infinity'::timestamptz)`);
  const { rows } = await pool.query<{ count: string }>(`select count(*)::text as count from challenges c where ${conditions.join(" and ")}`, params);
  return Number(rows[0]?.count ?? 0);
}

export async function listChallenges(
  pool: Pool,
  viewer: Viewer,
  filters: ChallengeListFilters,
): Promise<ChallengeListItem[]> {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const viewerParam = push(viewer.userId); // used by the $viewer placeholder in CHALLENGE_SELECT

  const conditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, conditions);

  if (filters.tab === "open") {
    conditions.push(`c.status IN ('in_review','needs_improvement','meeting_scheduled','valid')`);
  } else if (filters.tab === "mine") {
    conditions.push(`c.author_id = ${push(viewer.userId)}`);
  } else {
    conditions.push(`c.status IN ('solved','rejected')`);
  }

  if (filters.status) conditions.push(`c.status = ${push(filters.status)}`);
  if (filters.impactAreaId) conditions.push(`c.impact_area_id = ${push(filters.impactAreaId)}`);
  if (filters.namespaceId) conditions.push(`c.namespace_id = ${push(filters.namespaceId)}`);
  if (filters.authorName) {
    // Anonymity-safety: a name filter must never distinguish "not a match" from "hidden
    // because anonymous" — so anonymous items are unconditionally excluded whenever this
    // filter is active, rather than matched against their (masked) true author name.
    conditions.push(`c.is_anonymous = false AND u.display_name ILIKE ${push(`%${filters.authorName}%`)}`);
  }

  const orderBy =
    filters.sort === "most_liked"
      ? "like_count DESC, c.created_at DESC"
      : filters.sort === "most_solutions"
        ? "solution_count DESC, c.created_at DESC"
        : "c.created_at DESC";

  const whereClause = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const sql = `${CHALLENGE_SELECT.replaceAll("$viewer", viewerParam)} ${whereClause} order by ${orderBy} limit 100`;

  const { rows } = await pool.query<ChallengeRow>(sql, params);
  return rows.map(toListItem);
}

/** Folds "doesn't exist" and "exists but not visible" into the same null result — an
 *  invisible item must never be distinguishable from a nonexistent one (no 404-vs-403
 *  existence oracle). */
export async function getChallengeByNumber(pool: Pool, viewer: Viewer, number: string): Promise<ChallengeDetail | null> {
  if (!isEntityNumber(number)) return null; // §2.4: a malformed number is "not found", no DB round-trip
  const { rows } = await pool.query<ChallengeRow>(
    `${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.number = $1`,
    [number, viewer.userId],
  );
  const row = rows[0];
  if (!row) return null;
  const visible = canSeeChallenge(viewer, {
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.status as ChallengeStatus,
    authorId: row.author_id,
  });
  if (!visible) return null;

  return buildDetailWithAttachments(pool, viewer, row);
}

// ── Create ───────────────────────────────────────────────────────────────────────────────

export type CreateChallengeResult =
  | { status: "ok"; challenge: ChallengeDetail }
  | { status: "unknown_namespace" }
  | { status: "forbidden_namespace" }
  | { status: "unknown_impact_area" }
  | { status: "inactive_impact_area" }
  | { status: "attachments_not_clean" }
  | { status: "invalid"; error: string };

export async function createChallenge(
  pool: Pool,
  author: Viewer,
  input: {
    impactAreaId: string;
    namespaceId: string;
    title: unknown;
    description: unknown;
    clientName: unknown;
    visibility: unknown;
    isAnonymous: unknown;
    draftKey?: unknown;
    /** §6.1: the similar challenges the submitter saw and submitted past (already parsed). */
    similarAcknowledged?: string[];
  },
): Promise<CreateChallengeResult> {
  const { rows: nsRows } = await pool.query<{ id: string }>(
    `select id from namespaces where id = $1 and archived_at is null`,
    [input.namespaceId],
  );
  if (!nsRows[0]) return { status: "unknown_namespace" };
  // Submission targeting (§4.3): a user may submit into any namespace they are a member
  // of (everyone can use global).
  if (!author.roles.isMemberOf(input.namespaceId)) return { status: "forbidden_namespace" };

  const { rows: areaRows } = await pool.query<{ id: string; name: string; active: boolean }>(
    `select id, name, active from impact_areas where id = $1`,
    [input.impactAreaId],
  );
  const area = areaRows[0];
  if (!area) return { status: "unknown_impact_area" };
  if (!area.active) return { status: "inactive_impact_area" };

  const validated = validateChallengeFields({
    title: input.title,
    description: input.description,
    clientName: input.clientName,
    visibility: input.visibility,
    isAnonymous: input.isAnonymous,
    impactAreaIsClient: area.name === "Client",
  });
  if (!validated.ok) return { status: "invalid", error: validated.error };

  // §11 staging: bind any files staged during the form to this challenge (in-transaction).
  const draftKey = typeof input.draftKey === "string" && isUuid(input.draftKey) ? input.draftKey : null;
  // §11 scan gate: when a scanner is available, refuse to submit while any staged file is still
  // scanning, infected, or unscannable — so a challenge is only ever born with clean attachments. When ClamAV
  // is unavailable the platform fails open and pending files bind as before (scanned later).
  if (draftKey && (await isScanAvailable()) && (await hasUncleanStagedAttachments(pool, author, "challenge", draftKey))) {
    return { status: "attachments_not_clean" };
  }
  const maxPerItem = draftKey ? (await getAttachmentLimits(pool)).maxPerItem : 0;

  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into challenges (namespace_id, visibility, title, description, impact_area_id, client_name, is_anonymous, author_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        input.namespaceId,
        validated.value.visibility,
        validated.value.title,
        validated.value.description,
        input.impactAreaId,
        validated.value.clientName,
        validated.value.isAnonymous,
        author.userId,
      ],
    );
    const id = rows[0]!.id;
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "challenge.created",
      targetType: "challenge",
      targetId: id,
      after: {
        title: validated.value.title,
        namespaceId: input.namespaceId,
        visibility: validated.value.visibility,
        isAnonymous: validated.value.isAnonymous,
        // §6.1: present only when the author submitted past a duplicate warning.
        ...(input.similarAcknowledged && input.similarAcknowledged.length > 0 ? { similarAcknowledged: input.similarAcknowledged } : {}),
      },
    });
    if (draftKey) await bindStagedAttachments(client, author, "challenge", id, draftKey, maxPerItem);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      id,
      author.userId,
    ]);
    const attachments = await listAttachmentsForParent(client, author, "challenge", id);
    return { status: "ok", challenge: toDetail(full[0]!, author, [], attachments) };
  });
}

export type CreateSolutionResult =
  | { status: "ok"; solution: SolutionListItem }
  | { status: "not_found" }
  | { status: "not_valid_status" }
  | { status: "attachments_not_clean" }
  | { status: "invalid"; error: string };

export async function createSolution(
  pool: Pool,
  author: Viewer,
  challengeNumber: string,
  input: { description: unknown; costVsBenefits: unknown; isAnonymous: unknown; draftKey?: unknown },
): Promise<CreateSolutionResult> {
  if (!isEntityNumber(challengeNumber)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; namespace_id: string; visibility: "org" | "namespace"; status: string; author_id: string; assignee_id: string | null }>(
    `select id, namespace_id, visibility, status, author_id, assignee_id from challenges where number = $1`,
    [challengeNumber],
  );
  const challenge = rows[0];
  if (!challenge) return { status: "not_found" };
  const visible = canSeeChallenge(author, {
    namespaceId: challenge.namespace_id,
    visibility: challenge.visibility,
    status: challenge.status as ChallengeStatus,
    authorId: challenge.author_id,
  });
  if (!visible) return { status: "not_found" };
  // §6.2: proposing is allowed ONLY while the challenge is `valid`.
  if (challenge.status !== "valid") return { status: "not_valid_status" };

  const validated = validateSolutionFields(input);
  if (!validated.ok) return { status: "invalid", error: validated.error };

  // §11 staging: bind any files staged during the propose form to this solution (in-transaction).
  const draftKey = typeof input.draftKey === "string" && isUuid(input.draftKey) ? input.draftKey : null;
  // §11 scan gate (see createChallenge): block submit on unclean staged files when a scanner is up.
  if (draftKey && (await isScanAvailable()) && (await hasUncleanStagedAttachments(pool, author, "solution", draftKey))) {
    return { status: "attachments_not_clean" };
  }
  const maxPerItem = draftKey ? (await getAttachmentLimits(pool)).maxPerItem : 0;

  return inTransaction(pool, async (client) => {
    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into solutions (challenge_id, description, cost_vs_benefits, is_anonymous, author_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [challenge.id, validated.value.description, validated.value.costVsBenefits, validated.value.isAnonymous, author.userId],
    );
    const id = inserted[0]!.id;
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "solution.created",
      targetType: "solution",
      targetId: id,
      after: { challengeId: challenge.id, isAnonymous: validated.value.isAnonymous },
    });
    if (draftKey) await bindStagedAttachments(client, author, "solution", id, draftKey, maxPerItem);
    const solutionRows = await fetchSolutionRows(client, challenge.id, author.userId);
    const row = solutionRows.find((s) => s.id === id)!;
    return { status: "ok", solution: toSolutionItem(row, author, { namespaceId: challenge.namespace_id, assigneeId: challenge.assignee_id }) };
  });
}

// ── Status transitions: admin override + committee/assignee enforced (§7.2/§8.2, invariant 6) ─

export type SetChallengeStatusResult =
  | { status: "ok"; challenge: ChallengeDetail; changed: boolean; previousStatus: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "illegal_transition" }
  | { status: "invalid_status" };

/** The actual mutation + audit, shared by the full (`setChallengeStatus`) and lean
 *  (`setChallengeStatusLean`, used by bulk actions) variants — a no-op when the status is
 *  unchanged. `mode` records whether this was an admin free-set (`override: true`) or a
 *  committee/assignee enforced transition (`override: false`) in the audit trail (§7.2). */
async function applyChallengeStatusChange(
  client: PoolClient,
  actor: Viewer,
  current: { id: string; status: string },
  newStatus: string,
  mode: TransitionMode,
): Promise<void> {
  if (current.status === newStatus) return;
  const resolvedAtClause = newStatus === "solved" ? `, resolved_at = coalesce(resolved_at, now())` : "";
  await client.query(`update challenges set status = $2, updated_at = now(), status_changed_at = now()${resolvedAtClause} where id = $1`, [
    current.id,
    newStatus,
  ]);
  await appendAudit(client, {
    actorUserId: actor.userId,
    action: "challenge.status_changed",
    targetType: "challenge",
    targetId: current.id,
    before: { status: current.status },
    after: { status: newStatus, override: mode === "override" },
  });
}

async function loadChallengeForStatusChange(
  pool: Pool,
  actor: Viewer,
  number: string,
  newStatus: string,
): Promise<
  | { status: "ok"; current: { id: string; namespace_id: string; status: string }; mode: TransitionMode }
  | { status: "not_found" | "forbidden" | "illegal_transition" | "invalid_status" }
> {
  if (!isChallengeStatus(newStatus)) return { status: "invalid_status" };
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string;
    visibility: "org" | "namespace";
    status: string;
    author_id: string;
    assignee_id: string | null;
  }>(`select id, namespace_id, visibility, status, author_id, assignee_id from challenges where number = $1`, [number]);
  const current = rows[0];
  // §2.4: a challenge the actor cannot see is "not found", never "forbidden".
  if (!current || !isChallengeRowVisible(actor, current)) return { status: "not_found" };
  const decision = decideTransition({
    from: current.status,
    to: newStatus,
    isAdmin: actor.roles.isNamespaceAdmin(current.namespace_id),
    isEnforcer: isEnforcer(actor, current.namespace_id, current.assignee_id),
    isLegalArrow: isChallengeEnforcedTransition(current.status as ChallengeStatus, newStatus),
  });
  if (!decision.allowed) return { status: decision.reason };
  return { status: "ok", current, mode: decision.mode };
}

export async function setChallengeStatus(
  pool: Pool,
  actor: Viewer,
  number: string,
  newStatus: string,
): Promise<SetChallengeStatusResult> {
  const loaded = await loadChallengeForStatusChange(pool, actor, number, newStatus);
  if (loaded.status !== "ok") return loaded;
  const { current, mode } = loaded;

  return inTransaction(pool, async (client) => {
    await applyChallengeStatusChange(client, actor, current, newStatus, mode);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      current.id,
      actor.userId,
    ]);
    const row = full[0]!;
    const solutionRows = await fetchSolutionRows(client, row.id, actor.userId);
    const solutions = solutionRows
      .filter((s) =>
        canSeeSolution(
          actor,
          { namespaceId: row.namespace_id, assigneeId: row.assignee_id },
          { status: s.status as SolutionStatus, authorId: s.author_id },
        ),
      )
      .map((s) => toSolutionItem(s, actor, { namespaceId: row.namespace_id, assigneeId: row.assignee_id }));
    return {
      status: "ok",
      challenge: toDetail(row, actor, solutions),
      changed: current.status !== newStatus,
      previousStatus: current.status,
    };
  });
}

export type SetChallengeStatusLeanResult =
  | { status: "ok"; changed: boolean; previousStatus: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "illegal_transition" }
  | { status: "invalid_status" };

/** Same auth/audit semantics as `setChallengeStatus`, without the full challenge+solutions
 *  re-fetch — for bulk admin actions (§14.1) that only need the outcome, not the detail
 *  payload, and would otherwise pay for N unused `CHALLENGE_SELECT` joins. */
export async function setChallengeStatusLean(pool: Pool, actor: Viewer, number: string, newStatus: string): Promise<SetChallengeStatusLeanResult> {
  const loaded = await loadChallengeForStatusChange(pool, actor, number, newStatus);
  if (loaded.status !== "ok") return loaded;
  const { current, mode } = loaded;

  return inTransaction(pool, async (client) => {
    await applyChallengeStatusChange(client, actor, current, newStatus, mode);
    return { status: "ok", changed: current.status !== newStatus, previousStatus: current.status };
  });
}

export type SetSolutionStatusResult =
  | {
      status: "ok";
      solution: SolutionListItem;
      changed: boolean;
      previousStatus: string;
      /** Present only when this transition triggered the §8.3 auto-close cascade. */
      autoClose?: { challengeId: string; challengeNumber: string; challengeTitle: string; notSelectedAuthorIds: string[]; solutionIds: string[] };
    }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "illegal_transition" }
  | { status: "invalid_status" }
  | { status: "blocked_single_winner" };

/** Thrown from inside the transaction when the DB's solutions_single_winner_idx (not
 *  just the application pre-check) catches a concurrent race on the §8.3 gate. */
class SingleWinnerRaceError extends Error {}

export async function setSolutionStatus(
  pool: Pool,
  actor: Viewer,
  number: string,
  newStatus: string,
): Promise<SetSolutionStatusResult> {
  if (!isSolutionStatus(newStatus)) return { status: "invalid_status" };
  if (!isEntityNumber(number)) return { status: "not_found" };

  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_id: string; challenge_number: string; challenge_title: string }>(
    `select s.id, s.challenge_id, ${SOLUTION_VISIBILITY_SELECT}, c.number::text as challenge_number, c.title as challenge_title
       from solutions s
       join challenges c on c.id = s.challenge_id
      where s.number = $1`,
    [number],
  );
  const current = rows[0];
  if (!current || !isSolutionRowVisible(actor, current)) return { status: "not_found" };
  // Enforcer of a solution = committee of the parent's namespace, or the parent challenge's
  // assignee (§8.2). Admins free-set (override); anyone else is refused.
  const decision = decideTransition({
    from: current.status,
    to: newStatus,
    isAdmin: actor.roles.isNamespaceAdmin(current.namespace_id),
    isEnforcer: isEnforcer(actor, current.namespace_id, current.assignee_id),
    isLegalArrow: isSolutionEnforcedTransition(current.status as SolutionStatus, newStatus),
  });
  if (!decision.allowed) return { status: decision.reason };
  const mode = decision.mode;

  const { rows: siblingRows } = await pool.query<{ id: string; status: string; author_id: string }>(
    `select id, status, author_id from solutions where challenge_id = $1 and id <> $2`,
    [current.challenge_id, current.id],
  );

  if (newStatus === "accepted_internally") {
    const blocked = blocksAcceptedInternally(siblingRows.map((s) => s.status as SolutionStatus));
    if (blocked) return { status: "blocked_single_winner" };
  }

  try {
    return await inTransaction(pool, async (client) => {
      let autoClose: { challengeId: string; challengeNumber: string; challengeTitle: string; notSelectedAuthorIds: string[]; solutionIds: string[] } | undefined;

      if (current.status !== newStatus) {
        try {
          await client.query(`update solutions set status = $2, updated_at = now(), status_changed_at = now() where id = $1`, [current.id, newStatus]);
        } catch (err) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === "23505" && pgErr.constraint === "solutions_single_winner_idx") {
            throw new SingleWinnerRaceError();
          }
          throw err;
        }
        await appendAudit(client, {
          actorUserId: actor.userId,
          action: "solution.status_changed",
          targetType: "solution",
          targetId: current.id,
          before: { status: current.status },
          after: { status: newStatus, override: mode === "override" },
        });

        if (newStatus === "implemented") {
          // §8.3 auto-close cascade: the parent challenge becomes solved, and every other
          // non-terminal sibling becomes not_selected — triggered by the cascade, not a
          // direct admin action on those rows, so audited with a distinct trigger tag.
          await client.query(
            `update challenges set status = 'solved', resolved_at = coalesce(resolved_at, now()), updated_at = now(), status_changed_at = now() where id = $1`,
            [current.challenge_id],
          );
          await appendAudit(client, {
            actorUserId: actor.userId,
            action: "challenge.status_changed",
            targetType: "challenge",
            targetId: current.challenge_id,
            after: { status: "solved", trigger: "auto_close", solutionId: current.id },
          });

          const toClose = siblingsToAutoClose(
            [...siblingRows.map((s) => ({ id: s.id, status: s.status as SolutionStatus })), { id: current.id, status: "implemented" }],
            current.id,
          );
          for (const siblingId of toClose) {
            const before = siblingRows.find((s) => s.id === siblingId)!.status;
            await client.query(`update solutions set status = 'not_selected', updated_at = now(), status_changed_at = now() where id = $1`, [siblingId]);
            await appendAudit(client, {
              actorUserId: actor.userId,
              action: "solution.status_changed",
              targetType: "solution",
              targetId: siblingId,
              before: { status: before },
              after: { status: "not_selected", trigger: "auto_close", implementedSolutionId: current.id },
            });
          }
          autoClose = {
            challengeId: current.challenge_id,
            challengeNumber: current.challenge_number,
            challengeTitle: current.challenge_title,
            notSelectedAuthorIds: toClose.map((id) => siblingRows.find((s) => s.id === id)!.author_id),
            // §12.1 event 8: "followers of the challenge AND its solutions" — the implemented
            // solution plus every sibling just closed as not_selected.
            solutionIds: [current.id, ...toClose],
          };
        }
      }
      const solutionRows = await fetchSolutionRows(client, current.challenge_id, actor.userId);
      const row = solutionRows.find((s) => s.id === current.id)!;
      return {
        status: "ok",
        solution: toSolutionItem(row, actor, { namespaceId: current.namespace_id, assigneeId: current.assignee_id }),
        changed: current.status !== newStatus,
        previousStatus: current.status,
        autoClose,
      };
    });
  } catch (err) {
    if (err instanceof SingleWinnerRaceError) return { status: "blocked_single_winner" };
    throw err;
  }
}

// ── Likes (minimal slice pulled forward from Phase 3) ───────────────────────────────────

export type ToggleLikeResult = { status: "ok"; liked: boolean; count: number } | { status: "not_found" };

export async function toggleLike(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<ToggleLikeResult> {
  const visible = await isParentVisible(pool, viewer, parentType, parentId);
  if (!visible) return { status: "not_found" };

  return inTransaction(pool, async (client) => {
    const { rows: existing } = await client.query(
      `select 1 from likes where user_id = $1 and parent_type = $2 and parent_id = $3`,
      [viewer.userId, parentType, parentId],
    );
    let liked: boolean;
    if (existing.length > 0) {
      await client.query(`delete from likes where user_id = $1 and parent_type = $2 and parent_id = $3`, [
        viewer.userId,
        parentType,
        parentId,
      ]);
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "like.removed",
        targetType: parentType,
        targetId: parentId,
      });
      liked = false;
    } else {
      await client.query(`insert into likes (user_id, parent_type, parent_id) values ($1, $2, $3)`, [
        viewer.userId,
        parentType,
        parentId,
      ]);
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "like.added",
        targetType: parentType,
        targetId: parentId,
      });
      liked = true;
    }
    const { rows: countRows } = await client.query<{ count: string }>(
      `select count(*)::text as count from likes where parent_type = $1 and parent_id = $2`,
      [parentType, parentId],
    );
    return { status: "ok", liked, count: Number(countRows[0]!.count) };
  });
}

/** Exported for reuse by comments/follows/likes stores — any parent-scoped feature needs
 *  the same "can this viewer see the challenge/solution at all" gate (§4.3). */
export async function isParentVisible(pool: Pool, viewer: Viewer, parentType: "challenge" | "solution", parentId: string): Promise<boolean> {
  if (parentType === "challenge") {
    const { rows } = await pool.query<{ namespace_id: string; visibility: "org" | "namespace"; status: string; author_id: string }>(
      `select namespace_id, visibility, status, author_id from challenges where id = $1`,
      [parentId],
    );
    const row = rows[0];
    if (!row) return false;
    return canSeeChallenge(viewer, {
      namespaceId: row.namespace_id,
      visibility: row.visibility,
      status: row.status as ChallengeStatus,
      authorId: row.author_id,
    });
  }
  const { rows } = await pool.query<{
    status: string;
    author_id: string;
    namespace_id: string;
    visibility: "org" | "namespace";
    challenge_status: string;
    challenge_author_id: string;
    assignee_id: string | null;
  }>(
    `select s.status, s.author_id, c.namespace_id, c.visibility,
            c.status as challenge_status, c.author_id as challenge_author_id, c.assignee_id
       from solutions s
       join challenges c on c.id = s.challenge_id
      where s.id = $1`,
    [parentId],
  );
  const row = rows[0];
  if (!row) return false;
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
}

/** The namespace a challenge or solution belongs to (via its parent challenge for
 *  solutions) — used by comments/follows moderation checks (isNamespaceAdmin). Null when
 *  the parent doesn't exist. */
export async function getParentNamespaceId(
  pool: Pool | PoolClient,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<string | null> {
  if (parentType === "challenge") {
    const { rows } = await pool.query<{ namespace_id: string }>(`select namespace_id from challenges where id = $1`, [
      parentId,
    ]);
    return rows[0]?.namespace_id ?? null;
  }
  const { rows } = await pool.query<{ namespace_id: string }>(
    `select c.namespace_id from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  return rows[0]?.namespace_id ?? null;
}

// ── Assignment (§7.3) ────────────────────────────────────────────────────────────────────

export type AssignResult =
  | { status: "ok"; challenge: ChallengeDetail; assigned: boolean; previousAssigneeId: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "unknown_user" }
  | { status: "terminal_status" };

/** Exported for the GDPR erasure hand-over (§3), whose every move is an ordinary §7.3 change. */
export async function applyChallengeAssigneeChange(
  client: PoolClient,
  admin: Pick<Viewer, "userId">,
  current: { id: string; assignee_id: string | null },
  assigneeUserId: string | null,
): Promise<void> {
  await client.query(`update challenges set assignee_id = $2, updated_at = now() where id = $1`, [current.id, assigneeUserId]);
  await appendAudit(client, {
    actorUserId: admin.userId,
    action: assigneeUserId ? "challenge.assigned" : "challenge.unassigned",
    targetType: "challenge",
    targetId: current.id,
    before: { assigneeId: current.assignee_id },
    after: { assigneeId: assigneeUserId },
  });
  if (assigneeUserId) {
    // §12.3: an assignee is auto-followed to their challenge (they may unfollow later).
    await client.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $2) on conflict do nothing`, [assigneeUserId, current.id]);
  }
}

async function loadChallengeForAssignment(
  pool: Pool,
  admin: Viewer,
  number: string,
  assigneeUserId: string | null,
): Promise<
  | { status: "ok"; current: { id: string; namespace_id: string; status: string; assignee_id: string | null } }
  | { status: "not_found" | "forbidden" | "terminal_status" | "unknown_user" }
> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string;
    visibility: "org" | "namespace";
    status: string;
    author_id: string;
    assignee_id: string | null;
  }>(`select id, namespace_id, visibility, status, author_id, assignee_id from challenges where number = $1`, [number]);
  const current = rows[0];
  if (!current || !isChallengeRowVisible(admin, current)) return { status: "not_found" };
  if (!admin.roles.isNamespaceAdmin(current.namespace_id)) return { status: "forbidden" };
  if (!canAssignAtStatus(current.status as ChallengeStatus)) return { status: "terminal_status" };

  if (assigneeUserId !== null) {
    const { rows: userRows } = await pool.query<{ id: string }>(`select id from users where id = $1 and active = true`, [
      assigneeUserId,
    ]);
    if (!userRows[0]) return { status: "unknown_user" };
  }
  return { status: "ok", current };
}

/** `assigneeUserId: null` unassigns. Assignment is possible from awaiting_triage onward and
 *  blocked on terminal statuses (§7.3). Granted by a namespace/platform admin. */
export async function setChallengeAssignee(
  pool: Pool,
  admin: Viewer,
  number: string,
  assigneeUserId: string | null,
): Promise<AssignResult> {
  const loaded = await loadChallengeForAssignment(pool, admin, number, assigneeUserId);
  if (loaded.status !== "ok") return loaded;
  const { current } = loaded;

  return inTransaction(pool, async (client) => {
    await applyChallengeAssigneeChange(client, admin, current, assigneeUserId);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      current.id,
      admin.userId,
    ]);
    const row = full[0]!;
    const solutionRows = await fetchSolutionRows(client, row.id, admin.userId);
    const solutions = solutionRows
      .filter((s) =>
        canSeeSolution(admin, { namespaceId: row.namespace_id, assigneeId: row.assignee_id }, { status: s.status as SolutionStatus, authorId: s.author_id }),
      )
      .map((s) => toSolutionItem(s, admin, { namespaceId: row.namespace_id, assigneeId: row.assignee_id }));
    return { status: "ok", challenge: toDetail(row, admin, solutions), assigned: assigneeUserId !== null, previousAssigneeId: current.assignee_id };
  });
}

export type AssignLeanResult =
  | { status: "ok"; assigned: boolean }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "unknown_user" }
  | { status: "terminal_status" };

/** Same auth/audit semantics as `setChallengeAssignee`, without the full challenge+solutions
 *  re-fetch — for bulk admin actions (§14.1). */
export async function setChallengeAssigneeLean(pool: Pool, admin: Viewer, number: string, assigneeUserId: string | null): Promise<AssignLeanResult> {
  const loaded = await loadChallengeForAssignment(pool, admin, number, assigneeUserId);
  if (loaded.status !== "ok") return loaded;
  const { current } = loaded;

  return inTransaction(pool, async (client) => {
    await applyChallengeAssigneeChange(client, admin, current, assigneeUserId);
    return { status: "ok", assigned: assigneeUserId !== null };
  });
}

// ── Visibility change (§4.3, §14.2 moderation) ────────────────────────────────────────────

export type SetVisibilityResult =
  | { status: "ok"; challenge: ChallengeDetail }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "invalid" };

/** §4.3: a challenge's visibility (org ↔ namespace) is changeable after submission only by a
 *  namespace/platform admin, and every change is audited (§15 "visibility changes"). */
export async function setChallengeVisibility(pool: Pool, admin: Viewer, number: string, visibility: string): Promise<SetVisibilityResult> {
  if (visibility !== "org" && visibility !== "namespace") return { status: "invalid" };
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; namespace_id: string; visibility: "org" | "namespace"; status: string; author_id: string }>(
    `select id, namespace_id, visibility, status, author_id from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(admin, cur)) return { status: "not_found" };
  if (!admin.roles.isNamespaceAdmin(cur.namespace_id)) return { status: "forbidden" };
  if (cur.visibility === visibility) return { status: "ok", challenge: await reloadChallengeDetail(pool, admin, cur.id) };

  return inTransaction(pool, async (client) => {
    await client.query(`update challenges set visibility = $2, updated_at = now() where id = $1`, [cur.id, visibility]);
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "challenge.visibility_changed",
      targetType: "challenge",
      targetId: cur.id,
      before: { visibility: cur.visibility },
      after: { visibility },
    });
    return { status: "ok", challenge: await reloadChallengeDetail(client, admin, cur.id) };
  });
}

// ── Author edit / withdraw / resubmit (§10.1) ─────────────────────────────────────────────

/** Re-load the full detail payload for a viewer (the CHALLENGE_SELECT + visible-solutions
 *  build several write paths need after they mutate). */
async function reloadChallengeDetail(db: Pool | PoolClient, viewer: Viewer, challengeId: string): Promise<ChallengeDetail> {
  const { rows } = await db.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [challengeId, viewer.userId]);
  const row = rows[0]!;
  return buildDetailWithAttachments(db, viewer, row);
}

/** Build the {before, after} field-level diff (§10.1) — only the columns that actually changed. */
function diffFields(pairs: { key: string; before: unknown; after: unknown }[]): { before: Record<string, unknown>; after: Record<string, unknown>; changed: boolean } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const p of pairs) {
    if (p.before !== p.after) {
      before[p.key] = p.before;
      after[p.key] = p.after;
    }
  }
  return { before, after, changed: Object.keys(after).length > 0 };
}

export type EditChallengeResult =
  | { status: "ok"; challenge: ChallengeDetail }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "unknown_impact_area" }
  | { status: "inactive_impact_area" }
  | { status: "invalid"; error: string };

/** Author content edit of a challenge (§10.1): allowed only by the author within the edit
 *  window (awaiting_triage / needs_improvement). Visibility, anonymity, and namespace are NOT
 *  editable here (§4.3/§9). Stamps `edited_at` and audits a field-level diff. */
export async function editChallenge(
  pool: Pool,
  author: Viewer,
  number: string,
  input: { title: unknown; description: unknown; clientName: unknown; impactAreaId: string },
): Promise<EditChallengeResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string;
    status: string;
    author_id: string;
    impact_area_id: string;
    title: string;
    description: string;
    client_name: string | null;
    visibility: "org" | "namespace";
    is_anonymous: boolean;
  }>(
    `select id, namespace_id, status, author_id, impact_area_id, title, description, client_name, visibility, is_anonymous
       from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(author, cur)) return { status: "not_found" };
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorEditChallenge(cur.status as ChallengeStatus)) return { status: "not_editable" };

  const { rows: areaRows } = await pool.query<{ id: string; name: string; active: boolean }>(`select id, name, active from impact_areas where id = $1`, [input.impactAreaId]);
  const area = areaRows[0];
  if (!area) return { status: "unknown_impact_area" };
  if (!area.active) return { status: "inactive_impact_area" };

  const validated = validateChallengeFields({
    title: input.title,
    description: input.description,
    clientName: input.clientName,
    visibility: cur.visibility, // unchanged — §4.3 keeps visibility a namespace/platform-admin edit
    isAnonymous: cur.is_anonymous, // unchanged — anonymity is removed only via self-reveal (§9)
    impactAreaIsClient: area.name === "Client",
  });
  if (!validated.ok) return { status: "invalid", error: validated.error };

  const diff = diffFields([
    { key: "title", before: cur.title, after: validated.value.title },
    { key: "description", before: cur.description, after: validated.value.description },
    { key: "clientName", before: cur.client_name, after: validated.value.clientName },
    { key: "impactAreaId", before: cur.impact_area_id, after: input.impactAreaId },
  ]);

  return inTransaction(pool, async (client) => {
    if (diff.changed) {
      await client.query(
        `update challenges set title = $2, description = $3, client_name = $4, impact_area_id = $5, edited_at = now(), updated_at = now() where id = $1`,
        [cur.id, validated.value.title, validated.value.description, validated.value.clientName, input.impactAreaId],
      );
      await appendAudit(client, { actorUserId: author.userId, action: "challenge.edited", targetType: "challenge", targetId: cur.id, before: diff.before, after: diff.after });
    }
    return { status: "ok", challenge: await reloadChallengeDetail(client, author, cur.id) };
  });
}

export type EditSolutionResult =
  | { status: "ok"; solution: SolutionListItem }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "invalid"; error: string };

export async function editSolution(
  pool: Pool,
  author: Viewer,
  number: string,
  input: { description: unknown; costVsBenefits: unknown },
): Promise<EditSolutionResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_id: string; description: string; cost_vs_benefits: string | null }>(
    `select s.id, s.challenge_id, ${SOLUTION_VISIBILITY_SELECT}, s.description, s.cost_vs_benefits
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isSolutionRowVisible(author, cur)) return { status: "not_found" };
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorEditSolution(cur.status as SolutionStatus)) return { status: "not_editable" };

  // isAnonymous is not editable here; pass the field through validation with a fixed value it
  // won't apply (self-reveal owns anonymity, §9).
  const validated = validateSolutionFields({ description: input.description, costVsBenefits: input.costVsBenefits, isAnonymous: false });
  if (!validated.ok) return { status: "invalid", error: validated.error };

  const diff = diffFields([
    { key: "description", before: cur.description, after: validated.value.description },
    { key: "costVsBenefits", before: cur.cost_vs_benefits, after: validated.value.costVsBenefits },
  ]);

  return inTransaction(pool, async (client) => {
    if (diff.changed) {
      await client.query(`update solutions set description = $2, cost_vs_benefits = $3, edited_at = now(), updated_at = now() where id = $1`, [
        cur.id,
        validated.value.description,
        validated.value.costVsBenefits,
      ]);
      await appendAudit(client, { actorUserId: author.userId, action: "solution.edited", targetType: "solution", targetId: cur.id, before: diff.before, after: diff.after });
    }
    const solutionRows = await fetchSolutionRows(client, cur.challenge_id, author.userId);
    const row = solutionRows.find((s) => s.id === cur.id)!;
    return { status: "ok", solution: toSolutionItem(row, author, { namespaceId: cur.namespace_id, assigneeId: cur.assignee_id }) };
  });
}

export type WithdrawChallengeResult =
  | { status: "ok"; challengeId: string; namespaceId: string; title: string; previousStatus: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_withdrawable" };

/** Author withdraws their own challenge from any non-terminal status → withdrawn (§10.1). */
export async function withdrawChallenge(pool: Pool, author: Viewer, number: string): Promise<WithdrawChallengeResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; status: string; author_id: string; namespace_id: string; visibility: "org" | "namespace"; title: string; assignee_id: string | null }>(
    `select id, status, author_id, namespace_id, visibility, title, assignee_id from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(author, cur)) return { status: "not_found" };
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorWithdrawChallenge(cur.status as ChallengeStatus)) return { status: "not_withdrawable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update challenges set status = 'withdrawn', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "withdrawn", trigger: "author_withdrawn" },
    });
    return { status: "ok", challengeId: cur.id, namespaceId: cur.namespace_id, title: cur.title, previousStatus: cur.status, assigneeId: cur.assignee_id };
  });
}

export type WithdrawSolutionResult =
  | { status: "ok"; solutionId: string; challengeId: string; namespaceId: string; challengeNumber: string; challengeTitle: string; previousStatus: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_withdrawable" };

export async function withdrawSolution(pool: Pool, author: Viewer, number: string): Promise<WithdrawSolutionResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_id: string; challenge_number: string; challenge_title: string }>(
    `select s.id, s.challenge_id, ${SOLUTION_VISIBILITY_SELECT}, c.number::text as challenge_number, c.title as challenge_title
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isSolutionRowVisible(author, cur)) return { status: "not_found" };
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorWithdrawSolution(cur.status as SolutionStatus)) return { status: "not_withdrawable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update solutions set status = 'withdrawn', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "solution.status_changed",
      targetType: "solution",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "withdrawn", trigger: "author_withdrawn" },
    });
    return { status: "ok", solutionId: cur.id, challengeId: cur.challenge_id, namespaceId: cur.namespace_id, challengeNumber: cur.challenge_number, challengeTitle: cur.challenge_title, previousStatus: cur.status, assigneeId: cur.assignee_id };
  });
}

export type ResubmitChallengeResult =
  | { status: "ok"; challengeId: string; namespaceId: string; title: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_resubmittable" };

/** Author resubmits their own needs_improvement challenge → in_review (§10.1); notifies
 *  reviewers (route). Audited as an enforced status change (`override:false`). */
export async function resubmitChallenge(pool: Pool, author: Viewer, number: string): Promise<ResubmitChallengeResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; status: string; author_id: string; namespace_id: string; visibility: "org" | "namespace"; title: string; assignee_id: string | null }>(
    `select id, status, author_id, namespace_id, visibility, title, assignee_id from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(author, cur)) return { status: "not_found" };
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorResubmit(cur.status as ChallengeStatus)) return { status: "not_resubmittable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update challenges set status = 'in_review', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "in_review", override: false, trigger: "author_resubmit" },
    });
    return { status: "ok", challengeId: cur.id, namespaceId: cur.namespace_id, title: cur.title, assigneeId: cur.assignee_id };
  });
}

export type ResubmitSolutionResult =
  | { status: "ok"; solutionId: string; namespaceId: string; challengeNumber: string; challengeTitle: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_resubmittable" };

export async function resubmitSolution(pool: Pool, author: Viewer, number: string): Promise<ResubmitSolutionResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_number: string; challenge_title: string }>(
    `select s.id, ${SOLUTION_VISIBILITY_SELECT}, c.number::text as challenge_number, c.title as challenge_title
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isSolutionRowVisible(author, cur)) return { status: "not_found" };
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorResubmit(cur.status as SolutionStatus)) return { status: "not_resubmittable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update solutions set status = 'in_review', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "solution.status_changed",
      targetType: "solution",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "in_review", override: false, trigger: "author_resubmit" },
    });
    return { status: "ok", solutionId: cur.id, namespaceId: cur.namespace_id, challengeNumber: cur.challenge_number, challengeTitle: cur.challenge_title, assigneeId: cur.assignee_id };
  });
}

// ── Anonymity reveal (§9) ────────────────────────────────────────────────────────────────

export type RevealResult =
  | { status: "ok"; realDisplayName: string; realEmail: string | null; realUserId: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_anonymous" };

/** Admin reveal: transient (never persisted, is_anonymous stays true) — every execution is
 *  audited (§9). Namespace admins (own namespace) and platform admins only; committee and
 *  assignees cannot reveal. */
export async function revealChallengeAuthor(pool: Pool, admin: Viewer, number: string): Promise<RevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; namespace_id: string; visibility: "org" | "namespace"; status: string; is_anonymous: boolean; author_id: string }>(
    `select id, namespace_id, visibility, status, is_anonymous, author_id from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  // §2.4: visibility first — a non-admin probing a hidden challenge gets 404, never 403.
  if (!row || !isChallengeRowVisible(admin, row)) return { status: "not_found" };
  if (!admin.roles.isNamespaceAdmin(row.namespace_id)) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  const { rows: userRows } = await pool.query<{ display_name: string; email: string | null }>(
    `select display_name, email from users where id = $1`,
    [row.author_id],
  );
  await appendAudit(pool, {
    actorUserId: admin.userId,
    action: "anonymity.revealed",
    targetType: "challenge",
    targetId: row.id,
    after: { revealedAuthorId: row.author_id },
  });
  return { status: "ok", realDisplayName: userRows[0]?.display_name ?? "", realEmail: userRows[0]?.email ?? null, realUserId: row.author_id };
}

export async function revealSolutionAuthor(pool: Pool, admin: Viewer, number: string): Promise<RevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; is_anonymous: boolean }>(
    `select s.id, ${SOLUTION_VISIBILITY_SELECT}, s.is_anonymous
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row || !isSolutionRowVisible(admin, row)) return { status: "not_found" };
  if (!admin.roles.isNamespaceAdmin(row.namespace_id)) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  const { rows: userRows } = await pool.query<{ display_name: string; email: string | null }>(
    `select display_name, email from users where id = $1`,
    [row.author_id],
  );
  await appendAudit(pool, {
    actorUserId: admin.userId,
    action: "anonymity.revealed",
    targetType: "solution",
    targetId: row.id,
    after: { revealedAuthorId: row.author_id },
  });
  return { status: "ok", realDisplayName: userRows[0]?.display_name ?? "", realEmail: userRows[0]?.email ?? null, realUserId: row.author_id };
}

export type SelfRevealResult = { status: "ok"; challenge?: ChallengeDetail } | { status: "not_found" } | { status: "forbidden" } | { status: "not_anonymous" };

/** Self-reveal: the author permanently removes their own anonymity (one-way, §9). */
export async function selfRevealChallenge(pool: Pool, viewer: Viewer, number: string): Promise<SelfRevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; namespace_id: string; visibility: "org" | "namespace"; status: string; is_anonymous: boolean; author_id: string }>(
    `select id, namespace_id, visibility, status, is_anonymous, author_id from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row || !isChallengeRowVisible(viewer, row)) return { status: "not_found" };
  if (row.author_id !== viewer.userId) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  return inTransaction(pool, async (client) => {
    await client.query(`update challenges set is_anonymous = false, updated_at = now() where id = $1`, [row.id]);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "anonymity.self_revealed",
      targetType: "challenge",
      targetId: row.id,
    });
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      row.id,
      viewer.userId,
    ]);
    const solutionRows = await fetchSolutionRows(client, row.id, viewer.userId);
    const solutions = solutionRows
      .filter((s) =>
        canSeeSolution(viewer, { namespaceId: full[0]!.namespace_id, assigneeId: full[0]!.assignee_id }, { status: s.status as SolutionStatus, authorId: s.author_id }),
      )
      .map((s) => toSolutionItem(s, viewer, { namespaceId: full[0]!.namespace_id, assigneeId: full[0]!.assignee_id }));
    return { status: "ok", challenge: toDetail(full[0]!, viewer, solutions) };
  });
}

export async function selfRevealSolution(pool: Pool, viewer: Viewer, number: string): Promise<SelfRevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; is_anonymous: boolean }>(
    `select s.id, ${SOLUTION_VISIBILITY_SELECT}, s.is_anonymous
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row || !isSolutionRowVisible(viewer, row)) return { status: "not_found" };
  if (row.author_id !== viewer.userId) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  await pool.query(`update solutions set is_anonymous = false, updated_at = now() where id = $1`, [row.id]);
  await appendAudit(pool, {
    actorUserId: viewer.userId,
    action: "anonymity.self_revealed",
    targetType: "solution",
    targetId: row.id,
  });
  return { status: "ok" };
}
