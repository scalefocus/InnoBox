"use client";
// Co-author teams on the detail page and the submit forms (INNOBOX_SPEC.md §39.2, §39.4, §39.7):
//   - TeamFullNames  — the full form for headers: every member in order, bubble and name;
//   - TeamPanel      — for a member of the item: the team with Add co-author (the picker, while
//                      joining is open and the team has fewer than five), a ✕ on each other member
//                      — never on the creator, whose row carries a small "Creator" tag instead until
//                      they are erased — and Leave (unless they are the only member). Removing asks
//                      for confirmation; leaving asks too, and says the leave is final;
//   - CoAuthorPicker — the co-author field on both submit forms (up to four).
// Every picker searches GET /api/users with the §39.2 eligibility variant, so it only ever offers
// people who can be added; the server re-checks every add.
import { useEffect, useState } from "react";
import { CO_AUTHORS_MAX, TEAM_MAX, TEAM_MESSAGES } from "@innobox/shared/coauthors";
import { readJson } from "@/lib/api-client";
import { cachedGet } from "@/lib/ui";
import { PersonBubble, type TeamPerson } from "./TeamByline";
import { UserResultButton, type UserResult } from "./UserResultButton";

/** A detail-payload member: the masked shape plus the Team panel's `creator` flag. */
export interface TeamMember extends TeamPerson {
  creator?: boolean;
}

/** The full form (§39.7): every member in order, bubble and name. A solo item is one entry. */
export function TeamFullNames({ authors }: { authors: readonly TeamPerson[] }) {
  return (
    <span className="team-full">
      {authors.map((a, i) => (
        <span key={a.userId ?? `p${i}`} className="team-full-item">
          {authors.length > 1 && <PersonBubble person={a} />}
          <span>{a.anonymous ? "Anonymous" : a.displayName}</span>
        </span>
      ))}
    </span>
  );
}

/** Search the §39.2 eligible people for a picker. `variant` is the query string after `q=`. */
async function searchEligible(q: string, variant: string): Promise<UserResult[]> {
  if (q.trim().length < 2) return [];
  const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&${variant}`);
  const json = await readJson(res);
  return (json.users as UserResult[]) ?? [];
}

/** The detail page's Team panel — rendered only for a member of the item (`isMine`). */
export function TeamPanel({
  itemNumber,
  authors,
  canManageTeam,
  canLeave,
  onChanged,
  onError,
}: {
  /** "CH-12" / "SOL-34". */
  itemNumber: string;
  authors: readonly TeamMember[];
  canManageTeam: boolean;
  canLeave: boolean;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [busy, setBusy] = useState(false);
  // The viewer's own row: "(you)", no ✕, and the id Leave sends.
  const [viewerId, setViewerId] = useState<string | null>(null);
  useEffect(() => {
    cachedGet<{ user: { id: string } }>("/api/me")
      .then((me) => setViewerId(me.user.id))
      .catch(() => {});
  }, []);
  const isSolution = itemNumber.startsWith("SOL-");
  const base = isSolution ? `/api/solutions/${itemNumber.replace("SOL-", "")}/authors` : `/api/challenges/${itemNumber.replace("CH-", "")}/authors`;
  const canAdd = canManageTeam && authors.length < TEAM_MAX;

  const run = async (request: () => Promise<Response>, fallback: string) => {
    setBusy(true);
    try {
      const res = await request();
      const json = await readJson(res);
      if (!res.ok) throw new Error((json.error as string) ?? fallback);
      setQuery("");
      setResults([]);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const add = (userId: string) =>
    run(() => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) }), "Could not add the co-author");
  const remove = (member: TeamMember) => {
    if (!window.confirm(`Remove ${member.displayName} from the team of ${itemNumber}?`)) return;
    void run(() => fetch(`${base}/${member.userId}`, { method: "DELETE" }), "Could not remove the co-author");
  };
  const leave = () => {
    if (!window.confirm(`Leave the team of ${itemNumber}? You keep your points, but you can't be added back to this item.`)) return;
    void run(() => fetch(`${base}/${viewerId}`, { method: "DELETE" }), "Could not leave the team");
  };
  const search = async (q: string) => {
    setQuery(q);
    setResults(await searchEligible(q, `coAuthorFor=${encodeURIComponent(itemNumber)}`));
  };

  return (
    <div className="team-panel" data-testid={`team-panel-${itemNumber}`}>
      <span className="team-panel-label">Team</span>
      <ul className="team-panel-list">
        {authors.map((m, i) => {
          const isViewer = m.userId !== null && m.userId === viewerId;
          // §39.4: nobody else removes the creator — until they are erased.
          const protectedCreator = m.creator === true && m.scrubbed !== true;
          return (
            <li key={m.userId ?? `p${i}`} className="team-panel-member">
              <PersonBubble person={m} />
              <span className="team-panel-name">
                {m.displayName}
                {isViewer && <span className="muted"> (you)</span>}
              </span>
              {protectedCreator && <span className="team-creator-tag">Creator</span>}
              {canManageTeam && !isViewer && !protectedCreator && m.userId && (
                <button type="button" className="tag-remove" aria-label={`Remove ${m.displayName}`} title={`Remove ${m.displayName}`} disabled={busy} onClick={() => remove(m)}>
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {(canAdd || canLeave) && (
        <div className="team-panel-actions">
          {canAdd && (
            <div className="team-panel-add">
              <input
                className="field"
                aria-label="Add co-author"
                placeholder="Add co-author: search by name or email…"
                value={query}
                disabled={busy}
                onChange={(e) => void search(e.target.value)}
              />
              {results.length > 0 && (
                <div className="menu-pop user-search-pop team-panel-results">
                  {results.map((u) => (
                    <UserResultButton key={u.id} user={u} disabled={busy} onClick={() => void add(u.id)} />
                  ))}
                </div>
              )}
            </div>
          )}
          {canLeave && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy || viewerId === null} onClick={leave}>
              Leave
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The co-author field on a submit form (§6.1, §6.2): up to four colleagues, picked from the people
 * who can be added. Disabled — with the hint — while the form is anonymous; the form disables its
 * anonymous box while anyone is picked (§39.3). Nothing is cleared silently.
 */
export function CoAuthorPicker({
  id,
  value,
  onChange,
  variant,
  disabled,
  disabledHint,
}: {
  id: string;
  value: UserResult[];
  onChange: (next: UserResult[]) => void;
  /** The §39.2 search variant — `canSee=CH-12`, or `namespace=<slug>&visibility=org`. */
  variant: string | null;
  disabled: boolean;
  disabledHint?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const full = value.length >= CO_AUTHORS_MAX;
  const search = async (q: string) => {
    setQuery(q);
    if (!variant) return setResults([]);
    const found = await searchEligible(q, variant);
    setResults(found.filter((u) => !value.some((v) => v.id === u.id)));
  };
  const pick = (u: UserResult) => {
    onChange([...value, u]);
    setQuery("");
    setResults([]);
  };
  return (
    <div className="coauthor-picker">
      <div className={`tag-field${disabled ? " is-disabled" : ""}`}>
        <ul className="tag-list" aria-label="Co-authors">
          {value.map((u) => (
            <li key={u.id} className="tag">
              <span className="tag-label">{u.displayName}</span>
              <button type="button" className="tag-remove" aria-label={`Remove ${u.displayName}`} disabled={disabled} onClick={() => onChange(value.filter((v) => v.id !== u.id))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        {!full && (
          <input
            id={id}
            className="tag-input"
            placeholder={value.length === 0 ? "Search colleagues by name or email…" : "Add another…"}
            value={query}
            disabled={disabled}
            aria-describedby={disabled && disabledHint ? `${id}-hint` : undefined}
            onChange={(e) => void search(e.target.value)}
          />
        )}
      </div>
      {results.length > 0 && !disabled && (
        <div className="menu-pop user-search-pop coauthor-results">
          {results.map((u) => (
            <UserResultButton key={u.id} user={u} onClick={() => pick(u)} />
          ))}
        </div>
      )}
      <div id={`${id}-hint`} className="access-editor-hint">
        {disabled && disabledHint ? disabledHint : `Up to ${CO_AUTHORS_MAX} colleagues. Everyone on the team can edit it and earns the credit.`}
      </div>
    </div>
  );
}

/** §39.3: the hint both submit forms show on whichever of the two fields is disabled. */
export const ANONYMOUS_NO_COAUTHORS_HINT = TEAM_MESSAGES.anonymousCreate;
