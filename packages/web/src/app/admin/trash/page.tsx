"use client";
// The platform-admin trash (INNOBOX_SPEC.md §10.4): every trashed challenge and solution, newest
// first — number, type, title, namespace, author (masked: the trash is not a reveal path), who
// trashed it and when, the reason, and the day it is purged — with a filter on number and title.
// Each row offers Restore (one confirm) and Delete permanently (the §10.3 dialog). Gated in-page
// against /api/me; the API is the real gate (404 to anyone who is not a platform admin).
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { readJson } from "@/lib/api-client";
import { RESTORE_CHALLENGE_FIRST } from "@/lib/challenge-detail";
import { TeamByline, teamOf, type TeamPerson } from "@/components/TeamByline";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";
import { useDateFmt } from "@/components/DateFormat";
import { DeletePermanentlyConfirm } from "@/components/TrashControls";

interface MeResponse {
  roles: { platformAdmin: boolean };
}

interface TrashRow {
  type: "challenge" | "solution";
  number: string;
  challengeNumber: string;
  title: string;
  namespaceSlug: string;
  author: { userId: string | null; displayName: string; anonymous: boolean; external?: boolean; active?: boolean; scrubbed?: boolean };
  /** §39.7: every member in order, masked. */
  authors?: TeamPerson[];
  trashedBy: string;
  trashedAt: string;
  reason: string;
  purgesOn: string;
  restoreBlocked: boolean;
}

export default function AdminTrashPage() {
  const [gate, setGate] = useState<"loading" | "forbidden" | "ok">("loading");

  useEffect(() => {
    let live = true;
    cachedGet<MeResponse>("/api/me")
      .then((me) => {
        if (live) setGate(me.roles.platformAdmin ? "ok" : "forbidden");
      })
      .catch(() => {
        if (live) setGate("forbidden");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="page-head reveal">
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Trash")} />}
        <h1 className="page-title">Trash</h1>
        <p className="page-sub">
          Challenges and solutions moved to the trash. Nobody else can see them. Each is deleted permanently 30 days after it was
          trashed, unless you restore it first.
        </p>
      </div>
      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <p className="muted" style={{ margin: 0 }}>
            The trash is restricted to platform admins.
          </p>
        </div>
      )}
      {gate === "ok" && <TrashBrowser />}
    </>
  );
}

/** The item's page: a solution lives on its challenge's, anchored at its number. */
function itemHref(row: TrashRow): string {
  const ch = row.challengeNumber.replace("CH-", "");
  return row.type === "challenge" ? `/challenges/${ch}` : `/challenges/${ch}#${row.number}`;
}

function itemApiPath(row: TrashRow): string {
  return row.type === "challenge" ? `/api/challenges/${row.number.replace("CH-", "")}` : `/api/solutions/${row.number.replace("SOL-", "")}`;
}

function TrashBrowser() {
  const fmt = useDateFmt();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TrashRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3200);
  };

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    const q = query.trim();
    fetch(`/api/admin/trash${q ? `?q=${encodeURIComponent(q)}` : ""}`, { headers: { accept: "application/json" } })
      .then(readJson)
      .then((json) => {
        if (seq === requestSeq.current) setItems((json.items as TrashRow[]) ?? []);
      })
      .catch(() => {
        if (seq === requestSeq.current) setItems([]);
      });
  }, [query]);

  // A short pause after typing, so each keystroke is not its own request.
  useEffect(() => {
    const t = window.setTimeout(load, 250);
    return () => window.clearTimeout(t);
  }, [load]);

  const restore = async (row: TrashRow) => {
    if (!window.confirm(`Restore ${row.number}? It comes back exactly as it was, and nobody is notified.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${itemApiPath(row)}/restore`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not restore");
      notify(`${row.number} restored.`);
      load();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not restore");
    } finally {
      setBusy(false);
    }
  };

  const deletePermanently = async (row: TrashRow, reason: string) => {
    setBusy(true);
    try {
      const res = await fetch(itemApiPath(row), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not delete");
      setDeleting(null);
      notify(`${row.number} deleted permanently.`);
      load();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <input
          className="field"
          style={{ width: "100%", maxWidth: 420 }}
          placeholder="Filter by number or title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter by number or title"
          maxLength={200}
        />
      </div>

      {!items && <p className="muted">Loading…</p>}
      {items && items.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">🗑️</div>
          <p className="muted" style={{ margin: 0 }}>
            {query.trim() ? "Nothing in the trash matches this filter." : "The trash is empty."}
          </p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="rows" data-testid="trash-list">
          {items.map((row) => (
            <div className="row" key={row.number} data-testid={`trash-row-${row.number}`} style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="chip mono">{row.number}</span>
                <span className="chip">{row.type === "challenge" ? "Challenge" : "Solution"}</span>
                <span className="chip">/{row.namespaceSlug}</span>
              </div>
              <Link href={itemHref(row)} className="ttl" style={{ overflowWrap: "anywhere" }}>
                {row.type === "solution" ? `A solution to: ${row.title}` : row.title}
              </Link>
              <div className="sub" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <TeamByline authors={teamOf(row)} />
                <span>·</span>
                <span>
                  trashed by {row.trashedBy || "a platform admin"} on {fmt.dateTime(row.trashedAt)}
                </span>
                <span>·</span>
                <span>
                  purges on <strong>{fmt.date(row.purgesOn)}</strong>
                </span>
              </div>
              <p className="sub" style={{ margin: 0, overflowWrap: "anywhere" }}>
                Reason: “{row.reason}”
              </p>
              {deleting === row.number ? (
                <DeletePermanentlyConfirm
                  label={row.number}
                  what={
                    row.type === "challenge"
                      ? `${row.number}, every solution on it, and all comments, likes, follows, and files attached to any of them`
                      : `${row.number} and all comments, likes, follows, and files attached to it`
                  }
                  busy={busy}
                  onCancel={() => setDeleting(null)}
                  onDelete={(reason) => deletePermanently(row, reason)}
                />
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {/* A disabled button fires no hover events in every browser, so the tooltip sits on a wrapper. */}
                  <span title={row.restoreBlocked ? RESTORE_CHALLENGE_FIRST : undefined}>
                    <button type="button" className="btn btn-sm btn-primary trash-restore" disabled={busy || row.restoreBlocked} onClick={() => restore(row)}>
                      Restore
                    </button>
                  </span>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setDeleting(row.number)}>
                    Delete permanently
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
