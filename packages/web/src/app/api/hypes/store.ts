// Data layer for §26 hype (INNOBOX_SPEC.md §26): giving a hype (POST /api/hypes), the per-viewer
// hype fields on the challenge detail payload, the gallery/featured hype number, and the Home
// "Hyped this week" board. The pure rules — the week, the budget, the weight, eligibility — live
// in @innobox/shared (hype.ts); this module only reads and writes.
//
// Visibility (invariant 2): every read here is either scoped to an item the caller already proved
// the viewer can see (the detail decorator, the give path's getParentAccess) or filtered by the
// full §4.3 SQL predicate (the board). Nothing counts or ranks across items the viewer cannot see.
// Anonymity (invariant 3): hypers are real names by design; the item's author stays masked.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool, PoolClient } from "pg";
import {
  HYPE_BOARD_SIZE,
  decideHype,
  formatChallengeNumber,
  formatSolutionNumber,
  hypeWeight,
  hypesLeft,
  isChallengeHypeOpen,
  isEarlyHype,
  isSolutionHypeOpen,
  maskAuthor,
  nextWeekStartUtc,
  weekStartUtc,
  type ChallengeStatus,
  type HypeReason,
  type HypeWeight,
  type MaskedAuthor,
  type SolutionStatus,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { awardHypeReceived } from "../../../lib/gamification";
import {
  getParentAccess,
  pushChallengeVisibilityConditions,
  pushSolutionVisibilityConditions,
  type ChallengeDetail,
  type SolutionListItem,
  type Viewer,
} from "../challenges/store";

type Db = Pool | PoolClient;
type ParentType = "challenge" | "solution";

/** A person who hyped an item — public by design (§26 decision 8). */
export interface Hyper {
  id: string;
  displayName: string;
  deactivated: boolean;
  scrubbed: boolean;
}

/** The per-item hype fields on the detail payload (§26.11). */
export interface HypeItemFields {
  /** All-time hype points (sum of weights). */
  hype: number;
  hyped: boolean;
  canHype: boolean;
  hypeReason: HypeReason;
  /** A hype given now counts double (the item is under a week old) — drives the tooltip. */
  hypeEarly: boolean;
  /** Newest first. */
  hypers: Hyper[];
}

/** The viewer's budget, carried once on the detail payload. */
export interface HypeViewerFields {
  hypesLeft: number;
  /** Next Monday 00:00 UTC, ISO. */
  weekResetsAt: string;
}

export type HypedSolution = SolutionListItem & HypeItemFields;
export type HypedChallengeDetail = Omit<ChallengeDetail, "solutions"> & HypeItemFields & HypeViewerFields & { solutions: HypedSolution[] };

/** The database's clock — the week boundary, the weight and created_at all read the same one. */
async function dbNow(db: Db): Promise<Date> {
  const { rows } = await db.query<{ now: Date }>(`select now() as now`);
  return rows[0]!.now;
}

/** Hypes the person has given since this week's Monday 00:00 UTC (§26.2). */
export async function hypesUsedThisWeek(db: Db, userId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from hypes where user_id = $1 and created_at >= $2`, [
    userId,
    weekStartUtc(now),
  ]);
  return rows[0]?.n ?? 0;
}

/** The viewer's budget block (§26.11) — for `me` and the Home board. */
export async function viewerHypeBudget(db: Db, userId: string): Promise<HypeViewerFields> {
  const now = await dbNow(db);
  return { hypesLeft: hypesLeft(await hypesUsedThisWeek(db, userId, now)), weekResetsAt: nextWeekStartUtc(now).toISOString() };
}

interface ItemHypeState {
  points: number;
  hyped: boolean;
  hypers: Hyper[];
}

/** Points, the viewer's own hype and the hypers list for a set of items, in two queries. */
async function loadHypeState(db: Db, viewerId: string, challengeIds: string[], solutionIds: string[]): Promise<Map<string, ItemHypeState>> {
  const match = `((h.parent_type = 'challenge' and h.parent_id = any($1::uuid[])) or (h.parent_type = 'solution' and h.parent_id = any($2::uuid[])))`;
  const { rows } = await db.query<{
    parent_type: ParentType;
    parent_id: string;
    user_id: string;
    weight: number;
    display_name: string;
    active: boolean;
    scrubbed: boolean;
  }>(
    `select h.parent_type, h.parent_id, h.user_id, h.weight, u.display_name, u.active, u.scrubbed_at is not null as scrubbed
       from hypes h join users u on u.id = h.user_id
      where ${match}
      order by h.created_at desc, h.id desc`,
    [challengeIds, solutionIds],
  );
  const out = new Map<string, ItemHypeState>();
  for (const r of rows) {
    const key = `${r.parent_type}:${r.parent_id}`;
    const state = out.get(key) ?? { points: 0, hyped: false, hypers: [] };
    state.points += r.weight;
    if (r.user_id === viewerId) state.hyped = true;
    state.hypers.push({ id: r.user_id, displayName: r.display_name, deactivated: !r.active, scrubbed: r.scrubbed });
    out.set(key, state);
  }
  return out;
}

/**
 * §26.3/§26.11: adds the hype fields to a challenge detail the viewer is already allowed to see —
 * on the challenge and on each listed solution — plus the viewer's budget. Only the GET detail
 * route calls this, and only while hype is on; MCP and search never see these fields.
 */
export async function decorateDetailWithHype(db: Db, viewer: Viewer, detail: ChallengeDetail): Promise<HypedChallengeDetail> {
  const now = await dbNow(db);
  const [state, used] = await Promise.all([
    loadHypeState(
      db,
      viewer.userId,
      [detail.id],
      detail.solutions.map((s) => s.id),
    ),
    hypesUsedThisWeek(db, viewer.userId, now),
  ]);
  const challengeTrashed = Boolean(detail.trashed);
  const fields = (key: string, open: boolean, isAuthor: boolean, createdAt: string): HypeItemFields => {
    const s = state.get(key) ?? { points: 0, hyped: false, hypers: [] };
    const decision = decideHype({ open, isAuthor, alreadyHyped: s.hyped, usedThisWeek: used });
    return {
      hype: s.points,
      hyped: s.hyped,
      canHype: decision.canHype,
      hypeReason: decision.reason,
      hypeEarly: isEarlyHype(new Date(createdAt), now),
      hypers: s.hypers,
    };
  };
  const challengeOpen = !challengeTrashed && isChallengeHypeOpen(detail.status);
  return {
    ...detail,
    ...fields(`challenge:${detail.id}`, challengeOpen, detail.isMine, detail.createdAt),
    hypesLeft: hypesLeft(used),
    weekResetsAt: nextWeekStartUtc(now).toISOString(),
    solutions: detail.solutions.map((s) => ({
      ...s,
      ...fields(
        `solution:${s.id}`,
        !challengeTrashed && !s.trashed && isSolutionHypeOpen(s.status, detail.status),
        s.isMine,
        s.createdAt,
      ),
    })),
  };
}

// ── Giving a hype (POST /api/hypes) ─────────────────────────────────────────────────────

export type GiveHypeResult =
  | { status: "ok"; hype: number; hypesLeft: number; hypers: Hyper[]; weight: HypeWeight }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "refused"; reason: Exclude<HypeReason, null> };

/**
 * One hype, in one transaction (§26.2–§26.4): a per-person advisory lock serializes the budget
 * check and the insert, so two concurrent requests can never both spend the last hype; the item
 * row is read FOR SHARE so a concurrent close cannot slip past the open check; the unique key
 * turns any remaining race into a refusal, never a second row. The audit row comes before the
 * award (the shared lock order: audit chain, then the recipient's award lock).
 */
export async function giveHype(pool: Pool, viewer: Viewer, parentType: ParentType, parentId: string): Promise<GiveHypeResult> {
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access !== "live") return { status: access };

  return inTransaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`hype:${viewer.userId}`]);
    const now = await dbNow(client);
    const { rows } = await client.query<{ status: string; author_id: string | null; created_at: Date; challenge_status: string }>(
      parentType === "challenge"
        ? `select c.status, c.author_id, c.created_at, c.status as challenge_status from challenges c where c.id = $1 for share`
        : `select s.status, s.author_id, s.created_at, c.status as challenge_status
             from solutions s join challenges c on c.id = s.challenge_id where s.id = $1 for share of s, c`,
      [parentId],
    );
    const item = rows[0];
    if (!item) return { status: "not_found" } as const;
    const open =
      parentType === "challenge"
        ? isChallengeHypeOpen(item.status as ChallengeStatus)
        : isSolutionHypeOpen(item.status as SolutionStatus, item.challenge_status as ChallengeStatus);
    const { rows: mine } = await client.query(`select 1 from hypes where user_id = $1 and parent_type = $2 and parent_id = $3`, [
      viewer.userId,
      parentType,
      parentId,
    ]);
    const used = await hypesUsedThisWeek(client, viewer.userId, now);
    const decision = decideHype({ open, isAuthor: item.author_id === viewer.userId, alreadyHyped: mine.length > 0, usedThisWeek: used });
    if (decision.reason) return { status: "refused", reason: decision.reason } as const;

    const weight = hypeWeight(item.created_at, now);
    const inserted = await client.query(
      `insert into hypes (user_id, parent_type, parent_id, weight) values ($1, $2, $3, $4)
       on conflict (user_id, parent_type, parent_id) do nothing returning id`,
      [viewer.userId, parentType, parentId, weight],
    );
    if ((inserted.rowCount ?? 0) === 0) return { status: "refused", reason: "hyped" } as const;
    await appendAudit(client, { actorUserId: viewer.userId, action: "hype.given", targetType: parentType, targetId: parentId, after: { weight } });
    await awardHypeReceived(client, parentType, parentId, viewer.userId);

    const state = (await loadHypeState(client, viewer.userId, parentType === "challenge" ? [parentId] : [], parentType === "solution" ? [parentId] : [])).get(
      `${parentType}:${parentId}`,
    );
    return { status: "ok", hype: state?.points ?? weight, hypesLeft: hypesLeft(used + 1), hypers: state?.hypers ?? [], weight } as const;
  });
}

// ── The gallery number and sort (§26.5) ─────────────────────────────────────────────────

/** All-time hype points per challenge, for the gallery and the Featured cards. */
export async function challengeHypePoints(db: Db, challengeIds: string[]): Promise<Map<string, number>> {
  if (challengeIds.length === 0) return new Map();
  const { rows } = await db.query<{ parent_id: string; points: number }>(
    `select parent_id, sum(weight)::int as points from hypes where parent_type = 'challenge' and parent_id = any($1::uuid[]) group by parent_id`,
    [challengeIds],
  );
  return new Map(rows.map((r) => [r.parent_id, r.points]));
}

/** Adds `hype` to list items (a gallery page or the Featured cards). */
export async function withHypePoints<T extends { id: string }>(db: Db, items: T[]): Promise<(T & { hype: number })[]> {
  const points = await challengeHypePoints(
    db,
    items.map((i) => i.id),
  );
  return items.map((i) => ({ ...i, hype: points.get(i.id) ?? 0 }));
}

// ── The Home board: "Hyped this week" (§26.5) ───────────────────────────────────────────

export interface HypedBoardItem {
  type: ParentType;
  number: string; // CH-12 / SOL-34
  /** The challenge's title, or the solution's first 120 characters. */
  title: string;
  /** A solution's parent challenge title (muted under the row). */
  parentTitle?: string;
  /** The challenge the row links to (itself, or a solution's parent). */
  challengeNumber: string;
  author: MaskedAuthor;
  status: ChallengeStatus | SolutionStatus;
  /** This week's hype points. */
  points: number;
}

export interface HypedBoard {
  weekStart: string;
  hypesLeft: number;
  items: HypedBoardItem[];
}

const OPEN_CHALLENGE_SQL = `('in_review','needs_improvement','meeting_scheduled','valid')`;
const OPEN_SOLUTION_SQL = `('proposed','in_review','needs_improvement','valid','accepted_internally','waiting_for_resources','in_implementation','external_acceptance')`;

/**
 * The top HYPE_BOARD_SIZE open items by this week's hype points, ties to the earliest hype of the
 * week. Each half applies the full §4.3 predicate per viewer — the one the gallery uses — and for a
 * solution its parent's too, including the `proposed` narrowing. Nothing about hidden items (a
 * count, a rank, "N more") is ever returned.
 */
export async function getHypedBoard(db: Db, viewer: Viewer): Promise<HypedBoard> {
  const now = await dbNow(db);
  const weekStart = weekStartUtc(now);

  const ch = queryParams();
  const chConditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, ch.push, chConditions);
  chConditions.push(`c.status in ${OPEN_CHALLENGE_SQL}`);
  const weekParam = ch.push(weekStart);
  const { rows: challengeRows } = await db.query<{
    number: string;
    title: string;
    status: ChallengeStatus;
    is_anonymous: boolean;
    author_id: string | null;
    author_display_name: string | null;
    author_active: boolean | null;
    author_scrubbed: boolean | null;
    external_company: string | null;
    points: number;
    first_at: Date;
  }>(
    `select c.number::text, c.title, c.status, c.is_anonymous, c.author_id, u.display_name as author_display_name,
            u.active as author_active, u.scrubbed_at is not null as author_scrubbed, ps.company as external_company,
            hw.points, hw.first_at
       from (select parent_id, sum(weight)::int as points, min(created_at) as first_at
               from hypes where parent_type = 'challenge' and created_at >= ${weekParam} group by parent_id) hw
       join challenges c on c.id = hw.parent_id
       left join users u on u.id = c.author_id
       left join public_submissions ps on ps.id = c.public_submission_id
      where ${chConditions.join(" and ")}
      order by hw.points desc, hw.first_at asc
      limit ${HYPE_BOARD_SIZE}`,
    ch.params,
  );

  const so = queryParams();
  const soConditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, so.push, soConditions);
  pushSolutionVisibilityConditions(viewer, so.push, soConditions);
  soConditions.push(`c.status in ${OPEN_CHALLENGE_SQL}`, `s.status in ${OPEN_SOLUTION_SQL}`);
  const soWeek = so.push(weekStart);
  const { rows: solutionRows } = await db.query<{
    number: string;
    description: string;
    status: SolutionStatus;
    is_anonymous: boolean;
    author_id: string;
    author_display_name: string;
    author_active: boolean;
    author_scrubbed: boolean;
    challenge_number: string;
    challenge_title: string;
    points: number;
    first_at: Date;
  }>(
    `select s.number::text, s.description, s.status, s.is_anonymous, s.author_id, u.display_name as author_display_name,
            u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
            c.number::text as challenge_number, c.title as challenge_title, hw.points, hw.first_at
       from (select parent_id, sum(weight)::int as points, min(created_at) as first_at
               from hypes where parent_type = 'solution' and created_at >= ${soWeek} group by parent_id) hw
       join solutions s on s.id = hw.parent_id
       join challenges c on c.id = s.challenge_id
       join users u on u.id = s.author_id
      where ${soConditions.join(" and ")}
      order by hw.points desc, hw.first_at asc
      limit ${HYPE_BOARD_SIZE}`,
    so.params,
  );

  const ranked: { item: HypedBoardItem; firstAt: number }[] = [
    ...challengeRows.map((r) => ({
      firstAt: r.first_at.getTime(),
      item: {
        type: "challenge" as const,
        number: formatChallengeNumber(r.number),
        title: r.title,
        challengeNumber: formatChallengeNumber(r.number),
        author: maskAuthor({
          isAnonymous: r.is_anonymous,
          authorId: r.author_id,
          authorDisplayName: r.author_display_name,
          authorActive: r.author_active,
          authorScrubbed: r.author_scrubbed,
          externalCompany: r.external_company,
        }),
        status: r.status,
        points: r.points,
      },
    })),
    ...solutionRows.map((r) => ({
      firstAt: r.first_at.getTime(),
      item: {
        type: "solution" as const,
        number: formatSolutionNumber(r.number),
        title: excerpt(r.description, 120),
        parentTitle: r.challenge_title,
        challengeNumber: formatChallengeNumber(r.challenge_number),
        author: maskAuthor({
          isAnonymous: r.is_anonymous,
          authorId: r.author_id,
          authorDisplayName: r.author_display_name,
          authorActive: r.author_active,
          authorScrubbed: r.author_scrubbed,
        }),
        status: r.status,
        points: r.points,
      },
    })),
  ];
  ranked.sort((a, b) => b.item.points - a.item.points || a.firstAt - b.firstAt);
  return {
    weekStart: weekStart.toISOString(),
    hypesLeft: hypesLeft(await hypesUsedThisWeek(db, viewer.userId, now)),
    items: ranked.slice(0, HYPE_BOARD_SIZE).map((r) => r.item),
  };
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
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
