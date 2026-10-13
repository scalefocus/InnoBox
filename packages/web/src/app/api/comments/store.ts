// Data layer for /api/comments (INNOBOX_SPEC.md §10.2). Comments are never anonymous (§9) —
// the real author always shows. Visibility mirrors the parent challenge/solution (§4.3).
// Deleted comments (self or moderator) always render as "Comment removed by a moderator",
// preserving thread continuity, per spec. Every write is audited atomically. Replies are one level
// deep (§10.2 "Replies"): a reply files under its thread's top-level comment.
import type { Pool } from "pg";
import { canEditOwnComment, resolveReplyTarget, validateCommentBody } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { awardCommentPosted } from "../../../lib/gamification";
import { getParentAccess, getParentNamespaceId, type Viewer } from "../challenges/store";
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
  body: string;
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
}

interface CommentRow {
  id: string;
  parent_type: "challenge" | "solution";
  parent_id: string;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  author_scrubbed: boolean;
  body: string;
  thread_root_id: string | null;
  reply_to_id: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
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
    body: deleted ? MODERATION_PLACEHOLDER : row.body,
    threadRootId: row.thread_root_id,
    replyToId: row.reply_to_id,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    deleted,
    isMine: viewer.userId === row.author_id,
    canEdit: !deleted && canEditOwnComment({ authorId: row.author_id, createdAt: row.created_at }, viewer.userId, now),
    canModerate: !deleted && (isNamespaceAdmin || (viewer.userId === row.author_id && canEditOwnComment({ authorId: row.author_id, createdAt: row.created_at }, viewer.userId, now))),
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

export async function listComments(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<CommentRecord[] | null> {
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access === "not_found") return null;
  const namespaceId = await getParentNamespaceId(pool, parentType, parentId);
  const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
  const committee = namespaceId !== null ? await committeeMemberIds(pool, namespaceId) : new Set<string>();
  const { rows } = await pool.query<CommentRow>(
    `select c.id, c.parent_type, c.parent_id, c.author_id, u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
            c.body, c.thread_root_id, c.reply_to_id, c.created_at, c.edited_at, c.deleted_at
       from comments c
       join users u on u.id = c.author_id
      where c.parent_type = $1 and c.parent_id = $2
      order by c.created_at asc, c.id asc`,
    [parentType, parentId],
  );
  const records = rows.map((r) => toRecord(r, viewer, isNamespaceAdmin, committee.has(r.author_id)));
  // §10.4: the thread of a trashed item is read-only — nobody edits or removes a comment there.
  return access === "trashed" ? records.map((r) => ({ ...r, canEdit: false, canModerate: false })) : records;
}

export type CreateCommentResult =
  /** `replyToAuthorId` (§10.2): who wrote the comment answered — null on a top-level comment. */
  | { status: "ok"; comment: CommentRecord; replyToAuthorId: string | null }
  | { status: "not_found" }
  /** §10.4: the item is in the trash (only a platform admin can see it there) — answered as 409. */
  | { status: "trashed" }
  | { status: "invalid"; error: string }
  /** §10.2: the reply target is missing, on another item, or soft-deleted — answered as 422. */
  | { status: "unprocessable"; error: string };

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
): Promise<CreateCommentResult> {
  // The parent's visibility decides first: a reply on an item the caller can't see is a 404. A
  // trashed item takes no comment or reply (§10.4).
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access !== "live") return { status: access };
  const validated = validateCommentBody(rawBody);
  if (!validated.ok) return { status: "invalid", error: validated.error };

  return inTransaction(pool, async (client) => {
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
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `insert into comments (parent_type, parent_id, author_id, body, thread_root_id, reply_to_id)
       values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
      [parentType, parentId, viewer.userId, validated.value, thread?.threadRootId ?? null, thread?.replyToId ?? null],
    );
    const inserted = rows[0]!;
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "comment.posted",
      targetType: "comment",
      targetId: inserted.id,
      // §10.2: `replyTo` names the comment answered; absent on a top-level comment.
      after: thread ? { parentType, parentId, replyTo: thread.replyToId } : { parentType, parentId },
    });
    // §23.2: comment_posted for the commenter (daily-capped; comments are never anonymous).
    await awardCommentPosted(client, { id: inserted.id, authorId: viewer.userId, parentType, parentId });
    const namespaceId = await getParentNamespaceId(client, parentType, parentId);
    const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
    const { rows: userRows } = await client.query<{ display_name: string; active: boolean; scrubbed: boolean }>(
      `select display_name, active, scrubbed_at is not null as scrubbed from users where id = $1`,
      [viewer.userId],
    );
    const comment = toRecord(
      {
        id: inserted.id,
        parent_type: parentType,
        parent_id: parentId,
        author_id: viewer.userId,
        author_display_name: userRows[0]?.display_name ?? "",
        author_active: userRows[0]?.active ?? true,
        author_scrubbed: userRows[0]?.scrubbed ?? false,
        body: validated.value,
        thread_root_id: thread?.threadRootId ?? null,
        reply_to_id: thread?.replyToId ?? null,
        created_at: inserted.created_at,
        edited_at: null,
        deleted_at: null,
      },
      viewer,
      isNamespaceAdmin,
      namespaceId !== null && viewer.roles.isCommittee(namespaceId),
    );
    if (onCreated) await onCreated(comment);
    return { status: "ok", comment, replyToAuthorId: thread?.replyToAuthorId ?? null };
  });
}

export type EditCommentResult =
  | { status: "ok"; comment: CommentRecord }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "invalid"; error: string };

export async function editComment(pool: Pool, viewer: Viewer, commentId: string, rawBody: unknown): Promise<EditCommentResult> {
  if (!isUuid(commentId)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; author_id: string; created_at: Date; deleted_at: Date | null; parent_type: "challenge" | "solution"; parent_id: string }>(
    `select id, author_id, created_at, deleted_at, parent_type, parent_id from comments where id = $1`,
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

  return inTransaction(pool, async (client) => {
    await client.query(`update comments set body = $2, edited_at = now() where id = $1`, [commentId, validated.value]);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "comment.edited",
      targetType: "comment",
      targetId: commentId,
    });
    const namespaceId = await getParentNamespaceId(client, row.parent_type, row.parent_id);
    const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
    const { rows: full } = await client.query<CommentRow>(
      `select c.id, c.parent_type, c.parent_id, c.author_id, u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed,
              c.body, c.thread_root_id, c.reply_to_id, c.created_at, c.edited_at, c.deleted_at
         from comments c join users u on u.id = c.author_id where c.id = $1`,
      [commentId],
    );
    return { status: "ok", comment: toRecord(full[0]!, viewer, isNamespaceAdmin, namespaceId !== null && viewer.roles.isCommittee(namespaceId)) };
  });
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
