"use client";
// Comment thread (INNOBOX_SPEC.md §10.2): post, owner edit/delete within 15 minutes,
// admin moderation delete anytime. Comments are never anonymous (§9) — always the real
// name. Deleted comments render as "Comment removed by a moderator".
import { useEffect, useState } from "react";
import { readJson } from "@/lib/api-client";
import { AvatarBubble } from "@/components/AvatarBubble";

interface CommentRecord {
  id: string;
  authorId: string;
  authorDisplayName: string;
  authorActive?: boolean;
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
  authoredAnonymously = false,
}: {
  parentType: "challenge" | "solution";
  parentId: string;
  /** True when the viewer is the ANONYMOUS author of this item — §9 warns them that commenting
   *  shows their real name (comments are never anonymous), without revealing them as the author. */
  authoredAnonymously?: boolean;
}) {
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

  return (
    <div style={{ marginTop: 8 }}>
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
                  title={c.deleted ? "Comment removed" : c.authorDisplayName}
                />
                <span className="ttl" style={{ fontSize: 13.5 }}>
                  {c.deleted ? <span className="muted">—</span> : c.authorDisplayName}
                </span>
                {c.authorIsCommittee && !c.deleted && <span className="chip chip-accent">Committee</span>}
                <span className="sub mono">{new Date(c.createdAt).toLocaleString()}</span>
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
              {!c.deleted && editingId !== c.id && (
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
      {authoredAnonymously && (
        <p className="sub" style={{ margin: "0 0 8px", color: "var(--warn, var(--faint))" }}>
          You submitted this anonymously. Commenting won&apos;t reveal you as the author, but your name is shown on the comment itself (comments are never anonymous).
        </p>
      )}
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
    </div>
  );
}
