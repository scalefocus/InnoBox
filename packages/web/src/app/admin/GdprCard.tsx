"use client";
// The "Delete user info (GDPR)" Administration card (INNOBOX_SPEC.md §3, platform admins).
// Search any user (incl. inactive) → "Delete info" opens an INLINE confirmation (no browser
// confirm dialog) holding the irreversibility warning and an optional "Reassign open
// assignments to" picker — the §7.3 assignee search over active users, excluding the user being
// erased, with the shared result rows. On success the toast reports the hand-over; challenges
// the successor cannot see are listed here (each a link) until dismissed, so the admin can
// reassign them by hand. The platform-admin gate lives in admin/page.tsx and the route.
import Link from "next/link";
import { useState } from "react";
import { postJson, readJson } from "@/lib/api-client";
import { AvatarBubble } from "@/components/AvatarBubble";
import { UserResultButton, type UserResult } from "@/components/UserResultButton";

interface AdminUserRow {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
  scrubbed: boolean;
}

interface ReassignedItem {
  number: string;
  title: string;
}

interface ScrubResponse {
  ok: true;
  reassignment: { successorId: string; moved: ReassignedItem[]; skipped: (ReassignedItem & { reason: string })[] } | null;
}

interface SkippedNotice {
  successorName: string;
  items: ReassignedItem[];
}

const LABEL_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 6,
  display: "block",
} as const;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function GdprCard({ onNotify }: { onNotify: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminUserRow[]>([]);
  const [pending, setPending] = useState<AdminUserRow | null>(null);
  const [successor, setSuccessor] = useState<UserResult | null>(null);
  const [successorQuery, setSuccessorQuery] = useState("");
  const [successorResults, setSuccessorResults] = useState<UserResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<SkippedNotice | null>(null);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, { headers: { accept: "application/json" } });
      const json = await res.json();
      setResults(json.users ?? []);
    } catch {
      setResults([]);
    }
  };

  const resetConfirm = () => {
    setPending(null);
    setSuccessor(null);
    setSuccessorQuery("");
    setSuccessorResults([]);
  };

  const open = (u: AdminUserRow) => {
    resetConfirm();
    setPending(u);
  };

  const searchSuccessors = async (q: string) => {
    setSuccessorQuery(q);
    if (q.trim().length < 2) {
      setSuccessorResults([]);
      return;
    }
    try {
      const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`, { headers: { accept: "application/json" } });
      const json = await readJson(res);
      const users = (json.users as UserResult[] | undefined) ?? [];
      // The user being erased can never be their own successor (the API refuses it too).
      setSuccessorResults(users.filter((u) => u.id !== pending?.id));
    } catch {
      setSuccessorResults([]);
    }
  };

  const pickSuccessor = (u: UserResult) => {
    setSuccessor(u);
    setSuccessorQuery("");
    setSuccessorResults([]);
  };

  const scrub = async () => {
    if (!pending) return;
    const target = pending;
    const chosen = successor;
    setBusy(true);
    try {
      const json = (await postJson(`/api/admin/users/${target.id}/scrub`, { reassignTo: chosen?.id ?? null })) as unknown as ScrubResponse;
      const r = json.reassignment;
      let message = `Deleted personal info for ${target.displayName}.`;
      if (r && chosen) {
        const n = r.moved.length;
        message += ` Moved ${n} open ${plural(n, "assignment", "assignments")} to ${chosen.displayName}.`;
        setSkipped(r.skipped.length > 0 ? { successorName: chosen.displayName, items: r.skipped } : null);
      } else {
        setSkipped(null);
      }
      onNotify(message);
      resetConfirm();
      setQuery("");
      setResults([]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Could not delete user info");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Delete user info (GDPR)</h3>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Irreversibly de-identifies a user: their name becomes “Deleted User” on every challenge, solution, and comment, personal
        fields are erased, and the account is deactivated. Their open assignments can be handed to a successor. The append-only
        audit log is retained.
      </p>

      {skipped && (
        <div
          role="status"
          style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--radius-sm)", padding: "10px 12px", marginBottom: 12, display: "flex", gap: 10, alignItems: "flex-start" }}
        >
          <p style={{ margin: 0, fontSize: 13.5, flex: 1, minWidth: 0 }}>
            Left with Deleted User — {skipped.successorName} can’t see these:{" "}
            {skipped.items.map((item, i) => (
              <span key={item.number}>
                {i > 0 && ", "}
                <Link href={`/challenges/${item.number.replace(/\D/g, "")}`} title={item.title}>
                  {item.number}
                </Link>
              </span>
            ))}
          </p>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSkipped(null)}>
            Dismiss
          </button>
        </div>
      )}

      <input className="field" placeholder="Search users by name or email…" value={query} onChange={(e) => search(e.target.value)} />
      {results.length > 0 && (
        <div className="rows" style={{ marginTop: 10 }}>
          {results.map((u) => (
            <div className="row" key={u.id}>
              <AvatarBubble size="sm" userId={u.scrubbed ? null : u.id} displayName={u.displayName} deactivated={!u.active} />
              <span className="grow">
                <span className="ttl">{u.displayName}</span> {u.email && <span className="muted mono">{u.email}</span>}
              </span>
              {!u.active && <span className="pill pill-muted">Inactive</span>}
              {u.scrubbed ? (
                <span className="chip">Deleted</span>
              ) : (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy || pending?.id === u.id} onClick={() => open(u)}>
                  Delete info
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The inline confirmation sits BELOW the list (not inside .rows, whose overflow:hidden
          would clip the successor popover). */}
      {pending && (
        <div
          role="dialog"
          aria-label={`Delete personal info for ${pending.displayName}`}
          style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--radius-sm)", padding: "12px 14px", marginTop: 10 }}
        >
          <p style={{ fontSize: 14, margin: "0 0 6px", fontWeight: 600 }}>Permanently delete all personal info for “{pending.displayName}”?</p>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
            Their name becomes “Deleted User” on every challenge, solution, and comment they wrote — authorship never moves. This
            cannot be undone.
          </p>

          <div style={{ position: "relative", marginBottom: 12 }}>
            <label htmlFor="gdpr-successor" style={LABEL_STYLE}>
              Reassign open assignments to (optional)
            </label>
            {successor ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <AvatarBubble size="sm" userId={successor.id} displayName={successor.displayName} noCard />
                <span
                  style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={successor.email ? `${successor.displayName} (${successor.email})` : successor.displayName}
                >
                  {successor.displayName}
                </span>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setSuccessor(null)}>
                  Clear
                </button>
              </div>
            ) : (
              <>
                <input
                  id="gdpr-successor"
                  className="field"
                  placeholder="Search active users by name or email…"
                  autoComplete="off"
                  value={successorQuery}
                  disabled={busy}
                  onChange={(e) => searchSuccessors(e.target.value)}
                />
                {successorResults.length > 0 && (
                  <div className="menu-pop user-search-pop" style={{ position: "absolute", zIndex: 10, marginTop: 4, width: "100%", maxWidth: 320 }}>
                    {successorResults.map((s) => (
                      <UserResultButton key={s.id} user={s} disabled={busy} onClick={() => pickSuccessor(s)} />
                    ))}
                  </div>
                )}
              </>
            )}
            <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
              {successor
                ? `Open challenges assigned to ${pending.displayName} that ${successor.displayName} can see move to them. Anything they can’t see stays with Deleted User and is listed afterwards.`
                : "Without a successor, open assignments stay with Deleted User."}
            </p>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={scrub}>
              {busy ? "Deleting…" : "Delete info permanently"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={resetConfirm}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
