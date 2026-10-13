// Discussion summary (INNOBOX_SPEC.md §22.13): an on-demand summary of a challenge's or solution's
// comment thread, for any viewer who can see the item, once the thread holds at least 10 visible
// comments. One cached result per thread state (a hash of the title and the included comments);
// a new or edited comment makes it stale. The result inherits its item's visibility (only readers
// of the item reach it) and lifecycle (the §10.3 cascade; a withdrawn item gets none).
//
// Egress: the item's title and the comments' TEXT only, in §10.2 thread order (each reply marked
// with the participant it answers), each commenter replaced by
// "Participant A", "Participant B" … by first appearance — never a name, and never which one wrote
// the item. Soft-deleted comments are excluded. retry: false; 10 a minute and 50 a rolling day
// per person, counted from ai_usage. Serving a current cached summary costs nothing.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { canSeeChallenge, canSeeSolution, threadOrder, type ChallengeStatus, type SolutionStatus } from "@innobox/shared";
import {
  AI_SETTING_KEYS,
  DISCUSSION_LIMITS,
  DISCUSSION_MIN_COMMENTS,
  aiFeatureSwitchKey,
  aiUserLimitHit,
  buildDiscussionPrompt,
  countAiUserCalls,
  isAiError,
  processDiscussionSummary,
  pseudonymizeComments,
  readAiSwitch,
  type AiClient,
  type DiscussionSummary,
} from "@innobox/shared/ai";
import type { Viewer } from "../../challenges/store";

export const SUMMARY_FEATURE = "discussion_summary";

export type SummaryParentType = "challenge" | "solution";

interface Item {
  id: string;
  title: string;
  withdrawn: boolean;
  restricted: boolean;
}

/** The item, when `viewer` can see it (else null — answered as 404). `"trashed"` when it is in
 *  the trash (§10.4) and the viewer is a platform admin — the only one who can see it there: AI
 *  tasks drop out, and a request to run one is refused with 409. */
async function loadItem(pool: Pool, viewer: Viewer, parentType: SummaryParentType, number: string): Promise<Item | "trashed" | null> {
  if (parentType === "challenge") {
    const { rows } = await pool.query<{ id: string; title: string; status: string; visibility: "org" | "namespace"; namespace_id: string; author_id: string; trashed: boolean }>(
      `select id, title, status, visibility, namespace_id, author_id, trashed_at is not null as trashed from challenges where number = $1`,
      [number],
    );
    const c = rows[0];
    if (c?.trashed) return viewer.roles.isPlatformAdmin ? "trashed" : null; // §10.4
    if (!c || !canSeeChallenge(viewer, { namespaceId: c.namespace_id, visibility: c.visibility, status: c.status as ChallengeStatus, authorId: c.author_id, trashed: false })) return null;
    return { id: c.id, title: c.title, withdrawn: c.status === "withdrawn", restricted: c.visibility === "namespace" };
  }
  const { rows } = await pool.query<{
    id: string;
    status: string;
    author_id: string;
    c_title: string;
    c_status: string;
    c_visibility: "org" | "namespace";
    c_namespace_id: string;
    c_author_id: string;
    c_assignee_id: string | null;
    trashed: boolean;
  }>(
    `select s.id, s.status, s.author_id, c.title as c_title, c.status as c_status, c.visibility as c_visibility,
            c.namespace_id as c_namespace_id, c.author_id as c_author_id, c.assignee_id as c_assignee_id,
            (s.trashed_at is not null or c.trashed_at is not null) as trashed
       from solutions s join challenges c on c.id = s.challenge_id
      where s.number = $1`,
    [number],
  );
  const s = rows[0];
  if (!s) return null;
  if (s.trashed) return viewer.roles.isPlatformAdmin ? "trashed" : null; // §10.4: no AI task on a trashed item
  const challengeVisible = canSeeChallenge(viewer, { namespaceId: s.c_namespace_id, visibility: s.c_visibility, status: s.c_status as ChallengeStatus, authorId: s.c_author_id, trashed: false });
  if (!challengeVisible || !canSeeSolution(viewer, { namespaceId: s.c_namespace_id, assigneeId: s.c_assignee_id }, { status: s.status as SolutionStatus, authorId: s.author_id, trashed: false })) return null;
  // A solution has no title of its own: its challenge's title names what is being discussed.
  return { id: s.id, title: `A solution to: ${s.c_title}`, withdrawn: s.status === "withdrawn" || s.c_status === "withdrawn", restricted: s.c_visibility === "namespace" };
}

/** The visible comments in §10.2 thread order: each top-level comment followed by its replies. */
async function visibleComments(
  pool: Pool,
  parentType: SummaryParentType,
  parentId: string,
): Promise<{ id: string; authorId: string; body: string; replyToId: string | null }[]> {
  // The sort key keeps Postgres's full microsecond precision: a JS Date keeps only milliseconds,
  // so comments written within the same millisecond would otherwise tie and fall back to their
  // (random) ids, reordering the thread — and with it the order participants are lettered in.
  const { rows } = await pool.query<{ id: string; author_id: string; body: string; thread_root_id: string | null; reply_to_id: string | null; sort_key: string }>(
    `select id, author_id, body, thread_root_id, reply_to_id,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as sort_key
       from comments
      where parent_type = $1 and parent_id = $2 and deleted_at is null
      order by created_at asc, id asc`,
    [parentType, parentId],
  );
  const threaded = threadOrder(rows.map((row) => ({ id: row.id, threadRootId: row.thread_root_id, createdAt: row.sort_key, row })));
  return threaded.map(({ row: r }) => ({ id: r.id, authorId: r.author_id, body: r.body, replyToId: r.reply_to_id }));
}

/** One thread state: the title plus each included comment's id and text (an edit changes it). */
export function threadHash(title: string, comments: readonly { id: string; body: string }[]): string {
  const h = createHash("sha256").update("summary-v1\u001f").update(title);
  for (const c of comments) h.update("\u001e").update(c.id).update("\u001f").update(c.body);
  return h.digest("hex");
}

export interface SummaryView {
  /** The switch is on, AI is available, the item is not withdrawn, and restricted rules allow it. */
  available: boolean;
  /** At least DISCUSSION_MIN_COMMENTS visible comments. */
  eligible: boolean;
  commentCount: number;
  summary: (DiscussionSummary & { createdAt: string; stale: boolean }) | null;
}

async function effective(pool: Pool, ai: AiClient, item: Item): Promise<boolean> {
  if (item.withdrawn) return false;
  if (!(await readAiSwitch(pool, aiFeatureSwitchKey(SUMMARY_FEATURE)))) return false;
  if (!(await ai.available(SUMMARY_FEATURE))) return false;
  if (item.restricted && !(await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent))) return false;
  return true;
}

export async function getSummary(pool: Pool, ai: AiClient, viewer: Viewer, parentType: SummaryParentType, number: string): Promise<SummaryView | null> {
  const item = await loadItem(pool, viewer, parentType, number);
  if (!item || item === "trashed") return null;
  const comments = await visibleComments(pool, parentType, item.id);
  const { rows } = await pool.query<{ input_hash: string | null; payload: DiscussionSummary | null; updated_at: Date }>(
    `select input_hash, payload, updated_at from ai_results where kind = $1 and parent_type = $2 and parent_id = $3 and status = 'ready'`,
    [SUMMARY_FEATURE, parentType, item.id],
  );
  const r = rows[0];
  return {
    available: await effective(pool, ai, item),
    eligible: comments.length >= DISCUSSION_MIN_COMMENTS,
    commentCount: comments.length,
    summary:
      r?.payload && !item.withdrawn
        ? { ...r.payload, createdAt: r.updated_at.toISOString(), stale: r.input_hash !== threadHash(item.title, comments) }
        : null,
  };
}

export type SummarizeOutcome =
  | { status: "ok"; summary: DiscussionSummary & { createdAt: string; stale: false }; cached: boolean }
  | { status: "not_found" | "trashed" | "unavailable" | "too_short" | "minute" | "day" | "failed" };

export async function summarize(pool: Pool, ai: AiClient, viewer: Viewer, parentType: SummaryParentType, number: string, signal?: AbortSignal): Promise<SummarizeOutcome> {
  const item = await loadItem(pool, viewer, parentType, number);
  if (!item) return { status: "not_found" };
  if (item === "trashed") return { status: "trashed" };
  if (!(await effective(pool, ai, item))) return { status: "unavailable" };
  const comments = await visibleComments(pool, parentType, item.id);
  if (comments.length < DISCUSSION_MIN_COMMENTS) return { status: "too_short" };
  const hash = threadHash(item.title, comments);

  // A current summary is served as it is — no call, nothing counted against the limits.
  const { rows: cached } = await pool.query<{ payload: DiscussionSummary; updated_at: Date }>(
    `select payload, updated_at from ai_results
      where kind = $1 and parent_type = $2 and parent_id = $3 and status = 'ready' and input_hash = $4 and payload is not null`,
    [SUMMARY_FEATURE, parentType, item.id, hash],
  );
  if (cached[0]) return { status: "ok", summary: { ...cached[0].payload, createdAt: cached[0].updated_at.toISOString(), stale: false }, cached: true };

  const hit = aiUserLimitHit(await countAiUserCalls(pool, viewer.userId, SUMMARY_FEATURE), DISCUSSION_LIMITS);
  if (hit) return { status: hit };

  const prompt = buildDiscussionPrompt({ title: item.title, comments: pseudonymizeComments(comments) });
  try {
    const result = await ai.complete({
      feature: SUMMARY_FEATURE,
      userId: viewer.userId,
      system: prompt.system,
      messages: prompt.messages,
      json: true,
      retry: false,
      signal,
      restrictedContent: item.restricted,
    });
    const summary = processDiscussionSummary(result.json);
    if (!summary) return { status: "failed" };
    const { rows } = await pool.query<{ updated_at: Date }>(
      `insert into ai_results (kind, parent_type, parent_id, input_hash, model, status, payload, requested_by)
       values ($1, $2, $3, $4, $5, 'ready', $6, $7)
       on conflict (kind, parent_type, parent_id)
       do update set input_hash = excluded.input_hash, model = excluded.model, status = 'ready', payload = excluded.payload,
                     error_code = null, requested_by = excluded.requested_by, updated_at = now()
       returning updated_at`,
      [SUMMARY_FEATURE, parentType, item.id, hash, result.model, JSON.stringify(summary), viewer.userId],
    );
    return { status: "ok", summary: { ...summary, createdAt: rows[0]!.updated_at.toISOString(), stale: false }, cached: false };
  } catch (err) {
    if (isAiError(err) && (err.code === "ai_disabled" || err.code === "ai_restricted_content" || err.code === "ai_not_configured")) return { status: "unavailable" };
    return { status: "failed" };
  }
}
