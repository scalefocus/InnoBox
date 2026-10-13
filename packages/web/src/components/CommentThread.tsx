"use client";
// Comment thread (INNOBOX_SPEC.md §10.2): post, owner edit/delete within 15 minutes,
// admin moderation delete anytime. Comments are never anonymous (§9) — always the real
// name. Deleted comments render as "Comment removed by a moderator". Above the thread, the §22.13
// discussion summary control (when the item's number is known and summaries are available).
//
// Replies (§10.2): one level deep. Top-level comments stay oldest first; each one's replies follow
// it, indented, also oldest first — the first REPLIES_SHOWN, then "Show N more replies". Every
// live comment has a Reply action that opens a composer under its thread. A reply that answers
// another reply carries "↪ replying to <name>", which scrolls to and flashes that comment. A
// `readOnly` thread (an item in the §10.4 trash) shows the comments and nothing else.
import { Fragment, useEffect, useRef, useState } from "react";
import { REPLIES_SHOWN, groupThreads } from "@innobox/shared/comment-threads";
import { readJson } from "@/lib/api-client";
import { AvatarBubble } from "@/components/AvatarBubble";
import { DiscussionSummary } from "@/components/DiscussionSummary";
import { useDateFmt } from "@/components/DateFormat";
import { reportFeatureUse } from "@/lib/survey-client";

interface CommentRecord {
  id: string;
  authorId: string;
  authorDisplayName: string;
  authorActive?: boolean;
  authorScrubbed?: boolean;
  body: string;
  threadRootId: string | null;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  isMine: boolean;
  canEdit: boolean;
  canModerate: boolean;
  authorIsCommittee: boolean;
}

/** The open reply composer: the thread it files under and the comment it answers. */
interface ReplyDraft {
  rootId: string;
  replyToId: string;
  replyToName: string;
}

const FLASH_MS = 1600;

export function CommentThread({
  parentType,
  parentId,
  parentNumber,
  authoredAnonymously = false,
  readOnly = false,
}: {
  parentType: "challenge" | "solution";
  parentId: string;
  /** The item's CH-/SOL- number — enables the §22.13 summary control. */
  parentNumber?: string;
  /** True when the viewer is the ANONYMOUS author of this item — §9 warns them that commenting
   *  shows their real name (comments are never anonymous), without revealing them as the author. */
  authoredAnonymously?: boolean;
  /** §10.4: the item is in the trash — no composer, no reply, edit or delete, no AI summary. */
  readOnly?: boolean;
}) {
  const fmt = useDateFmt();
  const [comments, setComments] = useState<CommentRecord[] | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = () => {
    fetch(`/api/comments?parentType=${parentType}&parentId=${parentId}`, { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => setComments(json.comments ?? []))
      .catch(() => setComments([]));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentType, parentId]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const submit = async (body: string, replyTo: string | null): Promise<string | null> => {
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(replyTo ? { parentType, parentId, body, replyTo } : { parentType, parentId, body }),
    });
    const json = await readJson(res);
    if (!res.ok) return json.error ?? "Could not post comment";
    reportFeatureUse("comment"); // §13.10 first use
    return null;
  };

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setSubmitting(true);
    try {
      if ((await submit(draft, null)) === null) {
        setDraft("");
        refresh();
      }
    } catch {
      /* surfaced via the disabled state resetting; keep this lightweight */
    } finally {
      setSubmitting(false);
    }
  };

  const postReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reply || !replyText.trim()) return;
    setSubmitting(true);
    try {
      const error = await submit(replyText, reply.replyToId);
      if (error === null) {
        // The new reply is the newest in its thread: open the thread so it is in view.
        setExpanded((prev) => new Set(prev).add(reply.rootId));
        setReply(null);
        setReplyText("");
        setReplyError(null);
      } else {
        setReplyError(error);
      }
      // A 422 means the comment was removed meanwhile — re-read so the thread shows it.
      refresh();
    } catch {
      setReplyError("Could not post reply");
    } finally {
      setSubmitting(false);
    }
  };

  const openReply = (target: CommentRecord) => {
    setReply({ rootId: target.threadRootId ?? target.id, replyToId: target.id, replyToName: target.authorDisplayName });
    setReplyText("");
    setReplyError(null);
  };

  const saveEdit = async (id: string) => {
    const res = await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: editDraft }),
    });
    if (res.ok) {
      setEditingId(null);
      refresh();
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this comment?")) return;
    const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) refresh();
  };

  /** Scroll to the comment a reply answers and flash it — expanding its thread first if the
   *  target sits behind "Show N more replies". */
  const jumpTo = (target: CommentRecord) => {
    if (target.threadRootId) setExpanded((prev) => new Set(prev).add(target.threadRootId!));
    requestAnimationFrame(() => {
      document.getElementById(`comment-${target.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashId(target.id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), FLASH_MS);
    });
  };

  // Any post, edit or delete changes this, so the summary control re-reads its state.
  const threadVersion = comments === null ? "" : comments.map((c) => `${c.id}:${c.editedAt ?? ""}:${c.deleted ? 1 : 0}`).join("|");
  const byId = new Map((comments ?? []).map((c) => [c.id, c]));
  const groups = comments === null ? [] : groupThreads(comments);

  const renderComment = (c: CommentRecord) => {
    const isReply = c.threadRootId !== null;
    // "↪ replying to" only when the reply answers another reply — under the root it is implied.
    const answered = isReply && c.replyToId !== null && c.replyToId !== c.threadRootId ? byId.get(c.replyToId) : undefined;
    const classes = ["row", isReply ? "comment-reply" : "", flashId === c.id ? "comment-flash" : ""].filter(Boolean).join(" ");
    return (
      <div className={classes} id={`comment-${c.id}`} key={c.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        {/* Never the name of a removed comment's author (§10.2). */}
        {answered && (
          <button
            type="button"
            className="comment-reply-to"
            disabled={answered.deleted}
            onClick={() => jumpTo(answered)}
            title={answered.deleted ? undefined : "Show the comment this answers"}
          >
            ↪ replying to {answered.deleted ? "a removed comment" : answered.authorDisplayName}
          </button>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {/* Comments are never anonymous (§9): always the real bubble — except a deleted
              comment renders the neutral bubble (no face on a removed comment). */}
          <AvatarBubble
            size="sm"
            userId={c.deleted ? null : c.authorId}
            displayName={c.deleted ? "" : c.authorDisplayName}
            anonymous={c.deleted}
            deactivated={!c.deleted && c.authorActive === false}
            scrubbed={!c.deleted && c.authorScrubbed === true}
            title={c.deleted ? "Comment removed" : c.authorDisplayName}
          />
          <span className="ttl" style={{ fontSize: 13.5 }}>
            {c.deleted ? <span className="muted">—</span> : c.authorDisplayName}
          </span>
          {c.authorIsCommittee && !c.deleted && <span className="chip chip-accent">Committee</span>}
          <span className="sub mono">{fmt.dateTime(c.createdAt)}</span>
          {c.editedAt && !c.deleted && <span className="chip">edited</span>}
        </div>
        {editingId === c.id ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field" style={{ flex: 1, minWidth: 0 }} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
            <button type="button" className="btn btn-sm btn-primary" onClick={() => saveEdit(c.id)}>
              Save
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingId(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontStyle: c.deleted ? "italic" : undefined, color: c.deleted ? "var(--muted)" : undefined }}>
            {c.body}
          </p>
        )}
        {/* A removed comment can't be answered, edited or deleted again. */}
        {!c.deleted && !readOnly && editingId !== c.id && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openReply(c)}>
              Reply
            </button>
            {c.canEdit && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setEditingId(c.id);
                  setEditDraft(c.body);
                }}
              >
                Edit
              </button>
            )}
            {c.canModerate && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(c.id)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 8 }}>
      {parentNumber && comments !== null && !readOnly && <DiscussionSummary parentType={parentType} parentNumber={parentNumber} version={threadVersion} />}
      {comments === null && <p className="muted">Loading comments…</p>}
      {comments !== null && comments.length === 0 && <p className="muted">No comments yet.</p>}
      {comments !== null && comments.length > 0 && (
        <div className="rows" style={{ marginBottom: 12 }}>
          {groups.map(({ root, replies }) => {
            const open = expanded.has(root.id);
            const shown = open ? replies : replies.slice(0, REPLIES_SHOWN);
            const hidden = replies.length - shown.length;
            return (
              <Fragment key={root.id}>
                {renderComment(root)}
                {shown.map(renderComment)}
                {hidden > 0 && (
                  <div className="row comment-reply">
                    <button type="button" className="btn btn-sm btn-ghost comment-more" onClick={() => setExpanded((prev) => new Set(prev).add(root.id))}>
                      Show {hidden} more {hidden === 1 ? "reply" : "replies"}
                    </button>
                  </div>
                )}
                {reply?.rootId === root.id && !readOnly && (
                  <form key={`composer-${reply.replyToId}`} className="row comment-reply" onSubmit={postReply} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                    <span className="sub">Replying to {reply.replyToName}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="field"
                        style={{ flex: 1, minWidth: 0 }}
                        placeholder="Write a reply…"
                        aria-label={`Reply to ${reply.replyToName}`}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setReply(null);
                        }}
                        maxLength={5000}
                        autoFocus
                      />
                      <button type="submit" className="btn btn-sm btn-primary" disabled={submitting || !replyText.trim()}>
                        Reply
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setReply(null)}>
                        Cancel
                      </button>
                    </div>
                    {replyError && (
                      <span className="sub" role="alert" style={{ color: "var(--danger)" }}>
                        {replyError}
                      </span>
                    )}
                  </form>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
      {authoredAnonymously && !readOnly && (
        <p className="sub" style={{ margin: "0 0 8px", color: "var(--warn, var(--faint))" }}>
          You submitted this anonymously. Commenting won&apos;t reveal you as the author, but your name is shown on the comment itself (comments are never anonymous).
        </p>
      )}
      {!readOnly && (
        <form onSubmit={post} style={{ display: "flex", gap: 8 }}>
          <input
            className="field"
            style={{ flex: 1 }}
            placeholder="Add a comment…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={5000}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={submitting || !draft.trim()}>
            Post
          </button>
        </form>
      )}
    </div>
  );
}
