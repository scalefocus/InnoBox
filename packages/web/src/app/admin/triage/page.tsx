"use client";
// Namespace triage queue (INNOBOX_SPEC.md §14.1): filterable list of the namespace's
// challenges, row-level assign, bulk assign/status-set, and CSV export. Namespace admins see
// their own namespace(s); platform admins see everywhere. Gated in-page against /api/me,
// same pattern as /admin's namespaces/mappings console.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cachedGet } from "@/lib/ui";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "@/app/challenges/status";
import { AvatarBubble } from "@/components/AvatarBubble";
import { UserResultButton } from "@/components/UserResultButton";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";

interface MeResponse {
  user: { id: string };
  roles: { platformAdmin: boolean; namespaceAdmin: string[] };
}

// §7.3: assignment is unavailable once a challenge is terminal (mirrors canAssignAtStatus).
const TERMINAL_STATUSES = new Set(["solved", "rejected", "withdrawn"]);

interface TriageRow {
  number: string;
  title: string;
  authorDisplayName: string;
  authorAnonymous: boolean;
  authorId: string | null;
  status: string;
  impactAreaName: string;
  namespaceSlug: string;
  assigneeDisplayName: string | null;
  assigneeId: string | null;
  createdAt: string;
}

type Tab = "challenges" | "solutions";

export default function AdminTriagePage() {
  const [gate, setGate] = useState<"loading" | "forbidden" | "ok">("loading");
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("challenges");

  useEffect(() => {
    let live = true;
    cachedGet<MeResponse>("/api/me")
      .then((me) => {
        if (!live) return;
        setMyUserId(me.user?.id ?? null);
        const ok = me.roles.platformAdmin || me.roles.namespaceAdmin.length > 0;
        setGate(ok ? "ok" : "forbidden");
        if (ok) {
          // §14.4: opening the queue marks the actionable items seen — stamp triage_seen_at,
          // then tell the app shell to refetch so the nav attention bubbles clear immediately.
          fetch("/api/admin/triage/seen", { method: "POST" })
            .then(() => window.dispatchEvent(new Event("innobox:triage-seen")))
            .catch(() => {});
        }
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
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Triage queue")} />}
        <h1 className="page-title">Triage queue</h1>
        <p className="page-sub">Work through the challenges and solutions awaiting attention in the namespaces you administer.</p>
      </div>

      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <p className="muted" style={{ margin: 0 }}>
            You need namespace admin or platform admin rights to view this page.
          </p>
        </div>
      )}
      {gate === "ok" && (
        <>
          <div className="srctabs" style={{ marginBottom: 18 }}>
            <button type="button" className={tab === "challenges" ? "srctab active" : "srctab"} onClick={() => setTab("challenges")}>
              Challenges
            </button>
            <button type="button" className={tab === "solutions" ? "srctab active" : "srctab"} onClick={() => setTab("solutions")}>
              Solutions
            </button>
          </div>
          {tab === "challenges" ? <TriageQueue myUserId={myUserId} /> : <SolutionsQueue />}
        </>
      )}
    </>
  );
}

const PAGE_SIZE = 50;

function TriageQueue({ myUserId }: { myUserId: string | null }) {
  const navigateRow = useRowNavigate();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const bulkInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<TriageRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  // The text filters debounce (300ms, same pattern as TopbarSearch) before joining `query` —
  // otherwise every keystroke re-fetches the full 4-table-joined queue.
  const [authorNameDraft, setAuthorNameDraft] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [numberDraft, setNumberDraft] = useState("");
  const [number, setNumber] = useState("");
  const [assignee, setAssignee] = useState("");
  // A picked specific person for the assignee filter (overrides the preset select above).
  const [specificAssignee, setSpecificAssignee] = useState<{ id: string; displayName: string } | null>(null);
  const [filterAssignQuery, setFilterAssignQuery] = useState("");
  const [filterAssignResults, setFilterAssignResults] = useState<{ id: string; displayName: string; email: string | null }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [assignQuery, setAssignQuery] = useState("");
  const [assignResults, setAssignResults] = useState<{ id: string; displayName: string; email: string | null }[]>([]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3200);
  };

  useEffect(() => {
    const t = window.setTimeout(() => setAuthorName(authorNameDraft), 300);
    return () => window.clearTimeout(t);
  }, [authorNameDraft]);

  useEffect(() => {
    const t = window.setTimeout(() => setNumber(numberDraft), 300);
    return () => window.clearTimeout(t);
  }, [numberDraft]);

  // Any filter change starts back at page 1 — a stale page number from a narrower filter
  // could otherwise land past the end of a broader one's result set.
  useEffect(() => {
    setPage(1);
  }, [status, authorName, number, assignee, specificAssignee]);

  // The effective assignee filter: a picked specific person wins; otherwise the preset select
  // ("unassigned", or "me" → my own id). "" means Any assignee.
  const effectiveAssigneeId = specificAssignee
    ? specificAssignee.id
    : assignee === "unassigned"
      ? "unassigned"
      : assignee === "me" && myUserId
        ? myUserId
        : "";

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (authorName.trim()) params.set("authorName", authorName.trim());
    if (number.trim()) params.set("number", number.trim());
    if (effectiveAssigneeId) params.set("assigneeId", effectiveAssigneeId);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return params.toString();
  }, [status, authorName, number, effectiveAssigneeId, page]);

  // silent refresh (used after an inline row assign) keeps the current rows visible instead of
  // flashing the whole table to "Loading…", while still re-applying the active filters.
  const refresh = (silent = false) => {
    if (!silent) setRows(null);
    fetch(`/api/admin/triage?${query}`, { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => {
        setRows(json.rows ?? []);
        setTotal(json.total ?? 0);
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
      });
  };

  useEffect(() => {
    refresh();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSelect = (number_: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(number_)) next.delete(number_);
      else next.add(number_);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!rows) return;
    setSelected((cur) => (cur.size === rows.length ? new Set() : new Set(rows.map((r) => r.number))));
  };

  const bulkSetStatus = async (newStatus: string) => {
    if (selected.size === 0 || !newStatus) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/triage/bulk-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numbers: [...selected], status: newStatus }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Bulk status update failed");
      notify(`Updated ${json.outcomes.filter((o: { status: string }) => o.status === "ok").length} of ${selected.size} item(s).`);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Bulk status update failed");
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    window.open(`/api/admin/triage/export?${query}`, "_blank");
  };

  const searchAssignees = async (q: string) => {
    setAssignQuery(q);
    if (q.trim().length < 2) {
      setAssignResults([]);
      return;
    }
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
    const json = await res.json();
    setAssignResults(json.users ?? []);
  };

  const searchFilterAssignees = async (q: string) => {
    setFilterAssignQuery(q);
    if (q.trim().length < 2) {
      setFilterAssignResults([]);
      return;
    }
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
    const json = await res.json();
    setFilterAssignResults(json.users ?? []);
  };

  const bulkAssign = async (assigneeUserId: string | null) => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/triage/bulk-assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numbers: [...selected], assigneeUserId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Bulk assign failed");
      notify(`Assigned ${json.outcomes.filter((o: { status: string }) => o.status === "ok").length} of ${selected.size} item(s).`);
      setAssignQuery("");
      setAssignResults([]);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Bulk assign failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <div className="triage-filters" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.keys(CHALLENGE_STATUS_LABEL).map((s) => (
              <option key={s} value={s}>
                {CHALLENGE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {specificAssignee ? (
            <span className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Assignee: {specificAssignee.displayName}
              <button
                type="button"
                aria-label="Clear assignee filter"
                onClick={() => {
                  setSpecificAssignee(null);
                  setFilterAssignQuery("");
                  setFilterAssignResults([]);
                }}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", fontSize: 12, lineHeight: 1 }}
              >
                ✕
              </button>
            </span>
          ) : (
            <>
              <select className="field" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Any assignee</option>
                <option value="unassigned">Unassigned</option>
                {myUserId && <option value="me">Assigned to me</option>}
              </select>
              <div>
                <input
                  ref={filterInputRef}
                  className="field"
                  placeholder="Assignee: specific person…"
                  value={filterAssignQuery}
                  onChange={(e) => searchFilterAssignees(e.target.value)}
                />
                {filterAssignResults.length > 0 && (
                  <FloatingResults anchorRef={filterInputRef} onClose={() => setFilterAssignResults([])}>
                    {filterAssignResults.map((u) => (
                      <UserResultButton
                        key={u.id}
                        user={u}
                        onClick={() => {
                          setSpecificAssignee({ id: u.id, displayName: u.displayName });
                          setFilterAssignQuery("");
                          setFilterAssignResults([]);
                        }}
                      />
                    ))}
                  </FloatingResults>
                )}
              </div>
            </>
          )}
          <input className="field" placeholder="Filter by author name" value={authorNameDraft} onChange={(e) => setAuthorNameDraft(e.target.value)} />
          <input className="field" placeholder="CH-123" value={numberDraft} onChange={(e) => setNumberDraft(e.target.value)} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={exportCsv}>
            Export CSV
          </button>
        </div>

        {selected.size > 0 && (
          <div className="admin-bulk" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip">{selected.size} selected</span>
            <select
              className="field"
              disabled={busy}
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) bulkSetStatus(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                Bulk set status…
              </option>
              {Object.keys(CHALLENGE_STATUS_LABEL).map((s) => (
                <option key={s} value={s}>
                  {CHALLENGE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => bulkAssign(null)}>
              Unassign
            </button>
            <div>
              <input
                ref={bulkInputRef}
                className="field"
                placeholder="Bulk assign to…"
                value={assignQuery}
                onChange={(e) => searchAssignees(e.target.value)}
              />
              {assignResults.length > 0 && (
                <FloatingResults anchorRef={bulkInputRef} onClose={() => setAssignResults([])}>
                  {assignResults.map((u) => (
                    <UserResultButton key={u.id} user={u} onClick={() => bulkAssign(u.id)} />
                  ))}
                </FloatingResults>
              )}
            </div>
          </div>
        )}
      </div>

      {rows === null && <p className="muted">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">🗂️</div>
          <p className="muted" style={{ margin: 0 }}>
            No challenges match this filter.
          </p>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="rows triage-rows">
          <div className="row row-head" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)" }}>
            <input type="checkbox" checked={selected.size === rows.length} onChange={toggleSelectAll} aria-label="Select all" />
            <span style={{ flex: 1 }}>Title</span>
            <span>Author</span>
            <span>Status</span>
            <span>Assignee</span>
            <span>Created</span>
          </div>
          {rows.map((r) => {
            const href = `/challenges/${r.number.replace("CH-", "")}`;
            return (
            <div className="row row-link" key={r.number} onClick={() => navigateRow(href)}>
              <input
                type="checkbox"
                checked={selected.has(r.number)}
                onChange={() => toggleSelect(r.number)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${r.number}`}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <Link href={href} className="ttl" onClick={(e) => e.stopPropagation()}>
                  {r.title}
                </Link>
                <div className="sub mono">
                  {r.number} · {r.impactAreaName} · /{r.namespaceSlug}
                </div>
              </div>
              <span className="sub" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <AvatarBubble size="sm" userId={r.authorId} displayName={r.authorDisplayName} anonymous={r.authorAnonymous} />
                {r.authorAnonymous ? "Anonymous" : r.authorDisplayName}
              </span>
              <span className={statusPillClass(r.status)}>{CHALLENGE_STATUS_LABEL[r.status] ?? r.status}</span>
              <InlineAssign
                row={r}
                onAssigned={(message) => {
                  notify(message);
                  refresh(true);
                }}
              />
              <span className="sub mono">{new Date(r.createdAt).toLocaleDateString()}</span>
            </div>
            );
          })}
        </div>
      )}

      {rows !== null && total > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14 }}>
          <span className="sub mono">
            Page {page} of {totalPages} · {total} total
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

interface TriageSolutionRow {
  number: string;
  challengeNumber: string;
  challengeTitle: string;
  authorDisplayName: string;
  authorAnonymous: boolean;
  authorId: string | null;
  impactAreaName: string;
  namespaceSlug: string;
  createdAt: string;
}

// Solutions tab (§14.1): `proposed` solutions awaiting review across the namespaces the admin
// administers. Navigational only — opening a row lands on the solution's detail page, where the
// committee/assignee status controls live (§8.2). No filters/bulk/CSV in v1.
function SolutionsQueue() {
  const navigateRow = useRowNavigate();
  const [rows, setRows] = useState<TriageSolutionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setRows(null);
    fetch(`/api/admin/triage/solutions?page=${page}&pageSize=${PAGE_SIZE}`, { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => {
        setRows(json.rows ?? []);
        setTotal(json.total ?? 0);
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
      });
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      {rows === null && <p className="muted">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">💡</div>
          <p className="muted" style={{ margin: 0 }}>
            No solutions are awaiting review.
          </p>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="rows triage-rows">
          <div className="row row-head" style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)" }}>
            <span style={{ flex: 1 }}>Solution</span>
            <span>Author</span>
            <span>Impact</span>
            <span>Proposed</span>
          </div>
          {rows.map((r) => {
            const href = `/challenges/${r.challengeNumber.replace("CH-", "")}`;
            return (
            <div className="row row-link" key={r.number} onClick={() => navigateRow(href)}>
              <div className="grow" style={{ minWidth: 0 }}>
                <Link href={href} className="ttl" onClick={(e) => e.stopPropagation()}>
                  {r.challengeTitle}
                </Link>
                <div className="sub mono">
                  {r.number} · on {r.challengeNumber} · /{r.namespaceSlug}
                </div>
              </div>
              <span className="sub" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <AvatarBubble size="sm" userId={r.authorId} displayName={r.authorDisplayName} anonymous={r.authorAnonymous} />
                {r.authorAnonymous ? "Anonymous" : r.authorDisplayName}
              </span>
              <span className="sub">{r.impactAreaName}</span>
              <span className="sub mono">{new Date(r.createdAt).toLocaleDateString()}</span>
            </div>
            );
          })}
        </div>
      )}

      {rows !== null && total > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14 }}>
          <span className="sub mono">
            Page {page} of {totalPages} · {total} total
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Whole-row navigation (§14.1): clicking anywhere on a data row opens the item, exactly as its
// title link does — but never when the click is the tail of a text selection (so admins can
// still select/copy a title). Interactive cells stopPropagation so they never reach here.
function useRowNavigate() {
  const router = useRouter();
  return (href: string) => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && sel.type === "Range" && sel.toString().trim().length > 0) return;
    router.push(href);
  };
}

// Floating user-search results (§14.1): a portaled, fixed-positioned panel anchored to its input
// so the list is never clipped by, nor pushed under the edge of, the surrounding list/card
// (`.rows`/`.card` both `overflow: hidden`). Follows the input on scroll/resize, closes on an
// outside click, and preventDefaults its own mousedown so a pick never blurs the input first.
function FloatingResults({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchorRef, onClose]);

  if (!rect) return null;
  const width = Math.min(360, Math.max(rect.width, 220));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  return createPortal(
    <div
      ref={panelRef}
      className="menu-pop user-search-pop"
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", top: rect.bottom + 4, left, width, zIndex: 1000 }}
    >
      {children}
    </div>,
    document.body,
  );
}

// Per-row inline assign (§14.1 / §7.3): the Assignee column is an inline editable text field —
// it reads as plain text (the assignee's name + avatar, or a grey "Unassigned" placeholder) and
// reveals a border on hover/focus. Focusing selects the name so typing searches for a
// replacement; a pick assigns/reassigns; the ✕ unassigns. Blur/Escape without a pick reverts
// and never unassigns implicitly. Calls the same single-assign route as the detail page, so
// RBAC, notifications, auto-follow, and audit are identical. Read-only text on terminal statuses
// (assignment is not allowed there, §7.3).
function InlineAssign({ row, onAssigned }: { row: TriageRow; onAssigned: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; displayName: string; email: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  if (TERMINAL_STATUSES.has(row.status)) {
    return (
      <span className="sub" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {row.assigneeDisplayName && <AvatarBubble size="sm" userId={row.assigneeId} displayName={row.assigneeDisplayName} noCard />}
        {row.assigneeDisplayName ?? "Unassigned"}
      </span>
    );
  }

  const search = async (value: string) => {
    setQ(value);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    const res = await fetch(`/api/users?q=${encodeURIComponent(value)}`);
    const json = await res.json();
    setResults(json.users ?? []);
  };

  // Leave edit mode: drop the search text/results so the field falls back to showing the
  // current assignee. Never changes the assignment on its own.
  const close = () => {
    setEditing(false);
    setQ("");
    setResults([]);
  };

  const assign = async (userId: string | null, label: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${row.number.replace("CH-", "")}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Assignment failed");
      close();
      inputRef.current?.blur();
      onAssigned(userId ? `Assigned ${row.number} to ${label}.` : `Unassigned ${row.number}.`);
    } catch (err) {
      onAssigned(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  };

  const assigned = Boolean(row.assigneeDisplayName);

  return (
    // stopPropagation: clicks inside the assignee cell must never bubble to the row's open-on-click.
    <span className="sub assignee-cell" onClick={(e) => e.stopPropagation()}>
      {/* noCard (§13.8): the inline editor is a popover host — a card here would nest one. */}
      {assigned && !editing && <AvatarBubble size="sm" userId={row.assigneeId} displayName={row.assigneeDisplayName!} noCard />}
      <input
        ref={inputRef}
        className="assignee-input"
        placeholder="Unassigned"
        disabled={busy}
        title="Assign, reassign, or unassign"
        value={editing ? q : (row.assigneeDisplayName ?? "")}
        onFocus={(e) => {
          setEditing(true);
          setQ(row.assigneeDisplayName ?? "");
          e.currentTarget.select();
        }}
        onChange={(e) => search(e.target.value)}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            inputRef.current?.blur();
          }
        }}
      />
      {assigned && !busy && (
        <button
          type="button"
          className="assignee-clear"
          aria-label={`Unassign ${row.number}`}
          title="Unassign"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => assign(null, "")}
        >
          ✕
        </button>
      )}
      {editing && results.length > 0 && (
        <FloatingResults anchorRef={inputRef} onClose={close}>
          {results.map((u) => (
            <UserResultButton key={u.id} user={u} disabled={busy} onClick={() => assign(u.id, u.displayName)} />
          ))}
        </FloatingResults>
      )}
    </span>
  );
}
