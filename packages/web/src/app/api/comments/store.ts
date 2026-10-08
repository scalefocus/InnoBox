// Data layer for /api/comments (INNOBOX_SPEC.md §10.2). Comments are never anonymous (§9) —
// the real author always shows. Visibility mirrors the parent challenge/solution (§4.3).
// Deleted comments (self or moderator) always render as "Comment removed by a moderator",
// preserving thread continuity, per spec. Every write is audited atomically.
import type { Pool } from "pg";
import { canEditOwnComment, validateCommentBody } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { getParentNamespaceId, isParentVisible, type Viewer } from "../challenges/store";
import { isUuid } from "./validation";

const MODERATION_PLACEHOLDER = "Comment removed by a moderator";

export interface CommentRecord {
  id: string;
  parentType: "challenge" | "solution";
  parentId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
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
  body: string;
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
    body: deleted ? MODERATION_PLACEHOLDER : row.body,
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
  if (!(await isParentVisible(pool, viewer, parentType, parentId))) return null;
  const namespaceId = await getParentNamespaceId(pool, parentType, parentId);
  const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
  const committee = namespaceId !== null ? await committeeMemberIds(pool, namespaceId) : new Set<string>();
  const { rows } = await pool.query<CommentRow>(
    `select c.id, c.parent_type, c.parent_id, c.author_id, u.display_name as author_display_name,
            c.body, c.created_at, c.edited_at, c.deleted_at
       from comments c
       join users u on u.id = c.author_id
      where c.parent_type = $1 and c.parent_id = $2
      order by c.created_at asc`,
    [parentType, parentId],
  );
  return rows.map((r) => toRecord(r, viewer, isNamespaceAdmin, committee.has(r.author_id)));
}

export type CreateCommentResult = { status: "ok"; comment: CommentRecord } | { status: "not_found" } | { status: "invalid"; error: string };

export async function createComment(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
  rawBody: unknown,
  onCreated?: (comment: CommentRecord) => Promise<void>,
): Promise<CreateCommentResult> {
  if (!(await isParentVisible(pool, viewer, parentType, parentId))) return { status: "not_found" };
  const validated = validateCommentBody(rawBody);
  if (!validated.ok) return { status: "invalid", error: validated.error };

  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `insert into comments (parent_type, parent_id, author_id, body) values ($1, $2, $3, $4) returning id, created_at`,
      [parentType, parentId, viewer.userId, validated.value],
    );
    const inserted = rows[0]!;
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "comment.posted",
      targetType: "comment",
      targetId: inserted.id,
      after: { parentType, parentId },
    });
    const namespaceId = await getParentNamespaceId(client, parentType, parentId);
    const isNamespaceAdmin = namespaceId !== null && viewer.roles.isNamespaceAdmin(namespaceId);
    const { rows: userRows } = await client.query<{ display_name: string }>(`select display_name from users where id = $1`, [
      viewer.userId,
    ]);
    const comment = toRecord(
      {
        id: inserted.id,
        parent_type: parentType,
        parent_id: parentId,
        author_id: viewer.userId,
        author_display_name: userRows[0]?.display_name ?? "",
        body: validated.value,
        created_at: inserted.created_at,
        edited_at: null,
        deleted_at: null,
      },
      viewer,
      isNamespaceAdmin,
      namespaceId !== null && viewer.roles.isCommittee(namespaceId),
    );
    if (onCreated) await onCreated(comment);
    return { status: "ok", comment };
  });
}

export type EditCommentResult = { status: "ok"; comment: CommentRecord } | { status: "not_found" } | { status: "forbidden" } | { status: "invalid"; error: string };

export async function editComment(pool: Pool, viewer: Viewer, commentId: string, rawBody: unknown): Promise<EditCommentResult> {
  if (!isUuid(commentId)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; author_id: string; created_at: Date; deleted_at: Date | null; parent_type: "challenge" | "solution"; parent_id: string }>(
    `select id, author_id, created_at, deleted_at, parent_type, parent_id from comments where id = $1`,
    [commentId],
  );
  const row = rows[0];
  if (!row || row.deleted_at !== null) return { status: "not_found" };
  // §2.4: a comment on a challenge/solution the viewer cannot see is "not found", never "forbidden".
  if (!(await isParentVisible(pool, viewer, row.parent_type, row.parent_id))) return { status: "not_found" };
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
      `select c.id, c.parent_type, c.parent_id, c.author_id, u.display_name as author_display_name,
              c.body, c.created_at, c.edited_at, c.deleted_at
         from comments c join users u on u.id = c.author_id where c.id = $1`,
      [commentId],
    );
    return { status: "ok", comment: toRecord(full[0]!, viewer, isNamespaceAdmin, namespaceId !== null && viewer.roles.isCommittee(namespaceId)) };
  });
}

export type DeleteCommentResult = { status: "ok" } | { status: "not_found" } | { status: "forbidden" };

export async function deleteComment(pool: Pool, viewer: Viewer, commentId: string): Promise<DeleteCommentResult> {
  if (!isUuid(commentId)) return { status: "not_found" };
  const { rows } = await pool.query<{ id: string; author_id: string; created_at: Date; deleted_at: Date | null; parent_type: "challenge" | "solution"; parent_id: string }>(
    `select id, author_id, created_at, deleted_at, parent_type, parent_id from comments where id = $1`,
    [commentId],
  );
  const row = rows[0];
  if (!row || row.deleted_at !== null) return { status: "not_found" };
  if (!(await isParentVisible(pool, viewer, row.parent_type, row.parent_id))) return { status: "not_found" };

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
