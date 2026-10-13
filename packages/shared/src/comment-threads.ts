// One-level comment replies (INNOBOX_SPEC.md §10.2 "Replies"). Pure and client-safe — also
// exposed at `@innobox/shared/comment-threads` for the <CommentThread> component.
//
// A reply always hangs under a TOP-LEVEL comment (its thread root), never under another reply.
// Replying to a reply files the new reply under the same root, with `replyToId` pointing at the
// reply it answers. Both ids are null on a top-level comment.

/** A thread shows this many replies, then a "Show N more replies" button for the rest. */
export const REPLIES_SHOWN = 3;

/** The comment a reply targets, as the store reads it. */
export interface ReplyTarget {
  id: string;
  parentType: "challenge" | "solution";
  parentId: string;
  threadRootId: string | null;
  deleted: boolean;
}

export const REPLY_NOT_ON_ITEM = "replyTo must be a comment on this item";
export const REPLY_TO_REMOVED = "You can't reply to a removed comment";

export type ReplyResolution = { ok: true; threadRootId: string; replyToId: string } | { ok: false; error: string };

/**
 * Where a reply files. A missing target and one on another item share one message, so a reply
 * can't probe for comments on items the caller can't see; a soft-deleted target can't be
 * answered. The root is the target's own root, or the target itself when it is top-level.
 */
export function resolveReplyTarget(target: ReplyTarget | null, parent: { parentType: "challenge" | "solution"; parentId: string }): ReplyResolution {
  if (!target || target.parentType !== parent.parentType || target.parentId !== parent.parentId) {
    return { ok: false, error: REPLY_NOT_ON_ITEM };
  }
  if (target.deleted) return { ok: false, error: REPLY_TO_REMOVED };
  return { ok: true, threadRootId: target.threadRootId ?? target.id, replyToId: target.id };
}

export interface ThreadedComment {
  id: string;
  threadRootId: string | null;
  createdAt: string;
}

export interface CommentGroup<T> {
  root: T;
  replies: T[];
}

/** Oldest first, ties broken by id — the same order the store reads. */
function chronological<T extends ThreadedComment>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Top-level comments oldest first, each followed by its replies, also oldest first. A reply whose
 * root is missing from the list (never expected — roots are soft-deleted, not removed) is shown
 * as its own group rather than dropped.
 */
export function groupThreads<T extends ThreadedComment>(comments: readonly T[]): CommentGroup<T>[] {
  const sorted = [...comments].sort(chronological);
  const ids = new Set(sorted.map((c) => c.id));
  const groups = new Map<string, CommentGroup<T>>();
  const out: CommentGroup<T>[] = [];
  for (const c of sorted) {
    if (c.threadRootId === null || !ids.has(c.threadRootId)) {
      const group = { root: c, replies: [] };
      groups.set(c.id, group);
      out.push(group);
    }
  }
  for (const c of sorted) {
    if (c.threadRootId !== null && ids.has(c.threadRootId)) groups.get(c.threadRootId)?.replies.push(c);
  }
  return out;
}

/** Thread order, flattened: each root followed by its replies. */
export function threadOrder<T extends ThreadedComment>(comments: readonly T[]): T[] {
  return groupThreads(comments).flatMap((g) => [g.root, ...g.replies]);
}
