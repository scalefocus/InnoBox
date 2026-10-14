"use client";
// The access-list editor of a challenge shared with specific people (INNOBOX_SPEC.md §4.3): the
// §24.5 Accept dialog and the detail page's visibility control. A tag field where typing searches
// active users (the §7.3 directory, unfiltered by the challenge) — picking a result adds that user
// as a tag. A typed string that is a valid e-mail and matches no result is committed as a PENDING
// entry with Enter or comma, marked "No InnoBox user yet": it grants nothing until a user with that
// address is provisioned. Duplicates are refused inline; each tag has a ✕; Backspace in an empty
// field removes the last tag. Admins only ever see this — nobody else learns who is on a list.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ACCESS_LIST_MAX,
  PENDING_ACCESS_LABEL,
  TAG_DUPLICATE,
  checkEmailTag,
  normalizeAccessEmail,
  type AccessEntryView,
  type AccessListInput,
} from "@innobox/shared/challenge-access";
import { FloatingResults } from "@/components/FloatingResults";
import { UserResultButton, type UserResult } from "@/components/UserResultButton";

export type AccessTag = { kind: "user"; id: string; displayName: string; email: string | null } | { kind: "pending"; email: string };

/** The list as the API takes it. */
export function accessTagsToInput(tags: readonly AccessTag[]): AccessListInput {
  return {
    userIds: tags.flatMap((t) => (t.kind === "user" ? [t.id] : [])),
    emails: tags.flatMap((t) => (t.kind === "pending" ? [t.email] : [])),
  };
}

/** The tags for a list the API returned (the detail payload's `access`). */
export function accessTagsFromView(entries: readonly AccessEntryView[]): AccessTag[] {
  return entries.map((e) =>
    e.user ? { kind: "user", id: e.user.id, displayName: e.user.displayName, email: e.user.email } : { kind: "pending", email: e.email ?? "" },
  );
}

const NOT_AN_ADDRESS = "Pick a person from the list, or enter a full e-mail address.";

function tagKey(t: AccessTag): string {
  return t.kind === "user" ? `u:${t.id}` : `e:${t.email}`;
}

export function AccessListEditor({
  id,
  tags,
  onChange,
  disabled = false,
}: {
  id: string;
  tags: AccessTag[];
  onChange: (tags: AccessTag[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const errorId = `${id}-error`;

  // Directory search as the admin types (two characters or more); a stale answer never overwrites
  // a newer one.
  useEffect(() => {
    const q = text.trim();
    const seq = ++searchSeq.current;
    if (q.length < 2) {
      const clear = window.setTimeout(() => setResults([]), 0);
      return () => window.clearTimeout(clear);
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`, { headers: { accept: "application/json" } });
        const json = (await res.json()) as { users?: UserResult[] };
        if (seq === searchSeq.current) setResults(json.users ?? []);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [text]);

  const full = tags.length >= ACCESS_LIST_MAX;

  const addUser = (user: UserResult) => {
    if (tags.some((t) => t.kind === "user" && t.id === user.id)) {
      setError(TAG_DUPLICATE);
      return;
    }
    if (full) {
      setError(`An access list holds at most ${ACCESS_LIST_MAX} people.`);
      return;
    }
    // A pending entry for the same address is now the user's.
    const mail = user.email ? normalizeAccessEmail(user.email) : null;
    onChange([...tags.filter((t) => !(t.kind === "pending" && t.email === mail)), { kind: "user", id: user.id, displayName: user.displayName, email: user.email }]);
    setText("");
    setResults([]);
    setError(null);
    inputRef.current?.focus();
  };

  const commitText = () => {
    if (text.trim() === "") return;
    const check = checkEmailTag(
      text,
      tags.flatMap((t) => (t.kind === "pending" ? [t.email] : t.email ? [t.email] : [])),
    );
    if (!check.ok) {
      setError(check.error === TAG_DUPLICATE ? TAG_DUPLICATE : NOT_AN_ADDRESS);
      return;
    }
    // The address belongs to a user the search already found: add the user, not a pending entry.
    const match = results.find((u) => u.email && normalizeAccessEmail(u.email) === check.value);
    if (match) {
      addUser(match);
      return;
    }
    if (full) {
      setError(`An access list holds at most ${ACCESS_LIST_MAX} people.`);
      return;
    }
    onChange([...tags, { kind: "pending", email: check.value }]);
    setText("");
    setResults([]);
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitText();
    } else if (e.key === "Backspace" && text === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
      setError(null);
    } else if (e.key === "Escape") {
      setResults([]);
    }
  };

  const remove = (tag: AccessTag) => {
    onChange(tags.filter((t) => tagKey(t) !== tagKey(tag)));
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div>
      <div className={`tag-field${error ? " has-error" : ""}`} onClick={() => inputRef.current?.focus()}>
        {tags.length > 0 && (
          <ul className="tag-list" aria-label="People with access">
            {tags.map((tag) => {
              const label = tag.kind === "user" ? tag.displayName : tag.email;
              return (
                <li key={tagKey(tag)} className={`tag${tag.kind === "pending" ? " is-pending" : ""}`}>
                  <span className="tag-label" title={tag.kind === "user" && tag.email ? `${tag.displayName} (${tag.email})` : label}>
                    {label}
                  </span>
                  {tag.kind === "pending" && <span className="tag-note">{PENDING_ACCESS_LABEL}</span>}
                  <button type="button" className="tag-remove" aria-label={`Remove ${label}`} disabled={disabled} onClick={() => remove(tag)}>
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <input
          id={id}
          ref={inputRef}
          className="tag-input"
          type="text"
          autoComplete="off"
          disabled={disabled}
          value={text}
          placeholder={tags.length === 0 ? "Search people by name or e-mail…" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {results.length > 0 && (
        <FloatingResults anchorRef={inputRef} onClose={() => setResults([])}>
          {results.map((u) => (
            <UserResultButton key={u.id} user={u} disabled={disabled} onClick={() => addUser(u)} />
          ))}
        </FloatingResults>
      )}
      {error ? (
        <div id={errorId} className="tag-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="access-editor-hint">
          {tags.length} / {ACCESS_LIST_MAX} · An address with no InnoBox user yet is kept, and grants access once that person is set up.
        </div>
      )}
    </div>
  );
}
