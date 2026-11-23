"use client";
// The comment box (INNOBOX_SPEC.md §44.2): the one box a new comment, a reply and an edit are written
// in, in place of the three single-line fields the thread used to have.
//   - A plain multi-line text box, three lines tall, growing with its text up to twelve lines and
//     scrolling after that; at most 5 000 characters (§10.2).
//   - Two tabs above it, Markdown (selected first) and Preview. Preview shows, in place of the text
//     box, the comment exactly as the thread will show it — the same CommentMarkdown, with its
//     mentions as a save will bind them (§44.5). Switching tabs never changes the text, the button
//     works from either tab, and after a post the box is empty and back on Markdown.
//   - Keys: Enter makes a new line; Ctrl+Enter (⌘+Enter) posts or saves exactly as the button does;
//     Escape closes a reply or an edit box — unless the mention list is open, which it closes first.
//   - Mentions: `@` opens the §43.3 mention list over the people who can read this thread, and the
//     Mentioned row under the box is the certain record of who a save will tell. At a cap the list
//     does not open and the row's line reads the cap's message.
//   - The buttons under the box: Post, Reply or Save, with Cancel on a reply and an edit. A refusal
//     is shown under the box and keeps the text.
// The thread owns the requests: `onSubmit` resolves to null once the comment is saved, or to the
// refusal's message.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  COMMENT_MARKDOWN_HINT,
  COMMENT_MENTION_HINT_POST,
  COMMENT_MENTION_HINT_SAVE,
  COMMENT_MENTION_MESSAGES,
  COMMENT_PREVIEW_EMPTY,
  MENTIONS_PER_COMMENT,
  bindMentions,
  renderMentions,
  type MentionCandidate,
} from "@innobox/shared/mentions";
import { CommentMarkdown, type CommentMentionView } from "./CommentMarkdown";
import { MentionTextarea, MentionedRow, mentionedPeople, useMentions, type MentionPerson } from "./Mentions";

/** §10.2: a comment's limit — `COMMENT_BODY_MAX`, which the shared package exports server-side only. */
const COMMENT_MAX = 5000;

export type CommentBoxMode = "post" | "reply" | "edit";

/** The button, the line under the Mentioned row, and what the box says when a request fails outright. */
const COPY: Record<CommentBoxMode, { submit: string; told: string; failed: string }> = {
  post: { submit: "Post", told: COMMENT_MENTION_HINT_POST, failed: "Could not post comment" },
  reply: { submit: "Reply", told: COMMENT_MENTION_HINT_POST, failed: "Could not post reply" },
  edit: { submit: "Save", told: COMMENT_MENTION_HINT_SAVE, failed: "Could not save comment" },
};

type Tab = "write" | "preview";
const TABS: readonly { key: Tab; name: string }[] = [
  { key: "write", name: "Markdown" },
  { key: "preview", name: "Preview" },
];

/**
 * §44.2: three lines tall, growing with the text up to twelve — the min- and max-height in
 * globals.css — and scrolling after that. A box that is not shown (under Preview, or in a section
 * that is folded away) measures as zero and is left as it is.
 */
function fitToText(box: HTMLTextAreaElement | null): void {
  if (!box || box.offsetParent === null) return;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
}

/**
 * §44.2: the text as the thread will show it once saved — trimmed, with each picked person the text
 * still names bound exactly as the server will bind them (§43.2) — and where each mention sits in it.
 */
function previewOf(text: string, people: readonly MentionPerson[], inactive: ReadonlySet<string>): { body: string; mentions: CommentMentionView[] } {
  const byId = new Map(people.map((p) => [p.id.toLowerCase(), p]));
  const stored = bindMentions(
    text.replace(/\r\n?/g, "\n").trim(),
    people.map((p) => ({ userId: p.id, name: p.displayName })),
  ).text;
  const shown = renderMentions(stored, (userId) => byId.get(userId)?.displayName ?? "");
  return {
    body: shown.text,
    mentions: shown.ranges.map((range) => {
      const person = byId.get(range.userId);
      return {
        start: range.start,
        length: range.length,
        user: person ? { id: person.id, displayName: person.displayName, active: !inactive.has(range.userId) } : null,
      };
    }),
  };
}

export function CommentBox({
  mode,
  placeholder,
  label,
  heading,
  initialText = "",
  initialMentions,
  canSee,
  mentionsLeft = MENTIONS_PER_COMMENT,
  mentionsLeftToday,
  autoFocus = false,
  className,
  onSubmit,
  onCancel,
}: {
  mode: CommentBoxMode;
  placeholder?: string;
  /** The text box's accessible name. */
  label: string;
  /** A line above the tabs — the reply box's "Replying to <name>". */
  heading?: ReactNode;
  /** An edit opens with the comment's display text and its current mentions picked (§44.5). */
  initialText?: string;
  initialMentions?: readonly CommentMentionView[];
  /** "CH-12" or "SOL-34": whose readers the mention list offers. Without it the box has no list. */
  canSee?: string;
  /** Room under the per-comment cap: the comment's own on an edit, the whole cap otherwise (§44.5). */
  mentionsLeft?: number;
  /** Room under the viewer's daily cap; unlimited when the thread did not report it. */
  mentionsLeftToday?: number;
  /** Put the caret in the box when it opens (a reply, an edit). */
  autoFocus?: boolean;
  className?: string;
  /** Saves the comment: resolves to null when it is saved, or to the refusal's message. */
  onSubmit: (body: string, mentions: MentionCandidate[]) => Promise<string | null>;
  /** A reply and an edit can be closed without saving — the Cancel button and Escape. */
  onCancel?: () => void;
}) {
  const id = useId();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [tab, setTab] = useState<Tab>("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mentions = useMentions({ texts: [text], initial: mentionedPeople(initialMentions), left: mentionsLeft, leftToday: mentionsLeftToday });
  // A deactivated person the comment already mentions stays muted in the preview (§43.7); anyone
  // picked from the list is active, or the save is refused.
  const inactive = useMemo(
    () => new Set((initialMentions ?? []).flatMap((m) => (m.user && !m.user.active ? [m.user.id.toLowerCase()] : []))),
    [initialMentions],
  );
  const copy = COPY[mode];
  const empty = text.trim() === "";

  // The box follows its text — and its width, since a narrower box wraps the same text onto more
  // lines (a rotated phone, a resized window).
  useLayoutEffect(() => fitToText(boxRef.current), [text, tab]);
  useEffect(() => {
    const onResize = () => fitToText(boxRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A reply or an edit opens with the caret in the box, after the text it already holds.
  useEffect(() => {
    const box = boxRef.current;
    if (!autoFocus || !box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [autoFocus]);

  const preview = useMemo(() => (tab === "preview" && !empty ? previewOf(text, mentions.bound, inactive) : null), [tab, empty, text, mentions.bound, inactive]);

  const submit = async () => {
    if (busy || empty) return;
    setBusy(true);
    setError(null);
    try {
      const refusal = await onSubmit(text, mentions.payload());
      if (refusal === null) {
        // What a new-comment box shows next; a reply or an edit box is closed by its thread.
        setText("");
        setTab("write");
        mentions.reset();
      } else {
        setError(refusal); // the text stays as typed
      }
    } catch {
      setError(copy.failed);
    } finally {
      setBusy(false);
    }
  };

  // Enter is left to the text box (a new line). The mention list, while open, takes Enter and
  // Escape itself, so these run only when it is closed (§43.3).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && onCancel) {
      onCancel();
    }
  };

  // The two tabs are one tab stop: ← and → move between them, and moving selects.
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setTab(tab === "write" ? "preview" : "write");
    const other = e.currentTarget.nextElementSibling ?? e.currentTarget.previousElementSibling;
    if (other instanceof HTMLElement) other.focus();
  };

  return (
    <form
      className={className ? `comment-box ${className}` : "comment-box"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {heading}
      <div className="srctabs comment-box-tabs" role="tablist" aria-label="Comment text">
        {TABS.map(({ key, name }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-${key}-tab`}
            aria-selected={tab === key}
            aria-controls={`${id}-${key}`}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? "srctab active" : "srctab"}
            onClick={() => setTab(key)}
            onKeyDown={onTabKeyDown}
          >
            {name}
          </button>
        ))}
      </div>
      {/* The text box stays mounted under Preview, so its text, caret and height survive the switch. */}
      <div role="tabpanel" id={`${id}-write`} aria-labelledby={`${id}-write-tab`} hidden={tab !== "write"}>
        <MentionTextarea
          className="field comment-box-text"
          rows={3}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={`${id}-hint`}
          value={text}
          onChange={setText}
          onKeyDown={onKeyDown}
          boxRef={boxRef}
          mentions={mentions}
          canSee={canSee}
          readOnly={busy}
          maxLength={COMMENT_MAX}
        />
        <div className="comment-box-hint" id={`${id}-hint`}>
          {COMMENT_MARKDOWN_HINT}
        </div>
      </div>
      <div role="tabpanel" id={`${id}-preview`} aria-labelledby={`${id}-preview-tab`} hidden={tab !== "preview"} tabIndex={0} className="comment-box-preview">
        {tab === "preview" && (preview ? <CommentMarkdown body={preview.body} mentions={preview.mentions} /> : <span className="muted">{COMMENT_PREVIEW_EMPTY}</span>)}
      </div>
      {/* §44.2: who a save will mention, and when they are told — or the cap that stops the list. */}
      <MentionedRow mentions={mentions} hint={copy.told} capMessage={COMMENT_MENTION_MESSAGES.commentCap} disabled={busy} />
      {error && (
        <span className="comment-box-error" role="alert">
          {error}
        </span>
      )}
      <div className="comment-box-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || empty}>
          {copy.submit}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
