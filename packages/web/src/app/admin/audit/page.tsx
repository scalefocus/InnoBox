"use client";
// Platform-admin audit browser (INNOBOX_SPEC.md §15): a read-only, filterable window on the
// append-only audit_log — category chips (action prefixes), a plain search over the human-
// meaningful fields (never the JSON payload), a From/To date range, infinite scroll in pages of
// 100, and a CSV export of exactly what is on screen. Platform-admin-only, gated in-page against
// /api/me (the API route is the real gate).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABEL, AUDIT_PAGE_SIZE, type AuditCategory } from "@innobox/shared/audit-browser";
import { cachedGet } from "@/lib/ui";
import { readJson } from "@/lib/api-client";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";
import { useDateFmt } from "@/components/DateFormat";
import { VerifyIntegrity } from "./VerifyIntegrity";

interface MeResponse {
  roles: { platformAdmin: boolean };
}

interface AuditEntry {
  id: string;
  actorDisplayName: string | null;
  actorEmail: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetNumber: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface AuditPage {
  rows: AuditEntry[];
  total: number;
  hasMore: boolean;
}

export default function AdminAuditPage() {
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
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Audit log")} />}
        <h1 className="page-title">Audit log</h1>
        <p className="page-sub">A read-only, filterable view of every audited action. Append-only — entries are never edited or removed.</p>
      </div>
      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <p className="muted" style={{ margin: 0 }}>
            The audit log is restricted to platform admins.
          </p>
        </div>
      )}
      {gate === "ok" && <VerifyIntegrity />}
      {gate === "ok" && <AuditBrowser />}
    </>
  );
}

function AuditBrowser() {
  const fmt = useDateFmt();
  const [category, setCategory] = useState<AuditCategory>("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const anyFilter = category !== "all" || search.trim() !== "" || from !== "" || to !== "";

  // The picked LOCAL day → UTC instants: From = start of day, To = inclusive end of day.
  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (category !== "all") q.set("category", category);
    if (search.trim()) q.set("q", search.trim());
    if (from) q.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) q.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    return q;
  }, [category, search, from, to]);

  const load = useCallback(
    (offset: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      const q = new URLSearchParams(query);
      q.set("limit", String(AUDIT_PAGE_SIZE));
      q.set("offset", String(offset));
      fetch(`/api/admin/audit?${q.toString()}`, { headers: { accept: "application/json" } })
        .then(readJson)
        .then((j) => {
          if (seq !== requestSeq.current) return;
          const page = j as unknown as AuditPage;
          setRows((cur) => (offset === 0 || !cur ? page.rows : [...cur, ...page.rows]));
          setTotal(page.total);
          setHasMore(page.hasMore);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setRows((cur) => cur ?? []);
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

  // Infinite scroll: the sentinel below the list requests the next page.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && rows) load(rows.length);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, rows, load]);

  const clearFilters = () => {
    setCategory("all");
    setSearch("");
    setFrom("");
    setTo("");
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportNotice(null);
    try {
      const res = await fetch(`/api/admin/audit/export?${query.toString()}`);
      if (!res.ok) {
        const j = await readJson(res);
        throw new Error(j.error ?? `export failed (${res.status})`);
      }
      const blob = await res.blob();
      const matching = Number(res.headers.get("x-total-matching") ?? 0);
      const exported = Number(res.headers.get("x-exported-count") ?? 0);
      if (matching > exported) setExportNotice(`Exported ${exported.toLocaleString()} of ${matching.toLocaleString()} entries — narrow the range for the rest.`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "innobox-audit-log.csv";
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
        <div className="srctabs" style={{ marginBottom: 14 }} role="tablist" aria-label="Category">
          {AUDIT_CATEGORIES.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={category === c} className={category === c ? "srctab active" : "srctab"} onClick={() => setCategory(c)}>
              {AUDIT_CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="field"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Search action, target, number, actor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            From
            <input type="date" className="field" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          </label>
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            To
            <input type="date" className="field" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </label>
          {anyFilter && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
              ✕ clear filters
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={exporting || !rows || rows.length === 0}>
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
        {exportNotice && (
          <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
            {exportNotice}
          </p>
        )}
      </div>

      {!rows && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">📜</div>
          <p className="muted" style={{ margin: 0 }}>
            {anyFilter ? "No audit entries match these filters." : "No audit entries yet."}
          </p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <>
          <p className="sub mono" style={{ marginBottom: 10 }}>
            {total.toLocaleString()} entr{total === 1 ? "y" : "ies"}
          </p>
          <div className="rows">
            {rows.map((r) => (
              <div className="row" key={r.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="chip chip-accent mono">{r.action}</span>
                  <span className="sub grow">
                    {r.actorDisplayName ?? "—"}
                    {r.targetType && ` · ${r.targetType}`}
                    {r.targetNumber ? ` ${r.targetNumber}` : r.targetId ? ` ${r.targetId}` : ""}
                  </span>
                  <span className="sub mono">{fmt.dateTime(r.createdAt)}</span>
                  {(r.before != null || r.after != null) && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded((cur) => (cur === r.id ? null : r.id))}>
                      {expanded === r.id ? "Hide" : "Details"}
                    </button>
                  )}
                </div>
                {expanded === r.id && (
                  <pre className="mono" style={{ fontSize: 12, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--surface-2)", padding: 10, borderRadius: "var(--radius-sm)" }}>
                    {JSON.stringify({ before: r.before, after: r.after }, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
          <div ref={sentinelRef} style={{ height: 1 }} />
          {hasMore && (
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button type="button" className="btn btn-sm" disabled={loading} onClick={() => load(rows.length)}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
