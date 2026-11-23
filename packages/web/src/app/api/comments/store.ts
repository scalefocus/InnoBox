// Data layer for /api/comments (INNOBOX_SPEC.md §10.2). Comments are never anonymous (§9) —
// the real author always shows. Visibility mirrors the parent challenge/solution (§4.3).
// Deleted comments (self or moderator) always render as "Comment removed by a moderator",
// preserving thread continuity, per spec. Every write is audited atomically. Replies are one level
// deep (§10.2 "Replies"): a reply files under its thread's top-level comment.
//
// §44: a comment is Markdown with mentions. `comments.body` holds STORED text — each mention a
// token carrying the person's id (§43.2) — and every record that leaves this module carries display
// text plus where each mention sits in it (`mentions`); no response carries a token. Only people who
// can read the thread right now can be mentioned, and each gets one row per comment: the marker that
// they have had their one notice (event 27, written by the routes after the commit).
import type { Pool, PoolClient } from "pg";
import {
  bindMentions,
  canEditOwnComment,
  mentionedUserIds,
  resolveReplyTarget,
  validateCommentBody,
  viaAgentOf,
  type MentionCandidate,
  type ViaAgent,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { awardCommentPosted } from "../../../lib/gamification";
import {
  CommentMentionCapError,
  addCommentMentionRows,
  areEligibleForMention,
  commentMentionRoomFor,
  commentMentionRowUserIds,
  currentMentionCandidates,
  lockMentionSaver,
  serializeCommentBodies,
  type CommentMentionView,
} from "../../../lib/mentions";
import { deleteCommentMentionNotifications } from "../../../lib/notify";
import {
  agentAuditFields,
  getParentAccess,
  getParentNamespaceId,
  loadParentVisibility,
  parentAccessFor,
  type AgentSource,
  type ResolveAssigneeRoles,
  type Viewer,
} from "../challenges/store";
import { isUuid } from "./validation";

const MODERATION_PLACEHOLDER = "Comment removed by a moderator";

export interface CommentRecord {
  id: string;
  parentType: "challenge" | "solution";
  parentId: string;
  authorId: string;
  authorDisplayName: string;
  /** §13.6: the author's `users.active` — false renders the greyed bubble. Comments are never
   *  anonymous (§9), so this discloses nothing the name doesn't already. */
  authorActive: boolean;
  /** §13.6: the author is GDPR-scrubbed — the bubble renders "Deleted User" from this flag. */
  authorScrubbed: boolean;
  /** §44.5: display text — the Markdown as written, each mention as `@` and the person's name. */
  body: string;
  /** §44.10: where each mention sits in `body` and whom it names; empty on a removed comment. */
  mentions: CommentMentionView[];
  /** §44.10: the room under the per-comment cap, on a comment the viewer may edit; null otherwise. */
  mentionsLeft: number | null;
  /** §10.2: the top-level comment this reply belongs to; null on a top-level comment. */
  threadRootId: string | null;
  /** §10.2: the comment this reply answers (the root, or another reply in the thread). */
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  isMine: boolean;
  canEdit: boolean;
  canModerate: boolean;
  /** §4.2: the comment's author is a committee member of the item's namespace → show a badge. */
  authorIsCommittee: boolean;
  /** §25.8 "via agent": comments are never anonymous, so the client name always shows. */
  viaAgent: ViaAgent;
}

interface CommentRow {
  id: string;
  parent_type: "challenge" | "solution";
  parent_id: string;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  author_scrubbed: boolean;
  /** Stored text as read; display text once `serializeCommentBodies` has run over the row. */
  body: string;
  /** Set by `serializeCommentBodies` — never on a removed comment's row. */
  mentions?: CommentMentionView[];
  thread_root_id: string | null;
  reply_to_id: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  mcp_client_name: string | null;
}

function toRecord(row: CommentRow, viewer: Viewer, isNamespaceAdmin: boolean, authorIsCommittee: boolean): CommentRecord {
  const deleted = row.deleted_at !== null;
  const now = new Date();
  return {
    authorIsCommittee,
    id: row.id,
    parentType: row.parent_type,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorDisplayName: row.author_display_name,
    authorActive: row.author_active,
    authorScrubbed: row.author_scrubbed,
    // §44.7: a removed comment shows its placeholder only — none of its text, links or mentions.
    body: deleted ? MODERATION_PLACEHOLDER : row.body,
    mentions: deleted ? [] : (row.mentions ?? []),
    mentionsLeft: null,
    threadRootId: row.thread_root_id,
    replyToId: row.reply_to_id,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    deleted,
    isMine: viewer.userId === row.author_id,
    canEdit: !deleted && canEditOwnComment({ authorId: row.author_id, createdAt: row.created_at }, viewer.userId, now),
    canModerate: !deleted && (isNamespaceAdmin || (viewer.userId === row.author_id && canEditOwnComment({ authorId: row.author_id, createdAt: row.created_at }, viewer.userId, now))),
    viaAgent: viaAgentOf(row.mcp_client_name, false),
  };
}

/** User ids that are committee members of the namespace (§4.2) — for the comment badge. */
async function committeeMemberIds(pool: Pool, namespaceId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
      where rm.role = 'committee' and rm.namespace_id = $1`,
    [namespaceId],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** A thread as the list returns it: its comments, and the viewer's room under the daily mention cap
 *  — one budget across solution text and comments (§44.10). */
export interface CommentList {
  comments: CommentRecord[];
  mentionsLeftToday: number;
}

export async function listComments(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<CommentList | null> {
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access === "not_found") return null;
  const namespaceId = await getParentNamespaceId(pool, parentType, parentId);
  const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
  const committee = namespaceId !== null ? await committeeMemberIds(pool, namespaceId) : new Set<string>();
  const { rows } = await pool.query<CommentRow>(
    `select c.id, c.parent_type, c.parent_id, c.author_id, u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
            c.body, c.thread_root_id, c.reply_to_id, c.created_at, c.edited_at, c.deleted_at, c.mcp_client_name
       from comments c
       join users u on u.id = c.author_id
      where c.parent_type = $1 and c.parent_id = $2
      order by c.created_at asc, c.id asc`,
    [parentType, parentId],
  );
  // §44.5: stored text → display text with its mention ranges. A removed comment is never read.
  await serializeCommentBodies(
    pool,
    rows.filter((r) => r.deleted_at === null),
  );
  // §10.4: the thread of a trashed item is read-only — nobody edits or removes a comment there.
  const records = rows
    .map((r) => toRecord(r, viewer, isNamespaceAdmin, committee.has(r.author_id)))
    .map((r) => (access === "trashed" ? { ...r, canEdit: false, canModerate: false } : r));
  const room = await commentMentionRoomFor(
    pool,
    viewer.userId,
    records.filter((r) => r.canEdit).map((r) => r.id),
  );
  return {
    comments: records.map((r) => (r.canEdit ? { ...r, mentionsLeft: room.left.get(r.id) ?? null } : r)),
    mentionsLeftToday: room.leftToday,
  };
}

/** §44.5: the mentions a comment save names — the box's list, each with the name as it stands in
 *  the text — and the role resolver for the eligibility check (invariant 1). `candidates: null` is
 *  "no list": a create then has no mentions (an agent's `post_comment`), an edit binds the current
 *  ones. */
export interface CommentSaveMentions {
  candidates: MentionCandidate[] | null;
  resolveRoles: ResolveAssigneeRoles;
}

/**
 * §44.5: whether every one of `userIds` may be given a NEW mention row on this thread — an active,
 * not-erased person with a name, who is not the commenter and can READ THE THREAD right now: the
 * item's full §4.3 predicate with their own roles, which for a solution narrows while it is
 * `proposed` to its team, the challenge's assignee, the namespace's committee and admins, and
 * platform admins. Nobody waits, so no notice can reveal a hidden solution (§44 decision 8).
 */
async function canAllReadThread(
  db: Pool | PoolClient,
  userIds: readonly string[],
  commenterId: string,
  parentType: "challenge" | "solution",
  parentId: string,
  resolveRoles: ResolveAssigneeRoles,
): Promise<boolean> {
  if (userIds.length === 0) return true;
  const parent = await loadParentVisibility(db, parentType, parentId);
  return areEligibleForMention(db, userIds, commenterId, async (userId) => parentAccessFor({ userId, roles: await resolveRoles(userId) }, parent) === "live");
}

/** One comment as a record, read back inside the transaction that wrote it: display text, its
 *  mention ranges, and the room left under the per-comment cap. */
async function readRecord(client: PoolClient, viewer: Viewer, commentId: string, parentType: "challenge" | "solution", parentId: string): Promise<CommentRecord> {
  const namespaceId = await getParentNamespaceId(client, parentType, parentId);
  const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
  const { rows } = await client.query<CommentRow>(
    `select c.id, c.parent_type, c.parent_id, c.author_id, u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
            c.body, c.thread_root_id, c.reply_to_id, c.created_at, c.edited_at, c.deleted_at, c.mcp_client_name
       from comments c join users u on u.id = c.author_id where c.id = $1`,
    [commentId],
  );
  await serializeCommentBodies(client, rows);
  // The record's author is the viewer (only the owner creates or edits), so the badge is theirs.
  const record = toRecord(rows[0]!, viewer, isNamespaceAdmin, namespaceId !== null && viewer.roles.isCommittee(namespaceId));
  if (!record.canEdit) return record;
  const room = await commentMentionRoomFor(client, viewer.userId, [commentId]);
  return { ...record, mentionsLeft: room.left.get(commentId) ?? null };
}

export type CreateCommentResult =
  /** `replyToAuthorId` (§10.2): who wrote the comment answered — null on a top-level comment.
   *  `mentioned` (§44.5): the people this save gave a mention row — event 27's recipients. */
  | { status: "ok"; comment: CommentRecord; replyToAuthorId: string | null; mentioned: string[] }
  | { status: "not_found" }
  /** §10.4: the item is in the trash (only a platform admin can see it there) — answered as 409. */
  | { status: "trashed" }
  /** §10.2 / §42.5: the item is a duplicate, or a solution under one — no new comment or reply (409). */
  | { status: "closed" }
  | { status: "invalid"; error: string }
  /** §10.2: the reply target is missing, on another item, or soft-deleted — answered as 422. */
  | { status: "unprocessable"; error: string }
  /** §44.5: a mentioned person cannot be mentioned in this comment — one answer for every reason (422). */
  | { status: "ineligible_mention" }
  /** §44.5: the per-comment cap or the shared daily cap (409). Nothing was written. */
  | { status: "mention_cap"; reason: "comment_cap" | "daily_cap" };

/** §10.2 / §42.5: comments close on a duplicate and on every solution under it. */
async function isCommentingClosed(db: Pool | PoolClient, parentType: "challenge" | "solution", parentId: string): Promise<boolean> {
  const { rows } = await db.query<{ status: string }>(
    parentType === "challenge"
      ? `select c.status from challenges c where c.id = $1`
      : `select c.status from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  return rows[0]?.status === "duplicate";
}

interface ReplyTargetRow {
  id: string;
  parent_type: "challenge" | "solution";
  parent_id: string;
  author_id: string;
  thread_root_id: string | null;
  deleted_at: Date | null;
}

export async function createComment(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
  rawBody: unknown,
  onCreated?: (comment: CommentRecord) => Promise<void>,
  replyTo: string | null = null,
  via?: AgentSource,
  mentions?: CommentSaveMentions,
): Promise<CreateCommentResult> {
  // The parent's visibility decides first: a reply on an item the caller can't see is a 404. A
  // trashed item takes no comment or reply (§10.4).
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access !== "live") return { status: access };
  if (await isCommentingClosed(pool, parentType, parentId)) return { status: "closed" };
  // §44.5: marks removed, line breaks normalized and the limit checked on the text as typed.
  const validated = validateCommentBody(rawBody);
  if (!validated.ok) return { status: "invalid", error: validated.error };
  // §44.5: the body as stored text. A create with no list has no mentions; everyone it names is new.
  const bound = bindMentions(validated.value, mentions?.candidates ?? []);
  // §44.5: who it mentions, checked BEFORE the transaction — the role lookups use the shared pool,
  // and holding a transaction (and the saver's lock) while waiting for another connection could
  // starve the pool under concurrent posts. One answer for every reason.
  if (bound.userIds.length > 0 && !(await canAllReadThread(pool, bound.userIds, viewer.userId, parentType, parentId, mentions!.resolveRoles))) {
    return { status: "ineligible_mention" };
  }

  try {
    return await inTransaction(pool, async (client): Promise<CreateCommentResult> => {
      // §43.5 / §44.5: the daily cap's lock, ahead of every write and of the audit chain's lock.
      if (bound.userIds.length > 0) await lockMentionSaver(client, viewer.userId);
      let thread: { threadRootId: string; replyToId: string; replyToAuthorId: string } | null = null;
      if (replyTo !== null) {
        // FOR SHARE: a soft delete of the target waits until this reply commits, so a reply never
        // lands on a comment removed while it was being written. A non-uuid id names no comment.
        const target = isUuid(replyTo)
          ? (
              await client.query<ReplyTargetRow>(
                `select id, parent_type, parent_id, author_id, thread_root_id, deleted_at from comments where id = $1 for share`,
                [replyTo],
              )
            ).rows[0]
          : undefined;
        const resolved = resolveReplyTarget(
          target
            ? { id: target.id, parentType: target.parent_type, parentId: target.parent_id, threadRootId: target.thread_root_id, deleted: target.deleted_at !== null }
            : null,
          { parentType, parentId },
        );
        if (!resolved.ok) return { status: "unprocessable", error: resolved.error };
        thread = { threadRootId: resolved.threadRootId, replyToId: resolved.replyToId, replyToAuthorId: target!.author_id };
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into comments (parent_type, parent_id, author_id, body, thread_root_id, reply_to_id, mcp_client_name)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [parentType, parentId, viewer.userId, bound.text, thread?.threadRootId ?? null, thread?.replyToId ?? null, via?.clientName ?? null],
      );
      const id = rows[0]!.id;
      // §44.5: one row per mentioned person; over a cap, the whole post rolls back.
      const mentioned = bound.userIds.length > 0 ? await addCommentMentionRows(client, id, viewer.userId, bound.userIds) : [];
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "comment.posted",
        targetType: "comment",
        targetId: id,
        // §10.2: `replyTo` names the comment answered; absent on a top-level comment. §25.13: a
        // comment made through MCP adds its source and client. §44.10: `mentions` lists the people
        // mentioned, by id — the row carries no body, so no token and no name reach the log.
        after: {
          parentType,
          parentId,
          ...(thread ? { replyTo: thread.replyToId } : {}),
          ...(mentioned.length > 0 ? { mentions: mentioned } : {}),
          ...agentAuditFields(via),
        },
      });
      // §23.2: comment_posted for the commenter (daily-capped; comments are never anonymous).
      await awardCommentPosted(client, { id, authorId: viewer.userId, parentType, parentId, viaMcp: via !== undefined });
      const comment = await readRecord(client, viewer, id, parentType, parentId);
      if (onCreated) await onCreated(comment);
      return { status: "ok", comment, replyToAuthorId: thread?.replyToAuthorId ?? null, mentioned };
    });
  } catch (err) {
    if (err instanceof CommentMentionCapError) return { status: "mention_cap", reason: err.reason };
    throw err;
  }
}

export type EditCommentResult =
  /** `mentioned` (§44.5): the people this edit gave a mention row — told once, by event 27. */
  | { status: "ok"; comment: CommentRecord; mentioned: string[] }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "invalid"; error: string }
  | { status: "ineligible_mention" }
  | { status: "mention_cap"; reason: "comment_cap" | "daily_cap" };

export async function editComment(pool: Pool, viewer: Viewer, commentId: string, rawBody: unknown, mentions?: CommentSaveMentions): Promise<EditCommentResult> {
  if (!isUuid(commentId)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; author_id: string; body: string; created_at: Date; deleted_at: Date | null; parent_type: "challenge" | "solution"; parent_id: string }>(
    `select id, author_id, body, created_at, deleted_at, parent_type, parent_id from comments where id = $1`,
    [commentId],
  );
  const row = rows[0];
  if (!row || row.deleted_at !== null) return { status: "not_found" };
  // §2.4: a comment on a challenge/solution the viewer cannot see is "not found", never "forbidden".
  const access = await getParentAccess(pool, viewer, row.parent_type, row.parent_id);
  if (access !== "live") return { status: access };
  if (!canEditOwnComment({ authorId: row.author_id, createdAt: row.created_at }, viewer.userId, new Date())) {
    return { status: "forbidden" };
  }
  const validated = validateCommentBody(rawBody);
  if (!validated.ok) return { status: "invalid", error: validated.error };
  // §44.5: the box's list, or — with no list — the comment's current mentions by their current
  // names. Only people who get a NEW row are checked: someone already told is not checked again.
  const candidates = mentions?.candidates ?? (await currentMentionCandidates(pool, [row.body]));
  const bound = bindMentions(validated.value, candidates);
  const withRow = new Set(await commentMentionRowUserIds(pool, commentId));
  const fresh = bound.userIds.filter((id) => !withRow.has(id));
  if (fresh.length > 0 && (!mentions || !(await canAllReadThread(pool, fresh, viewer.userId, row.parent_type, row.parent_id, mentions.resolveRoles)))) {
    return { status: "ineligible_mention" };
  }

  try {
    return await inTransaction(pool, async (client): Promise<EditCommentResult> => {
      if (fresh.length > 0) await lockMentionSaver(client, viewer.userId);
      await client.query(`update comments set body = $2, edited_at = now() where id = $1`, [commentId, bound.text]);
      // §44.5: a row is never deleted or changed by an edit; a newly named person gets one.
      const mentioned = bound.userIds.length > 0 ? await addCommentMentionRows(client, commentId, viewer.userId, bound.userIds) : [];
      const before = mentionedUserIds(row.body);
      const removed = before.filter((id) => !bound.userIds.includes(id));
      const added = bound.userIds.filter((id) => !before.includes(id));
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "comment.edited",
        targetType: "comment",
        targetId: commentId,
        // §44.10: who the edit put into the text and who it took out, by id — never a name.
        ...(added.length > 0 || removed.length > 0 ? { after: { ...(added.length > 0 ? { mentionsAdded: added } : {}), ...(removed.length > 0 ? { mentionsRemoved: removed } : {}) } } : {}),
      });
      return { status: "ok", comment: await readRecord(client, viewer, commentId, row.parent_type, row.parent_id), mentioned };
    });
  } catch (err) {
    if (err instanceof CommentMentionCapError) return { status: "mention_cap", reason: err.reason };
    throw err;
  }
}

export type DeleteCommentResult = { status: "ok" } | { status: "not_found" } | { status: "trashed" } | { status: "forbidden" };

export async function deleteComment(pool: Pool, viewer: Viewer, commentId: string): Promise<DeleteCommentResult> {
  if (!isUuid(commentId)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; author_id: string; created_at: Date; deleted_at: Date | null; parent_type: "challenge" | "solution"; parent_id: string }>(
    `select id, author_id, created_at, deleted_at, parent_type, parent_id from comments where id = $1`,
    [commentId],
  );
  const row = rows[0];
  if (!row || row.deleted_at !== null) return { status: "not_found" };
  const access = await getParentAccess(pool, viewer, row.parent_type, row.parent_id);
  if (access !== "live") return { status: access };

  const namespaceId = await getParentNamespaceId(pool, row.parent_type, row.parent_id);
  const isModerator = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
  const isOwnerInWindow = canEditOwnComment({ authorId: row.author_id, createdAt: row.created_at }, viewer.userId, new Date());
  if (!isModerator && !isOwnerInWindow) return { status: "forbidden" };

  return inTransaction(pool, async (client) => {
    await client.query(`update comments set deleted_at = now(), deleted_by = $2 where id = $1`, [commentId, viewer.userId]);
    // §44.6: nobody is pointed at a comment that is gone — its event-27 inbox rows and unsent
    // e-mails go with it. Its mention rows stay, so the caps stay honest (§44.8).
    await deleteCommentMentionNotifications(client, commentId);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "comment.deleted",
      targetType: "comment",
      targetId: commentId,
      after: { moderator: isModerator && viewer.userId !== row.author_id },
    });
    return { status: "ok" };
  });
}
