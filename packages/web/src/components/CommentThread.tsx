"use client";
// Comment thread (INNOBOX_SPEC.md §10.2): post, owner edit/delete within 15 minutes,
// admin moderation delete anytime. Comments are never anonymous (§9) — always the real
// name. Deleted comments render as "Comment removed by a moderator". Above the thread, the §22.13
// discussion summary control (when the item's number is known and summaries are available). A
// comment posted through an AI agent carries the §25.8 "via agent" tag beside its author.
//
// Replies (§10.2): one level deep. Top-level comments stay oldest first; each one's replies follow
// it, indented, also oldest first — the first REPLIES_SHOWN, then "Show N more replies". Every
// live comment has a Reply action that opens a composer under its thread. A reply that answers
// another reply carries "↪ replying to <name>", which scrolls to and flashes that comment. A
// `readOnly` thread (an item in the §10.4 trash) shows the comments and nothing else.
//
// Markdown, links and mentions (§44): a new comment, a reply and an edit are all written in the
// §44.2 comment box (CommentBox), and every live comment — those posted before this shipped
// included — is rendered Markdown with its links and its mentions (CommentMarkdown, §44.7). A
// removed comment shows its placeholder only. A `#comment-<id>` link (§44.6) opens whatever hides
// that comment, scrolls to it and flashes it, exactly as "↪ replying to" does.
import { Fragment, useEffect, useRef, useState } from "react";
import { REPLIES_SHOWN, groupThreads } from "@innobox/shared/comment-threads";
import type { MentionCandidate } from "@innobox/shared/mentions";
import { readJson } from "@/lib/api-client";
import { AvatarBubble } from "@/components/AvatarBubble";
import { CommentBox } from "@/components/CommentBox";
import { CommentMarkdown, type CommentMentionView } from "@/components/CommentMarkdown";
import { DiscussionSummary } from "@/components/DiscussionSummary";
import { useDateFmt } from "@/components/DateFormat";
import { reportFeatureUse } from "@/lib/survey-client";
import { ViaAgentTag, type ViaAgent } from "@/components/ViaAgentTag";

interface CommentRecord {
  id: string;
  authorId: string;
  authorDisplayName: string;
  authorActive?: boolean;
  authorScrubbed?: boolean;
  /** Display text (§44.5): the Markdown as written, each mention as `@` and the person's name. */
  body: string;
  /** §44.10: where each mention sits in `body`. Empty on a removed comment; absent in an older payload. */
  mentions?: CommentMentionView[];
  /** §44.10: room under the per-comment cap, on a comment the viewer may edit; null otherwise. */
  mentionsLeft?: number | null;
  threadRootId: string | null;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  isMine: boolean;
  canEdit: boolean;
  canModerate: boolean;
  authorIsCommittee: boolean;
  /** §25.8: set when posted through an AI agent (absent/null = posted in the browser). */
  viaAgent?: ViaAgent;
}

/** The open reply composer: the thread it files under and the comment it answers. */
interface ReplyDraft {
  rootId: string;
  replyToId: string;
  replyToName: string;
}

const FLASH_MS = 1600;
const JSON_HEADERS = { "content-type": "application/json" };

/** §44.6: the comment a `#comment-<id>` link names, or null when the address names none. */
function commentIdInHash(): string | null {
  const match = /^#comment-(.+)$/.exec(window.location.hash);
  return match ? match[1]! : null;
}

/** The browser's Navigation API, where it has one — the only place a link followed with the page
 *  already open is announced when the app's router, not the browser, changed the address. */
interface NavigationLike {
  addEventListener(type: "currententrychange", listener: (e: Event) => void): void;
  removeEventListener(type: "currententrychange", listener: (e: Event) => void): void;
}

export function CommentThread({
  parentType,
  parentId,
  parentNumber,
  authoredAnonymously = false,
  readOnly = false,
  closedNotice = null,
}: {
  parentType: "challenge" | "solution";
  parentId: string;
  /** The item's CH-/SOL- number — enables the §22.13 summary control, and the comment box's mention
   *  list, which offers the people who can see that item (§44.5). */
  parentNumber?: string;
  /** True when the viewer is the ANONYMOUS author of this item — §9 warns them that commenting
   *  shows their real name (comments are never anonymous), without revealing them as the author. */
  authoredAnonymously?: boolean;
  /** §10.4: the item is in the trash — no composer, no reply, edit or delete, no AI summary. */
  readOnly?: boolean;
  /** §10.2 / §42.5: comments are closed (a duplicate, or a solution under one) — no composer and no
   *  Reply; this notice stands in their place. Edit and delete keep their own windows. */
  closedNotice?: string | null;
}) {
  const closed = closedNotice !== null;
  const fmt = useDateFmt();
  const [comments, setComments] = useState<CommentRecord[] | null>(null);
  /** §44.10: the viewer's room under the daily mention cap; undefined (no limit shown) until known. */
  const [mentionsLeftToday, setMentionsLeftToday] = useState<number | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [flashId, setFlashId] = useState<string | null>(null);
  /** The comment to bring into view; `seq` makes a second jump to the same comment a new one. */
  const [jump, setJump] = useState<{ id: string; seq: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The address's `#comment-<id>` is followed once, when the comments first arrive (§44.6). */
  const hashFollowed = useRef(false);

  /** Scroll to a comment and flash it — a reply's "↪ replying to" target, or the comment a
   *  `#comment-<id>` link names — expanding its thread first if it sits behind "Show N more replies". */
  const jumpTo = (target: CommentRecord) => {
    if (target.threadRootId) setExpanded((prev) => new Set(prev).add(target.threadRootId!));
    setJump((prev) => ({ id: target.id, seq: (prev?.seq ?? 0) + 1 }));
    setFlashId(target.id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), FLASH_MS);
  };

  /** §44.6: follow the address's `#comment-<id>` when that comment is in this thread and still
   *  there. A removed one, or one in another thread, is left alone — the page stays where it is. */
  const followHash = (list: readonly CommentRecord[]) => {
    const id = commentIdInHash();
    const target = id === null ? undefined : list.find((c) => c.id === id);
    if (target && !target.deleted) jumpTo(target);
  };

  const refresh = () => {
    fetch(`/api/comments?parentType=${parentType}&parentId=${parentId}`, { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => {
        const list: CommentRecord[] = json.comments ?? [];
        setComments(list);
        setMentionsLeftToday(typeof json.mentionsLeftToday === "number" ? json.mentionsLeftToday : undefined);
        if (!hashFollowed.current) {
          hashFollowed.current = true;
          followHash(list);
        }
      })
      .catch(() => setComments([]));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentType, parentId]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // Runs after the render that expanded the comment's thread, so the comment is in the page.
  useEffect(() => {
    if (!jump) return;
    const el = document.getElementById(`comment-${jump.id}`);
    if (!el) return;
    // §44.6: a comment under a closed solution sits in the collapsed "Closed solutions" section.
    for (let fold = el.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [jump]);

  // §44.6: a comment link followed while this page is already open changes only the address's
  // hash. The browser announces its own change with `hashchange`; a change made by the app's router
  // (the bell's link) reaches the page only through the Navigation API, where the browser has one.
  useEffect(() => {
    if (comments === null) return;
    const onHashChange = () => followHash(comments);
    const onEntryChange = (e: Event) => {
      if ((e as Event & { navigationType?: string | null }).navigationType === "push") followHash(comments);
    };
    const navigation = (window as unknown as { navigation?: NavigationLike }).navigation;
    window.addEventListener("hashchange", onHashChange);
    navigation?.addEventListener("currententrychange", onEntryChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      navigation?.removeEventListener("currententrychange", onEntryChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribed whenever the comments change
  }, [comments]);

  /** Posts a comment (§44.10): null once it is saved, or the refusal's message for the box. */
  const submit = async (body: string, mentions: MentionCandidate[], replyTo: string | null): Promise<string | null> => {
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(replyTo ? { parentType, parentId, body, replyTo, mentions } : { parentType, parentId, body, mentions }),
    });
    const json = await readJson(res);
    if (!res.ok) return json.error ?? "Could not post comment";
    reportFeatureUse("comment"); // §13.10 first use
    return null;
  };

  const post = async (body: string, mentions: MentionCandidate[]): Promise<string | null> => {
    const error = await submit(body, mentions, null);
    // Also after a refusal: a cap may have been reached elsewhere, and the box shows the room left.
    refresh();
    return error;
  };

  const postReply = async (body: string, mentions: MentionCandidate[]): Promise<string | null> => {
    if (!reply) return null;
    const error = await submit(body, mentions, reply.replyToId);
    if (error === null) {
      // The new reply is the newest in its thread: open the thread so it is in view.
      setExpanded((prev) => new Set(prev).add(reply.rootId));
      setReply(null);
    }
    // A 422 means the comment was removed meanwhile — re-read so the thread shows it.
    refresh();
    return error;
  };

  const openReply = (target: CommentRecord) => {
    setReply({ rootId: target.threadRootId ?? target.id, replyToId: target.id, replyToName: target.authorDisplayName });
  };

  /** Saves an edit (§44.10). The web always sends the Mentioned row, so a name taken out of the
   *  text stops being a mention and one left in keeps its person. */
  const saveEdit = async (id: string, body: string, mentions: MentionCandidate[]): Promise<string | null> => {
    const res = await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ body, mentions }),
    });
    const json = await readJson(res);
    if (res.ok) setEditingId(null);
    refresh();
    return res.ok ? null : (json.error ?? "Could not save comment");
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this comment?")) return;
    const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) refresh();
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
    // A comment removed while its edit box was open shows its placeholder, not the box.
    const editing = editingId === c.id && !c.deleted && !readOnly;
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
          {!c.deleted && <ViaAgentTag via={c.viaAgent} flush />}
          <span className="sub mono">{fmt.dateTime(c.createdAt)}</span>
          {c.editedAt && !c.deleted && <span className="chip">edited</span>}
        </div>
        {editing ? (
          // §44.2: the edit opens with the comment's display text and its current mentions picked.
          <CommentBox
            key={`edit-${c.id}`}
            mode="edit"
            label="Edit comment"
            initialText={c.body}
            initialMentions={c.mentions}
            canSee={parentNumber}
            mentionsLeft={c.mentionsLeft ?? undefined}
            mentionsLeftToday={mentionsLeftToday}
            autoFocus
            onSubmit={(body, mentions) => saveEdit(c.id, body, mentions)}
            onCancel={() => setEditingId(null)}
          />
        ) : c.deleted ? (
          // §44.7: a removed comment shows its placeholder only — no text, formatting, links or mentions.
          <p style={{ margin: 0, fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontStyle: "italic", color: "var(--muted)" }}>{c.body}</p>
        ) : (
          <CommentMarkdown body={c.body} mentions={c.mentions} />
        )}
        {/* A removed comment can't be answered, edited or deleted again. */}
        {!c.deleted && !readOnly && !editing && (
          <div style={{ display: "flex", gap: 8 }}>
            {!closed && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => openReply(c)}>
                Reply
              </button>
            )}
            {c.canEdit && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingId(c.id)}>
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
                {reply?.rootId === root.id && !readOnly && !closed && (
                  <CommentBox
                    key={`composer-${reply.replyToId}`}
                    mode="reply"
                    className="row comment-reply"
                    heading={<span className="sub">Replying to {reply.replyToName}</span>}
                    placeholder="Write a reply…"
                    label={`Reply to ${reply.replyToName}`}
                    canSee={parentNumber}
                    mentionsLeftToday={mentionsLeftToday}
                    autoFocus
                    onSubmit={postReply}
                    onCancel={() => setReply(null)}
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      )}
      {closed && !readOnly && (
        <p className="muted comments-closed" data-testid="comments-closed" style={{ margin: 0, fontSize: 13.5 }}>
          {closedNotice}
        </p>
      )}
      {authoredAnonymously && !readOnly && !closed && (
        <p className="sub" style={{ margin: "0 0 8px", color: "var(--warn, var(--faint))" }}>
          You submitted this anonymously. Commenting won&apos;t reveal you as the author, but your name is shown on the comment itself (comments are never anonymous).
        </p>
      )}
      {!readOnly && !closed && (
        <CommentBox
          mode="post"
          placeholder="Add a comment…"
          label={parentNumber ? `Add a comment on ${parentNumber}` : "Add a comment"}
          canSee={parentNumber}
          mentionsLeftToday={mentionsLeftToday}
          onSubmit={post}
        />
      )}
    </div>
  );
}
