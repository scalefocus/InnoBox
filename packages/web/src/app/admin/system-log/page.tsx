"use client";
// Platform-admin system log (INNOBOX_SPEC.md §14.7): the user-facing HTTP errors the platform
// returned, with status chips, substring search, a From/To date range, a per-user filter, infinite
// scroll in pages of 100, and a CSV export of exactly what is on screen. Gated in-page against
// /api/me; the API is the real gate (403 to anyone who is not a platform admin). Opening the page
// stamps system_log_seen_at so the console card's badge clears.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Client-safe subpath: the root barrel pulls node-only code (the e-mail engine) into the bundle.
import { SYSTEM_LOG_PAGE_SIZE, SYSTEM_LOG_STATUS_FILTERS, type SystemLogStatusFilter } from "@innobox/shared/system-log";
import { cachedGet } from "@/lib/ui";
import { readJson } from "@/lib/api-client";
import { relativeActive } from "@/lib/presence";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";
import { useDateFmt } from "@/components/DateFormat";

interface MeResponse {
  roles: { platformAdmin: boolean };
}

interface SystemEvent {
  id: string;
  createdAt: string;
  status: number;
  method: string;
  route: string;
  path: string;
  userId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  errorCode: string | null;
  message: string;
  requestId: string | null;
  durationMs: number | null;
  source: "web" | "worker";
}

interface SystemLogPage {
  events: SystemEvent[];
  total: number;
  hasMore: boolean;
}

const CHIP_LABEL: Record<SystemLogStatusFilter, string> = { all: "All", "5xx": "5xx", "403": "403", "413": "413", "422": "422", "429": "429" };

export default function AdminSystemLogPage() {
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

  // Opening the page is the "seen" action: the console card's badge clears until newer events.
  useEffect(() => {
    if (gate !== "ok") return;
    fetch("/api/admin/system-log/seen", { method: "POST" }).catch(() => {});
  }, [gate]);

  return (
    <>
      <div className="page-head reveal">
        {gate === "ok" && <Breadcrumb items={adminCrumbs("System log")} />}
        <h1 className="page-title">System log</h1>
        <p className="page-sub">
          The errors InnoBox returned to people — server failures and refused requests — and who hit them. Operational
          telemetry, kept for 90 days; not the audit log.
        </p>
      </div>
      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <p className="muted" style={{ margin: 0 }}>
            The system log is restricted to platform admins.
          </p>
        </div>
      )}
      {gate === "ok" && <SystemLogBrowser />}
    </>
  );
}

function statusTone(status: number): string {
  if (status >= 500) return "pill pill-danger";
  if (status === 429) return "pill pill-muted";
  return "pill pill-warn";
}

function SystemLogBrowser() {
  const fmt = useDateFmt();
  const [status, setStatus] = useState<SystemLogStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [user, setUser] = useState<{ id: string; label: string } | null>(null);
  const [events, setEvents] = useState<SystemEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const anyFilter = status !== "all" || search.trim() !== "" || from !== "" || to !== "" || user !== null;

  // The picked LOCAL day → UTC instants: From = start of day, To = inclusive end of day.
  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (status !== "all") q.set("status", status);
    if (search.trim()) q.set("q", search.trim());
    if (from) q.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) q.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    if (user) q.set("userId", user.id);
    return q;
  }, [status, search, from, to, user]);

  const load = useCallback(
    (offset: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      const q = new URLSearchParams(query);
      q.set("limit", String(SYSTEM_LOG_PAGE_SIZE));
      q.set("offset", String(offset));
      fetch(`/api/admin/system-log?${q.toString()}`, { headers: { accept: "application/json" } })
        .then(readJson)
        .then((j) => {
          if (seq !== requestSeq.current) return; // a newer filter change superseded this page
          const page = j as unknown as SystemLogPage;
          setEvents((cur) => (offset === 0 || !cur ? page.events : [...cur, ...page.events]));
          setTotal(page.total);
          setHasMore(page.hasMore);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setEvents((cur) => cur ?? []);
          setHasMore(false);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    },
    [query],
  );

  // Debounced reload from the top on any filter change.
  useEffect(() => {
    const id = window.setTimeout(() => load(0), 250);
    return () => window.clearTimeout(id);
  }, [load]);

  // Infinite scroll: load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && events) load(events.length);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, events, load]);

  const clearFilters = () => {
    setStatus("all");
    setSearch("");
    setFrom("");
    setTo("");
    setUser(null);
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportNotice(null);
    try {
      const res = await fetch(`/api/admin/system-log/export?${query.toString()}`);
      if (!res.ok) {
        const j = await readJson(res);
        throw new Error(j.error ?? `export failed (${res.status})`);
      }
      const blob = await res.blob();
      const matching = Number(res.headers.get("x-total-matching") ?? 0);
      const exported = Number(res.headers.get("x-exported-count") ?? 0);
      if (matching > exported) setExportNotice(`Exported ${exported.toLocaleString()} of ${matching.toLocaleString()} rows — narrow the range for the rest.`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "innobox-system-log.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      setExportNotice(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <div className="srctabs" style={{ marginBottom: 14 }} role="tablist" aria-label="Status">
          {SYSTEM_LOG_STATUS_FILTERS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} className={status === s ? "srctab active" : "srctab"} onClick={() => setStatus(s)}>
              {CHIP_LABEL[s]}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input className="field" style={{ flex: 1, minWidth: 220 }} placeholder="Search path, error, message, user…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            From
            <input type="date" className="field" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          </label>
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            To
            <input type="date" className="field" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </label>
          {user && (
            <span className="chip chip-accent">
              User: {user.label}
              <button type="button" className="btn btn-sm btn-ghost" style={{ padding: "0 4px" }} aria-label="Clear user filter" onClick={() => setUser(null)}>
                ✕
              </button>
            </span>
          )}
          {anyFilter && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
              ✕ clear filters
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={exporting || !events || events.length === 0}>
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
        {exportNotice && (
          <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
            {exportNotice}
          </p>
        )}
      </div>

      {!events && <p className="muted">Loading…</p>}
      {events && events.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">✅</div>
          <p className="muted" style={{ margin: 0 }}>
            {anyFilter ? "No events match these filters." : "No errors recorded in the last 90 days."}
          </p>
        </div>
      )}
      {events && events.length > 0 && (
        <>
          <p className="sub mono" style={{ marginBottom: 10 }}>
            {total.toLocaleString()} event{total === 1 ? "" : "s"}
          </p>
          <div className="rows">
            {events.map((e) => (
              <div className="row" key={e.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
                  aria-expanded={expanded === e.id}
                  style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", color: "inherit", font: "inherit" }}
                >
                  <span className={statusTone(e.status)}>{e.status}</span>
                  <span className="mono" style={{ fontSize: 12.5 }}>
                    {e.method} {e.path}
                  </span>
                  {e.errorCode && <span className="chip mono">{e.errorCode}</span>}
                  {e.source === "worker" && <span className="chip">worker</span>}
                  <span className="sub grow" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.message}
                  </span>
                  <span className="sub mono" title={fmt.dateTime(e.createdAt)}>
                    {relativeActive(e.createdAt, Date.now())}
                  </span>
                </button>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  {e.userId ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setUser({ id: e.userId!, label: e.actorName ?? e.actorEmail ?? "user" })}
                      title="Show only this user's events"
                    >
                      {e.actorName ?? e.actorEmail ?? "Unnamed user"}
                      {e.actorEmail && e.actorName && <span className="muted mono" style={{ marginLeft: 6 }}>{e.actorEmail}</span>}
                    </button>
                  ) : (
                    <span className="sub">{e.source === "worker" ? "Provisioning service" : "Not signed in"}</span>
                  )}
                </div>
                {expanded === e.id && (
                  <dl className="mono" style={{ fontSize: 12, margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", background: "var(--surface-2)", padding: 10, borderRadius: "var(--radius-sm)" }}>
                    <dt className="muted">when</dt>
                    <dd style={{ margin: 0 }}>{fmt.dateTime(e.createdAt)}</dd>
                    <dt className="muted">route</dt>
                    <dd style={{ margin: 0 }}>{e.route}</dd>
                    <dt className="muted">path</dt>
                    <dd style={{ margin: 0 }}>{e.path}</dd>
                    <dt className="muted">message</dt>
                    <dd style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.message || "—"}</dd>
                    <dt className="muted">error code</dt>
                    <dd style={{ margin: 0 }}>{e.errorCode ?? "—"}</dd>
                    <dt className="muted">request id</dt>
                    <dd style={{ margin: 0 }}>{e.requestId ?? "—"}</dd>
                    <dt className="muted">duration</dt>
                    <dd style={{ margin: 0 }}>{e.durationMs == null ? "—" : `${e.durationMs} ms`}</dd>
                    <dt className="muted">source</dt>
                    <dd style={{ margin: 0 }}>{e.source}</dd>
                  </dl>
                )}
              </div>
            ))}
          </div>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {hasMore && (
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button type="button" className="btn btn-sm" disabled={loading} onClick={() => load(events.length)}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
