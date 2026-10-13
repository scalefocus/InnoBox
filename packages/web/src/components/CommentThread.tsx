"use client";
// Comment thread (INNOBOX_SPEC.md §10.2): post, owner edit/delete within 15 minutes,
// admin moderation delete anytime. Comments are never anonymous (§9) — always the real
// name. Deleted comments render as "Comment removed by a moderator". Above the thread, the §22.13
// discussion summary control (when the item's number is known and summaries are available). A
// `readOnly` thread (an item in the §10.4 trash) shows the comments and nothing else.
import { useEffect, useState } from "react";
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
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  isMine: boolean;
  canEdit: boolean;
  canModerate: boolean;
  authorIsCommittee: boolean;
}

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
  /** §10.4: the item is in the trash — no composer, no edit or delete, no AI summary. */
  readOnly?: boolean;
}) {
  const fmt = useDateFmt();
  const [comments, setComments] = useState<CommentRecord[] | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

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

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentType, parentId, body: draft }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not post comment");
      reportFeatureUse("comment"); // §13.10 first use
      setDraft("");
      refresh();
    } catch {
      /* surfaced via the disabled state resetting; keep this lightweight */
    } finally {
      setSubmitting(false);
    }
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

  // Any post, edit or delete changes this, so the summary control re-reads its state.
  const threadVersion = comments === null ? "" : comments.map((c) => `${c.id}:${c.editedAt ?? ""}:${c.deleted ? 1 : 0}`).join("|");

  return (
    <div style={{ marginTop: 8 }}>
      {parentNumber && comments !== null && !readOnly && <DiscussionSummary parentType={parentType} parentNumber={parentNumber} version={threadVersion} />}
      {comments === null && <p className="muted">Loading comments…</p>}
      {comments !== null && comments.length === 0 && <p className="muted">No comments yet.</p>}
      {comments !== null && comments.length > 0 && (
        <div className="rows" style={{ marginBottom: 12 }}>
          {comments.map((c) => (
            <div className="row" key={c.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
                  <input className="field" style={{ flex: 1 }} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => saveEdit(c.id)}>
                    Save
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 14, whiteSpace: "pre-wrap", fontStyle: c.deleted ? "italic" : undefined, color: c.deleted ? "var(--muted)" : undefined }}>
                  {c.body}
                </p>
              )}
              {!c.deleted && !readOnly && editingId !== c.id && (
                <div style={{ display: "flex", gap: 8 }}>
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
          ))}
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
