"use client";
// Platform settings → Innovation board (INNOBOX_SPEC.md §45.2): the one platform-wide list of
// people who read new challenges and solutions before review and are told about each one. A tag
// field of the same kind as the §4.3 access-list editor picks active users from the directory —
// there are no pending e-mail entries here, since early access must not go to an address nobody has
// verified — and **Add to board** adds every tagged person in one call (at most 20). Each member has
// a Remove that asks first. At most 100 members; the API's refusals are shown inline. Platform
// admins only ever see this card: nothing else in the app says who is on the board (§45.7).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  BOARD_CARD_SUBTITLE,
  BOARD_EMPTY,
  BOARD_FULL_HINT,
  INNOVATION_BOARD_ADD_MAX,
  INNOVATION_BOARD_MAX,
  boardRemoveConfirm,
} from "@innobox/shared/innovation-board";
import { AvatarBubble } from "@/components/AvatarBubble";
import { useDateFmt } from "@/components/DateFormat";
import { FloatingResults } from "@/components/FloatingResults";
import { UserResultButton, type UserResult } from "@/components/UserResultButton";
import { invalidateApi } from "@/lib/ui";

interface BoardMember {
  user: { id: string; displayName: string; email: string | null; active: boolean };
  addedAt: string;
  addedBy: { id: string; displayName: string } | null;
}

const ALREADY_PICKED = "That person is already picked.";

export function InnovationBoardCard({ onNotice }: { onNotice?: (m: string) => void }) {
  const fmt = useDateFmt();
  const inputRef = useRef<HTMLInputElement>(null);
  const [members, setMembers] = useState<BoardMember[] | null>(null);
  const [max, setMax] = useState(INNOVATION_BOARD_MAX);
  const [picked, setPicked] = useState<UserResult[]>([]);
  const [text, setText] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const load = useCallback(() => {
    fetch("/api/admin/innovation-board", { headers: { accept: "application/json" } })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "Could not load the innovation board");
        setMembers(json.members as BoardMember[]);
        if (typeof json.max === "number") setMax(json.max);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the innovation board"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Directory search as the admin types (two characters or more); a stale answer never overwrites a
  // newer one. People already on the board, or already picked, are not offered.
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

  const count = members?.length ?? 0;
  const room = Math.max(0, max - count);
  const full = members !== null && room === 0;
  const onBoard = new Set((members ?? []).map((m) => m.user.id));
  const offered = results.filter((u) => !onBoard.has(u.id) && !picked.some((p) => p.id === u.id));

  const pick = (user: UserResult) => {
    if (picked.some((p) => p.id === user.id)) {
      setError(ALREADY_PICKED);
      return;
    }
    if (picked.length >= Math.min(INNOVATION_BOARD_ADD_MAX, room)) {
      setError(
        picked.length >= INNOVATION_BOARD_ADD_MAX
          ? `Add at most ${INNOVATION_BOARD_ADD_MAX} people at a time.`
          : `The innovation board has room for ${room} more ${room === 1 ? "person" : "people"}.`,
      );
      return;
    }
    setPicked([...picked, user]);
    setText("");
    setResults([]);
    setError(null);
    inputRef.current?.focus();
  };

  const unpick = (id: string) => {
    setPicked(picked.filter((p) => p.id !== id));
    setError(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // Only a person picked from the list can be added: free text is never committed.
      e.preventDefault();
      if (offered.length === 1) pick(offered[0]!);
    } else if (e.key === "Backspace" && text === "" && picked.length > 0) {
      setPicked(picked.slice(0, -1));
      setError(null);
    } else if (e.key === "Escape") {
      setResults([]);
    }
  };

  const add = async () => {
    if (picked.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/innovation-board/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: picked.map((p) => p.id) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add to the innovation board");
      const added = Array.isArray(json.added) ? json.added.length : 0;
      setPicked([]);
      // The forms' board line and the admin's own profile line read `me`.
      invalidateApi("/api/me");
      load();
      onNotice?.(added === 1 ? "1 person added to the innovation board." : `${added} people added to the innovation board.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add to the innovation board");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (member: BoardMember) => {
    if (!window.confirm(boardRemoveConfirm(member.user.displayName))) return;
    setBusyId(member.user.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/innovation-board/members/${member.user.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Could not remove from the innovation board");
      }
      invalidateApi("/api/me");
      load();
      onNotice?.(`${member.user.displayName} removed from the innovation board.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove from the innovation board");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="innovation-board-card">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Innovation board</h3>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
        {BOARD_CARD_SUBTITLE}
      </p>

      {full ? (
        <p className="muted" style={{ margin: "0 0 14px", fontSize: 13.5 }} data-testid="innovation-board-full">
          {BOARD_FULL_HINT}
        </p>
      ) : (
        <div className="board-add" style={{ marginBottom: 14 }}>
          <div className="board-add-field">
            <div className={`tag-field${error ? " has-error" : ""}`} onClick={() => inputRef.current?.focus()}>
              {picked.length > 0 && (
                <ul className="tag-list" aria-label="People to add">
                  {picked.map((p) => (
                    <li key={p.id} className="tag">
                      <span className="tag-label" title={p.email ? `${p.displayName} (${p.email})` : p.displayName}>
                        {p.displayName}
                      </span>
                      <button type="button" className="tag-remove" aria-label={`Remove ${p.displayName}`} disabled={adding} onClick={() => unpick(p.id)}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                id="innovation-board-add"
                ref={inputRef}
                className="tag-input"
                type="text"
                autoComplete="off"
                disabled={adding || members === null}
                value={text}
                placeholder={picked.length === 0 ? "Search people by name or e-mail…" : undefined}
                aria-label="Add people to the innovation board"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "innovation-board-error" : undefined}
                onChange={(e) => {
                  setText(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            {offered.length > 0 && (
              <FloatingResults anchorRef={inputRef} onClose={() => setResults([])}>
                {offered.map((u) => (
                  <UserResultButton key={u.id} user={u} disabled={adding} onClick={() => pick(u)} />
                ))}
              </FloatingResults>
            )}
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={adding || picked.length === 0} onClick={add}>
            Add to board
          </button>
        </div>
      )}

      {error && (
        <p id="innovation-board-error" className="muted" role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "0 0 12px" }}>
          {error}
        </p>
      )}

      {members === null && !error && <p className="muted">Loading…</p>}
      {members !== null && (
        <p className="muted board-count" style={{ margin: "0 0 8px", fontSize: 12.5 }} data-testid="innovation-board-count">
          {count} of {max}
        </p>
      )}
      {members !== null && members.length === 0 && (
        <p className="muted" style={{ margin: 0 }}>
          {BOARD_EMPTY}
        </p>
      )}
      {members !== null && members.length > 0 && (
        <div className="rows">
          {members.map((m) => (
            <div className="row board-row" key={m.user.id} data-testid="innovation-board-row">
              <AvatarBubble size="sm" userId={m.user.id} displayName={m.user.displayName} deactivated={!m.user.active} />
              <span className="board-row-who">
                <span className="board-row-name">{m.user.displayName}</span>
                {m.user.email && <span className="board-row-mail">{m.user.email}</span>}
              </span>
              {!m.user.active && <span className="pill pill-muted">Deactivated</span>}
              <span className="muted board-row-added">
                Added {fmt.date(m.addedAt)}
                {m.addedBy ? ` by ${m.addedBy.displayName}` : ""}
              </span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busyId === m.user.id} onClick={() => remove(m)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
