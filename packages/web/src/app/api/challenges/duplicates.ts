// Mark as duplicate (INNOBOX_SPEC.md §42): the mark itself (§42.3 checks, §42.4 transaction), its
// dry-run preview and the dialog's search over eligible originals. One `planMark` serves the preview
// and the mark, so they can never disagree about a refusal or a count; the mark runs it again inside
// its transaction with every challenge involved locked FOR UPDATE in id order. Visibility (§4.3) and
// anonymity (§9) are applied here: a refusal never names a challenge the caller cannot see, and no
// result carries an author. Event 25 is the route's, after commit (lib/notify-events).
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { Pool, PoolClient } from "pg";
import {
  DUPLICATE_CANDIDATES_MAX,
  DUPLICATE_MESSAGES,
  DUPLICATE_SIMILAR_MAX,
  canSeeChallenge,
  decideDuplicateActor,
  escapeLike,
  formatChallengeNumber,
  isAffectedOpen,
  isBarredAsAuthor,
  isOriginalStatusAllowed,
  isReviewEnforcer,
  isVisibilityPairAllowed,
  parseOriginalNumber,
  validateDuplicateNote,
  type ChallengeStatus,
  type RoleSet,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { onMarkedDuplicate, settleDuplicateOutcomes } from "./external";
import { unpinOnStatusChange } from "./featured-unpin";
import {
  CHALLENGE_VIS_COLS,
  challengeVisibilityInput,
  findSimilarChallengeCandidates,
  isChallengeRowVisible,
  pushChallengeVisibilityConditions,
  reloadChallengeDetail,
  reviewRoles,
  type ChallengeDetail,
  type ChallengeVisibilityColumns,
  type Viewer,
} from "./store";
import { isEntityNumber } from "./validation";

/** Resolves many users' roles at once (the web tier's `resolveRolesForUser.many`) — injected so
 *  this module does not duplicate role resolution and the dbtests can pass their own. */
export type ResolveRolesMany = (userIds: readonly string[]) => Promise<Map<string, RoleSet>>;

/** The refusals of §42.3, in the §42.9 order of checks. */
export type DuplicateRefusal =
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  /** §39.5: a committee member who is an author of the duplicate. */
  | { status: "own_item" }
  | { status: "wrong_status" }
  | { status: "open_solutions" }
  /** 422 — the original or the note; `message` is the user-facing refusal. */
  | { status: "invalid"; message: string };

interface MarkRow extends ChallengeVisibilityColumns {
  number: string;
  title: string;
  description: string;
  is_anonymous: boolean;
  public_submission_id: string | null;
  affected_estimate: number | null;
  duplicate_of_id: string | null;
}

const MARK_COLS = `${CHALLENGE_VIS_COLS}, c.number::text, c.title, c.description, c.is_anonymous, c.public_submission_id,
            c.affected_estimate, c.duplicate_of_id`;

type Db = Pool | PoolClient;

async function loadByNumber(db: Db, number: string | null): Promise<MarkRow | null> {
  if (number === null || !isEntityNumber(number)) return null;
  const { rows } = await db.query<MarkRow>(`select ${MARK_COLS} from challenges c where c.number = $1`, [number]);
  return rows[0] ?? null;
}

async function loadById(db: Db, id: string): Promise<MarkRow | null> {
  const { rows } = await db.query<MarkRow>(`select ${MARK_COLS} from challenges c where c.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The duplicate side of §42.3 — rules 1–3, after the visibility and trash gates. */
async function checkDuplicate(db: Db, actor: Viewer, number: string): Promise<{ ok: true; row: MarkRow; mode: "override" | "enforced" } | { ok: false; refusal: DuplicateRefusal }> {
  const row = await loadByNumber(db, number);
  // §2.4: a challenge the caller cannot see is "not found", never "forbidden".
  if (!row || !isChallengeRowVisible(actor, row)) return { ok: false, refusal: { status: "not_found" } };
  if (row.trashed) return { ok: false, refusal: { status: "trashed" } };
  const roles = reviewRoles(actor, row.namespace_id, row.assignee_id, row.author_ids);
  const decision = decideDuplicateActor({
    status: row.status as ChallengeStatus,
    isAdmin: actor.roles.isNamespaceAdmin(row.namespace_id),
    isEnforcer: isReviewEnforcer(roles),
    barredAsAuthor: isBarredAsAuthor(roles),
  });
  if (!decision.allowed) return { ok: false, refusal: { status: decision.reason === "status" ? "wrong_status" : decision.reason } };
  const { rows: open } = await db.query<{ open: boolean }>(
    `select exists (
       select 1 from solutions s
        where s.challenge_id = $1 and s.trashed_at is null
          and s.status not in ('implemented', 'rejected', 'not_selected', 'withdrawn')) as open`,
    [row.id],
  );
  if (open[0]?.open) return { ok: false, refusal: { status: "open_solutions" } };
  return { ok: true, row, mode: decision.mode };
}

/** The original side of §42.3 — rules 4–6 — for an actor who may mark `duplicate`. */
async function checkOriginal(db: Db, actor: Viewer, duplicate: MarkRow, raw: unknown): Promise<{ ok: true; row: MarkRow } | { ok: false; refusal: DuplicateRefusal }> {
  const invalid = (message: string) => ({ ok: false as const, refusal: { status: "invalid" as const, message } });
  const number = parseOriginalNumber(raw);
  const shown = number ?? (typeof raw === "string" ? raw.replace(/\D/g, "").slice(0, 12) : "");
  const row = await loadByNumber(db, number);
  // Missing, invisible and trashed alike — the refusal must not tell them apart (invariant 2).
  if (!row || row.trashed || !isChallengeRowVisible(actor, row)) return invalid(DUPLICATE_MESSAGES.notFound(shown || "?"));
  if (row.id === duplicate.id) return invalid(DUPLICATE_MESSAGES.self);
  if (row.status === "duplicate") {
    // Name the original's own original only when the caller can see it.
    const root = row.duplicate_of_id ? await loadById(db, row.duplicate_of_id) : null;
    const rootShown = root && !root.trashed && isChallengeRowVisible(actor, root) ? root.number : null;
    return invalid(DUPLICATE_MESSAGES.originalIsDuplicate(row.number, rootShown));
  }
  if (!isOriginalStatusAllowed(row.status as ChallengeStatus)) return invalid(DUPLICATE_MESSAGES.originalStatus(row.number));
  if (!isVisibilityPairAllowed({ visibility: duplicate.visibility, namespaceId: duplicate.namespace_id }, { visibility: row.visibility, namespaceId: row.namespace_id })) {
    return invalid(DUPLICATE_MESSAGES.visibility(duplicate.number));
  }
  return { ok: true, row };
}

/** What a mark would do — §42.4 steps 2–5 — computed against the challenges as they are now. */
export interface MarkPlan {
  duplicate: MarkRow;
  original: MarkRow;
  mode: "override" | "enforced";
  note: string | null;
  /** The duplicate's followers before the move — event 25's follower route. */
  followers: string[];
  /** Step 3: the followers who can see the original. */
  movable: string[];
  /** Step 4: the marks copied to the original. */
  marksToCopy: { userId: string; headcount: number }[];
  /** Step 5: the authors' one mark, in the name of the duplicate's first author. */
  authorsMark: { userId: string; headcount: number } | null;
  /** Step 2: the challenges that point at the duplicate and will point at the original. */
  pointing: { id: string; number: string }[];
}

async function planMark(
  db: Db,
  actor: Viewer,
  number: string,
  input: { original: unknown; note: unknown },
  resolveRolesMany: ResolveRolesMany,
): Promise<{ ok: true; plan: MarkPlan } | { ok: false; refusal: DuplicateRefusal }> {
  const dup = await checkDuplicate(db, actor, number);
  if (!dup.ok) return dup;
  const orig = await checkOriginal(db, actor, dup.row, input.original);
  if (!orig.ok) return orig;
  const note = validateDuplicateNote(input.note);
  if (!note.ok) return { ok: false, refusal: { status: "invalid", message: note.error } };
  const duplicate = dup.row;
  const original = orig.row;

  // Sequential, not Promise.all: inside the mark's transaction `db` is ONE client, which must not run
  // two queries at once.
  const { rows: followerRows } = await db.query<{ user_id: string }>(
    `select user_id from follows where parent_type = 'challenge' and parent_id = $1 order by created_at`,
    [duplicate.id],
  );
  const { rows: markRows } = await db.query<{ user_id: string; headcount: number }>(
    `select user_id, headcount from challenge_affected where challenge_id = $1 and removed_at is null order by created_at`,
    [duplicate.id],
  );
  const { rows: existingRows } = await db.query<{ user_id: string }>(`select user_id from challenge_affected where challenge_id = $1`, [original.id]);
  const { rows: pointing } = await db.query<{ id: string; number: string }>(
    `select id, number::text from challenges where duplicate_of_id = $1 order by number`,
    [duplicate.id],
  );
  const followers = followerRows.map((r) => r.user_id);
  // §42.4 step 5: the authors' mark — never on an anonymous duplicate (a public mark would name its
  // author) or an external one (no author).
  const firstAuthor = !duplicate.is_anonymous && duplicate.public_submission_id === null ? (duplicate.author_ids[0] ?? null) : null;
  const people = [...new Set([...followers, ...markRows.map((m) => m.user_id), ...(firstAuthor ? [firstAuthor] : [])])];
  const roles = people.length > 0 ? await resolveRolesMany(people) : new Map<string, RoleSet>();
  const originalInput = challengeVisibilityInput(original);
  const canSeeOriginal = (userId: string): boolean => {
    const r = roles.get(userId);
    return r !== undefined && canSeeChallenge({ userId, roles: r }, originalInput);
  };

  const movable = followers.filter(canSeeOriginal);
  const marksOpen = isAffectedOpen(original.status as ChallengeStatus);
  const existing = new Set(existingRows.map((r) => r.user_id));
  const isOriginalAuthor = (userId: string) => original.author_ids.includes(userId);
  const marksToCopy = marksOpen
    ? markRows
        .filter((m) => canSeeOriginal(m.user_id) && !isOriginalAuthor(m.user_id) && !existing.has(m.user_id))
        .map((m) => ({ userId: m.user_id, headcount: m.headcount }))
    : [];
  const authorsMark =
    marksOpen &&
    firstAuthor !== null &&
    canSeeOriginal(firstAuthor) &&
    !isOriginalAuthor(firstAuthor) &&
    !existing.has(firstAuthor) &&
    !marksToCopy.some((m) => m.userId === firstAuthor)
      ? { userId: firstAuthor, headcount: duplicate.affected_estimate ?? 1 }
      : null;

  return { ok: true, plan: { duplicate, original, mode: dup.mode, note: note.value, followers, movable, marksToCopy, authorsMark, pointing } };
}

// ── The preview (§42.3 "What happens") ──────────────────────────────────────────────────

export type DuplicatePreviewResult =
  | {
      status: "ok";
      preview: {
        ok: true;
        original: string;
        followersToMove: number;
        marksToCopy: number;
        authorsMark: boolean;
        repointed: number;
        outsideSubmitter: boolean;
        hasAuthors: boolean;
      };
    }
  /** The duplicate side refused — the dialog has no business being open (404/403/409). */
  | DuplicateRefusal
  /** The pick refused — shown inline in the dialog, the button disabled. */
  | { status: "ok"; preview: { ok: false; message: string } };

export async function previewDuplicate(pool: Pool, actor: Viewer, number: string, rawOriginal: unknown, resolveRolesMany: ResolveRolesMany): Promise<DuplicatePreviewResult> {
  const planned = await planMark(pool, actor, number, { original: rawOriginal, note: null }, resolveRolesMany);
  if (!planned.ok) {
    return planned.refusal.status === "invalid" ? { status: "ok", preview: { ok: false, message: planned.refusal.message } } : planned.refusal;
  }
  const p = planned.plan;
  return {
    status: "ok",
    preview: {
      ok: true,
      original: formatChallengeNumber(p.original.number),
      followersToMove: p.movable.length,
      marksToCopy: p.marksToCopy.length,
      authorsMark: p.authorsMark !== null,
      repointed: p.pointing.length,
      outsideSubmitter: p.duplicate.public_submission_id !== null,
      hasAuthors: p.duplicate.author_ids.length > 0,
    },
  };
}

// ── The mark (§42.4) ─────────────────────────────────────────────────────────────────────

/** What event 25 (§42.6) needs once the mark has committed. */
export interface DuplicateNotice {
  duplicateId: string;
  duplicateNumber: string;
  originalId: string;
  originalNumber: string;
  originalTitle: string;
  duplicateTitle: string;
  noteIncluded: boolean;
  note: string | null;
  authorIds: string[];
  assigneeId: string | null;
  /** The follower set BEFORE the move — event 25's follower route. */
  followers: string[];
  /** Who now follows the original because their follow moved ("You now follow CH-12."). */
  moved: string[];
}

export type MarkDuplicateResult = { status: "ok"; challenge: ChallengeDetail; notice: DuplicateNotice } | DuplicateRefusal;

export async function markDuplicate(
  pool: Pool,
  actor: Viewer,
  number: string,
  input: { original: unknown; note: unknown },
  resolveRolesMany: ResolveRolesMany,
): Promise<MarkDuplicateResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  return inTransaction(pool, async (client) => {
    // Lock the duplicate, the original and everything pointing at the duplicate, in id order, so two
    // marks crossing the same pair (CH-1 → CH-2 and CH-2 → CH-1) serialize: the second re-checks and
    // finds its original already a duplicate. No chain can form.
    const originalNumber = parseOriginalNumber(input.original);
    const { rows: ids } = await client.query<{ id: string }>(
      `select c.id from challenges c where c.number = $1
       union select o.id from challenges o where $2::text is not null and o.number::text = $2
       union select p.id from challenges p join challenges d on p.duplicate_of_id = d.id where d.number = $1`,
      [number, originalNumber],
    );
    if (ids.length > 0) await client.query(`select id from challenges where id = any($1::uuid[]) order by id for update`, [ids.map((r) => r.id)]);

    const planned = await planMark(client, actor, number, input, resolveRolesMany);
    if (!planned.ok) return planned.refusal;
    const p = planned.plan;
    const d = p.duplicate;
    const o = p.original;
    const duplicateLabel = formatChallengeNumber(d.number);
    const originalLabel = formatChallengeNumber(o.number);

    // 1. The close. A Home pin goes with leaving valid (§13.2).
    await unpinOnStatusChange(client, actor.userId, d.id, "duplicate");
    await client.query(
      `update challenges set status = 'duplicate', updated_at = now(), status_changed_at = now(), duplicate_of_id = $2, duplicate_note = $3 where id = $1`,
      [d.id, o.id, p.note],
    );

    // 2. Re-pointing: no chain ever forms. Silent, one audit row each.
    if (p.pointing.length > 0) {
      await client.query(`update challenges set duplicate_of_id = $2 where id = any($1::uuid[])`, [p.pointing.map((x) => x.id), o.id]);
      for (const x of p.pointing) {
        await appendAudit(client, {
          actorUserId: actor.userId,
          action: "challenge.duplicate_repointed",
          targetType: "challenge",
          targetId: x.id,
          before: { duplicateOf: duplicateLabel },
          after: { duplicateOf: originalLabel, trigger: "chain" },
        });
      }
    }

    // 3. Follows move — only for those who can see the original; nobody new is added.
    if (p.movable.length > 0) {
      await client.query(
        `insert into follows (user_id, parent_type, parent_id) select u, 'challenge', $2 from unnest($1::uuid[]) as u on conflict do nothing`,
        [p.movable, o.id],
      );
      await client.query(`delete from follows where parent_type = 'challenge' and parent_id = $1 and user_id = any($2::uuid[])`, [d.id, p.movable]);
    }

    // 4–5. Marks: copies and the authors' mark — no event 24, no auto-follow, no affected.* row.
    const marks = [...p.marksToCopy, ...(p.authorsMark ? [p.authorsMark] : [])];
    if (marks.length > 0) {
      await client.query(
        `insert into challenge_affected (challenge_id, user_id, headcount)
         select $1, u, h from unnest($2::uuid[], $3::int[]) as t(u, h)
         on conflict (challenge_id, user_id) do nothing`,
        [o.id, marks.map((m) => m.userId), marks.map((m) => m.headcount)],
      );
    }

    // §42.6: the outside submitter — the merge mail, or the original's outcome at once when it has
    // already closed (which also settles any re-pointed duplicate still waiting for one).
    await onMarkedDuplicate(client, d.id, o.status);
    await settleDuplicateOutcomes(client, o.id, o.status);

    // 7. Audit — counts only; never the note.
    await appendAudit(client, {
      actorUserId: actor.userId,
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: d.id,
      before: { status: d.status },
      after: {
        status: "duplicate",
        override: p.mode === "override",
        trigger: "marked_duplicate",
        duplicateOf: originalLabel,
        withNote: p.note !== null,
        followersMoved: p.movable.length,
        marksCopied: p.marksToCopy.length,
        authorsMark: p.authorsMark !== null,
        repointed: p.pointing.map((x) => formatChallengeNumber(x.number)),
      },
    });

    const challenge = await reloadChallengeDetail(client, actor, d.id);
    return {
      status: "ok",
      challenge,
      notice: {
        duplicateId: d.id,
        duplicateNumber: d.number,
        duplicateTitle: d.title,
        originalId: o.id,
        originalNumber: o.number,
        originalTitle: o.title,
        noteIncluded: p.note !== null,
        note: p.note,
        authorIds: d.author_ids,
        assigneeId: d.assignee_id,
        followers: p.followers,
        moved: p.movable,
      },
    };
  });
}

// ── The dialog's search (§42.3 "Original") ───────────────────────────────────────────────

export interface DuplicateCandidate {
  number: string;
  title: string;
  status: ChallengeStatus;
  namespace: string;
}

export type DuplicateCandidatesResult = { status: "ok"; similar: boolean; candidates: DuplicateCandidate[] } | DuplicateRefusal;

/** §42.3 rules 4–6 as SQL over `challenges o` for the duplicate `d`: visible to the actor, not
 *  trashed, not the duplicate itself, in an original's status, and at least as visible. */
function pushEligibleOriginal(actor: Viewer, d: MarkRow, push: (v: unknown) => string, conditions: string[]): void {
  pushChallengeVisibilityConditions(actor, push, conditions, "o");
  conditions.push(`o.id <> ${push(d.id)}`);
  conditions.push(`o.status in ('in_review', 'needs_improvement', 'meeting_scheduled', 'valid', 'solved', 'rejected')`);
  conditions.push(
    d.visibility === "namespace" ? `(o.visibility = 'org' or (o.visibility = 'namespace' and o.namespace_id = ${push(d.namespace_id)}))` : `o.visibility = 'org'`,
  );
}

/**
 * The dialog's search: up to 10 eligible originals matching `q` (a number or title words), or —
 * before anything is typed — up to 5 similar ones, the §6.1 ranking run on the duplicate's own
 * title and description. No author is returned, so nothing needs masking.
 */
export async function duplicateCandidates(pool: Pool, actor: Viewer, number: string, rawQuery: unknown): Promise<DuplicateCandidatesResult> {
  const dup = await checkDuplicate(pool, actor, number);
  if (!dup.ok) return dup.refusal;
  const d = dup.row;
  const q = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 200) : "";
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  pushEligibleOriginal(actor, d, push, conditions);

  if (q === "") {
    const similar = await findSimilarChallengeCandidates(pool, actor, { title: d.title, description: d.description }, DUPLICATE_SIMILAR_MAX * 3);
    const numbers = similar.map((s) => s.number.replace(/\D/g, ""));
    if (numbers.length === 0) return { status: "ok", similar: true, candidates: [] };
    conditions.push(`o.number::text = any(${push(numbers)}::text[])`);
    const { rows } = await pool.query<{ number: string; title: string; status: ChallengeStatus; namespace: string }>(
      `select o.number::text, o.title, o.status, ns.slug as namespace
         from challenges o join namespaces ns on ns.id = o.namespace_id
        where ${conditions.join(" and ")}`,
      params,
    );
    const byNumber = new Map(rows.map((r) => [r.number, r]));
    const ranked = numbers.map((n) => byNumber.get(n)).filter((r) => r !== undefined);
    return {
      status: "ok",
      similar: true,
      candidates: ranked.slice(0, DUPLICATE_SIMILAR_MAX).map((r) => ({ number: formatChallengeNumber(r.number), title: r.title, status: r.status, namespace: r.namespace })),
    };
  }

  const asNumber = parseOriginalNumber(q);
  const titleMatch = `o.title ilike ${push(`%${escapeLike(q)}%`)}`;
  const numberParam = asNumber === null ? null : push(asNumber);
  conditions.push(numberParam ? `(o.number::text = ${numberParam} or ${titleMatch})` : titleMatch);
  const { rows } = await pool.query<{ number: string; title: string; status: ChallengeStatus; namespace: string }>(
    `select o.number::text, o.title, o.status, ns.slug as namespace
       from challenges o join namespaces ns on ns.id = o.namespace_id
      where ${conditions.join(" and ")}
      order by ${numberParam ? `(o.number::text = ${numberParam}) desc, ` : ""}o.created_at desc
      limit ${DUPLICATE_CANDIDATES_MAX}`,
    params,
  );
  return {
    status: "ok",
    similar: false,
    candidates: rows.map((r) => ({ number: formatChallengeNumber(r.number), title: r.title, status: r.status, namespace: r.namespace })),
  };
}
