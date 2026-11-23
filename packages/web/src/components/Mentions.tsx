"use client";
// Mentions in a solution's text (INNOBOX_SPEC.md §43.3, §43.7) and in a comment (§44.2, §44.7):
//   - useMentions      — the people a form has picked, and which of them the text still names;
//   - MentionTextarea  — a plain text box with the mention list: typing `@` and two characters
//                        searches the colleagues who can see the item, anchored under the box;
//   - MentionedRow     — the chips of the people a save will mention, with the hint under them;
//   - MentionText      — solution text on the detail page, each mention a link to the person that
//                        opens the §13.8 directory card;
//   - MentionLink      — that link on its own, for a mention in a rendered comment (§44.7).
// The text box stays a plain <textarea> (§43 decision 13): a pick inserts "@Name" as ordinary text,
// and the row — computed with the same binding rule the server applies — is the certain record of who
// will be told. The list searches GET /api/users?q=&canSee=<CH-n>, the §39.2 picker, unchanged — or
// canSee=<SOL-n> under a solution's comment thread (§44.5).
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  MENTIONED_ROW_LABEL,
  MENTIONS_PER_SOLUTION,
  MENTION_ANONYMOUS_WARNING,
  MENTION_LIST_SIZE,
  MENTION_MESSAGES,
  MENTION_SEARCH_DELAY_MS,
  activeMentionQuery,
  boundUserIds,
  insertMention,
  mentionHint,
  type MentionCandidate,
} from "@innobox/shared/mentions";
import type { SolutionStatus } from "@innobox/shared";
import { readJson } from "@/lib/api-client";
import { profileHref } from "@/lib/directory-card";
import { AvatarBubble } from "./AvatarBubble";
import { useDirectoryCard } from "./DirectoryCard";
import { FloatingResults } from "./FloatingResults";
import type { UserResult } from "./UserResultButton";

/** Where a mention sits in a solution's display text, and whom it names (§43.11). */
export interface MentionView {
  field: "description" | "costVsBenefits";
  start: number;
  length: number;
  /** Null for an erased person: plain "@Deleted User", no link and no card. */
  user: { id: string; displayName: string; active: boolean } | null;
}

/** A person a form has picked from the mention list. */
export interface MentionPerson {
  id: string;
  displayName: string;
}

/** Which cap, if any, stops this form from mentioning anyone new (§43.5, §44.5). `"solution"` is the
 *  per-item cap — a solution's, or a comment's in the comment box. */
export type MentionCap = "solution" | "day" | null;

export interface MentionsState {
  /** The picked people the text still names — the chips, and what a save sends. */
  bound: MentionPerson[];
  /** Their names, for the composer: an `@` that already begins one opens no list. */
  boundNames: string[];
  cap: MentionCap;
  pick: (person: MentionPerson) => void;
  unpick: (id: string) => void;
  reset: () => void;
  /** The request's `mentions: [{ userId, name }]` (§43.11). */
  payload: () => MentionCandidate[];
}

/** The item's current mentions as picked people — what the edit form of a solution (§43.3) or of a
 *  comment (§44.2) starts with. */
export function mentionedPeople(mentions: readonly Pick<MentionView, "user">[] | undefined): MentionPerson[] {
  const seen = new Map<string, MentionPerson>();
  for (const m of mentions ?? []) if (m.user && !seen.has(m.user.id)) seen.set(m.user.id, { id: m.user.id, displayName: m.user.displayName });
  return [...seen.values()];
}

/**
 * The mentions of one solution form, or of one comment box. A person is `bound` — has a chip —
 * exactly while they are picked AND binding finds their name in one of the texts (§43.3), so editing
 * the inserted name drops the chip and typing it back restores it. `left` is the room under the
 * per-item cap for people beyond `initial` (the ones the item already mentions) — a solution's by
 * default, the comment box passes a comment's (§44.5) — and `leftToday` under the daily cap.
 */
export function useMentions(opts: {
  texts: readonly string[];
  initial?: readonly MentionPerson[];
  left?: number;
  leftToday?: number;
}): MentionsState {
  const { texts, left = MENTIONS_PER_SOLUTION, leftToday = Number.POSITIVE_INFINITY } = opts;
  const [initial] = useState<MentionPerson[]>(() => [...(opts.initial ?? [])]);
  const [picked, setPicked] = useState<MentionPerson[]>(initial);
  const joined = texts.join("\u0000");
  const bound = useMemo(() => {
    const ids = boundUserIds(
      joined.split("\u0000"),
      picked.map((p) => ({ userId: p.id, name: p.displayName })),
    );
    return picked.filter((p) => ids.includes(p.id));
  }, [joined, picked]);
  const added = bound.filter((p) => !initial.some((i) => i.id === p.id)).length;
  const cap: MentionCap = left - added <= 0 ? "solution" : leftToday - added <= 0 ? "day" : null;
  return {
    bound,
    boundNames: bound.map((p) => p.displayName),
    cap,
    pick: (person) => setPicked((cur) => (cur.some((p) => p.id === person.id) ? cur : [...cur, person])),
    unpick: (id) => setPicked((cur) => cur.filter((p) => p.id !== id)),
    reset: () => setPicked([]),
    payload: () => bound.map((p) => ({ userId: p.id, name: p.displayName })),
  };
}

/**
 * §43.3: a text box with the mention list. Everything about it is a plain <textarea> — paste, file
 * drop, the drafting aid and the submission lock work as before — plus: `@` and at least two
 * characters open a list of the colleagues who can see the item, anchored to the box's
 * bottom-left corner; ↑/↓ move, Enter or Tab picks, Escape closes and leaves the text alone.
 * A key the list does not take is handed to the caller's `onKeyDown` (the comment box's
 * Ctrl+Enter and Escape, §44.2).
 */
export function MentionTextarea({
  value,
  onChange,
  mentions,
  canSee,
  challengeNumber,
  listLabel = "Colleagues to mention",
  onKeyDown: onOtherKeyDown,
  boxRef,
  ...rest
}: {
  value: string;
  onChange: (next: string) => void;
  mentions: MentionsState;
  /** "CH-12" or "SOL-34" — the list offers the people who can see this challenge, or this solution
   *  (§44.5). With neither this nor `challengeNumber` the list never opens. */
  canSee?: string;
  /** "CH-12" — `canSee` under the name the solution forms give it. */
  challengeNumber?: string;
  listLabel?: string;
  /** Runs for every key the mention list does not handle itself. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The caller's own handle on the text box, when it needs to focus or measure it. */
  boxRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  rows?: number;
  maxLength?: number;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = boxRef ?? ownRef;
  const searchIn = canSee ?? challengeNumber ?? null;
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** The `@` whose list Escape closed — it stays closed until another `@` is typed. */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  /** What the last search found, and for which query. */
  const [found, setFound] = useState<{ start: number; query: string; users: UserResult[] } | null>(null);
  /** A query that found nobody: a longer one starting with it finds nobody either, so it isn't sent. */
  const emptyFor = useRef<{ start: number; query: string } | null>(null);
  /** Where the caret goes once a pick's new text has rendered. */
  const pendingCaret = useRef<number | null>(null);

  const listOff = searchIn === null || rest.readOnly === true || rest.disabled === true || mentions.cap !== null;
  const query = !focused || listOff ? null : activeMentionQuery(value, caret, mentions.boundNames);
  const active = query && query.start !== dismissedStart ? query : null;
  const activeStart = active?.start ?? null;
  const activeQuery = active?.query ?? null;

  useEffect(() => {
    if (activeStart === null || activeQuery === null || searchIn === null) return;
    const dead = emptyFor.current;
    if (dead && dead.start === activeStart && activeQuery.startsWith(dead.query)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetch(`/api/users?q=${encodeURIComponent(activeQuery)}&canSee=${encodeURIComponent(searchIn)}`)
        .then((res) => readJson(res))
        .then((json) => {
          if (cancelled) return;
          const users = ((json.users as UserResult[] | undefined) ?? []).slice(0, MENTION_LIST_SIZE);
          if (users.length === 0) emptyFor.current = { start: activeStart, query: activeQuery };
          setFound({ start: activeStart, query: activeQuery, users });
          setHighlight(0);
        })
        .catch(() => {
          /* the list simply stays closed; the text is untouched */
        });
    }, MENTION_SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeStart, activeQuery, searchIn]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    ref.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value, ref]);

  // The list shows what was found for THIS `@`; while a longer query is on its way it keeps the
  // previous rows rather than flickering shut.
  const users = active && found && found.start === active.start && active.query.startsWith(found.query) ? found.users : [];
  const open = active !== null && users.length > 0;
  const listId = `${id}-mentions`;

  const pick = (user: UserResult) => {
    if (!active) return;
    const next = insertMention(value, active.start, caret, user.displayName);
    pendingCaret.current = next.caret;
    mentions.pick({ id: user.id, displayName: user.displayName });
    setCaret(next.caret);
    setFound(null);
    onChange(next.text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The open list takes its own keys; every other key — and every key while it is closed — is the
    // caller's, so Escape closes the list first and only then the caller's box (§44.2).
    if (!open) return onOtherKeyDown?.(e);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : users.length - 1)) % users.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const user = users[Math.min(highlight, users.length - 1)];
      if (!user) return;
      e.preventDefault(); // while the list is open, Enter does not break the line
      pick(user);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissedStart(active.start);
    } else {
      onOtherKeyDown?.(e);
    }
  };

  return (
    <>
      <textarea
        {...rest}
        ref={ref}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open ? `${listId}-${Math.min(highlight, users.length - 1)}` : undefined}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          onChange(e.target.value);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <FloatingResults anchorRef={ref} maxWidth={320} onClose={() => active && setDismissedStart(active.start)}>
          <div id={listId} role="listbox" aria-label={listLabel} className="mention-options">
            {users.map((u, i) => (
              <button
                key={u.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`user-result-item mention-option${i === highlight ? " is-active" : ""}`}
                title={u.email ? `${u.displayName} (${u.email})` : u.displayName}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(u)}
              >
                {/* noCard (§13.8): a bubble inside an open popover opens no card. */}
                <AvatarBubble size="sm" userId={u.id} displayName={u.displayName} noCard />
                <span className="user-result-text">
                  <span className="user-result-name">{u.displayName}</span>
                  {u.email && <span className="user-result-mail">{u.email}</span>}
                </span>
              </button>
            ))}
          </div>
        </FloatingResults>
      )}
    </>
  );
}

/**
 * §43.3: the *Mentioned* row under a solution form's text boxes — one chip per person a save will
 * mention, the ✕ un-picking them (their name stays in the text as ordinary words), and one muted
 * line under it: when they will be told, or the cap that stops the list. It shows nothing about
 * what became of a mention (§43 decision 12). Renders nothing while there is no chip and no cap.
 * The comment box (§44.2) shows the same row with its own two lines: `hint` and `capMessage`.
 */
export function MentionedRow({
  mentions,
  status = null,
  anonymous = false,
  disabled = false,
  hint,
  capMessage = MENTION_MESSAGES.solutionCap,
}: {
  mentions: MentionsState;
  /** The solution's status on the edit form; null on the propose form. */
  status?: SolutionStatus | null;
  /** The form's *Submit anonymously* box, or an anonymous solution being edited. */
  anonymous?: boolean;
  disabled?: boolean;
  /** When the people will be told, in place of the line a solution's `status` gives. */
  hint?: string;
  /** What the line reads at the per-item cap — a solution's unless given. */
  capMessage?: string;
}) {
  const { bound, cap } = mentions;
  if (bound.length === 0 && cap === null) return null;
  return (
    <div className="mentioned-row" data-testid="mentioned-row">
      {bound.length > 0 && (
        <div className="mentioned-row-people">
          <span className="mentioned-row-label">{MENTIONED_ROW_LABEL}</span>
          <ul className="tag-list-static" aria-label="Mentioned people">
            {bound.map((p) => (
              <li key={p.id} className="tag mention-chip">
                <AvatarBubble size="sm" userId={p.id} displayName={p.displayName} noCard />
                <span className="tag-label">{p.displayName}</span>
                <button type="button" className="tag-remove" aria-label={`Remove mention of ${p.displayName}`} disabled={disabled} onClick={() => mentions.unpick(p.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="access-editor-hint">
        {cap === "solution" ? capMessage : cap === "day" ? MENTION_MESSAGES.dailyCap : (hint ?? mentionHint(status))}
      </div>
      {anonymous && bound.length > 0 && <div className="access-editor-hint mention-anonymous-warning">{MENTION_ANONYMOUS_WARNING}</div>}
    </div>
  );
}

/** One mention on the detail page — in a solution's text (§43.7) or in a comment (§44.7): a link to
 *  the person that opens the §13.8 directory card on hover, keyboard focus or press-and-hold — the
 *  one trigger of that card that is a name. A deactivated person's is muted and still links. */
export function MentionLink({ user, label }: { user: NonNullable<MentionView["user"]>; label: string }) {
  const { triggerProps, card } = useDirectoryCard({
    userId: user.id,
    displayName: user.displayName,
    enabled: true,
    avatar: (ring) => <AvatarBubble size="md" userId={user.id} displayName={user.displayName} deactivated={!user.active} noCard ring={ring} />,
  });
  return (
    <>
      {/* The card's trigger props carry role="button"; this stays a link. */}
      <Link className={`mention${user.active ? "" : " mention-off"}`} href={profileHref(user.id, null)} {...(triggerProps ?? {})} role={undefined}>
        {label}
      </Link>
      {card}
    </>
  );
}

/**
 * §43.7: a solution's display text with its mentions. Each range of `field` becomes the person's
 * name as a link; an erased person's "@Deleted User" is muted plain text. A range that does not fit
 * the text — a payload from an older page — is ignored, so the text always renders in full.
 */
export function MentionText({ text, mentions, field }: { text: string; mentions: readonly MentionView[] | undefined; field: MentionView["field"] }): ReactNode {
  const ranges = (mentions ?? [])
    .filter((m) => m.field === field && m.start >= 0 && m.length > 1 && m.start + m.length <= text.length && text.charAt(m.start) === "@")
    .sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of ranges) {
    if (m.start < at) continue; // overlapping ranges never come from the server; be safe
    if (m.start > at) parts.push(text.slice(at, m.start));
    const label = text.slice(m.start, m.start + m.length);
    parts.push(
      m.user ? (
        <MentionLink key={`${m.start}-${m.user.id}`} user={m.user} label={label} />
      ) : (
        <span key={`${m.start}-deleted`} className="mention mention-deleted">
          {label}
        </span>
      ),
    );
    at = m.start + m.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
