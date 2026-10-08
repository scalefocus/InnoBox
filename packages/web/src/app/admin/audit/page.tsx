"use client";
// Platform-admin audit browser (INNOBOX_SPEC.md §15): a read-only, filterable window on the
// append-only audit_log. Platform-admin-only, gated in-page against /api/me (the API route is
// the real gate). Filters + pagination mirror the triage queue's pattern.
import { useEffect, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { readJson } from "@/lib/api-client";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";

interface MeResponse {
  roles: { platformAdmin: boolean };
}

interface AuditEntry {
  id: string;
  actorDisplayName: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface AuditPage {
  rows: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
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
      {gate === "ok" && <AuditBrowser />}
    </>
  );
}

function AuditBrowser() {
  const [data, setData] = useState<AuditPage | null>(null);
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams();
    if (action.trim()) q.set("action", action.trim());
    if (targetType) q.set("targetType", targetType);
    if (targetId.trim()) q.set("targetId", targetId.trim());
    q.set("page", String(page));
    const id = window.setTimeout(() => {
      fetch(`/api/admin/audit?${q.toString()}`, { headers: { accept: "application/json" } })
        .then(readJson)
        .then((j) => setData(j as unknown as AuditPage))
        .catch(() => setData({ rows: [], total: 0, page: 1, pageSize: 50 }));
    }, 250);
    return () => window.clearTimeout(id);
  }, [action, targetType, targetId, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input className="field" placeholder="Action (e.g. challenge.status_changed)" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} />
          <select className="field" value={targetType} onChange={(e) => { setPage(1); setTargetType(e.target.value); }}>
            <option value="">Any target type</option>
            {["challenge", "solution", "comment", "user", "namespace", "role_mapping", "impact_area", "setting", "email_service_account"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input className="field" placeholder="Target id" value={targetId} onChange={(e) => { setPage(1); setTargetId(e.target.value); }} />
        </div>
      </div>

      {!data && <p className="muted">Loading…</p>}
      {data && data.rows.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">📜</div>
          <p className="muted" style={{ margin: 0 }}>
            No audit entries match this filter.
          </p>
        </div>
      )}
      {data && data.rows.length > 0 && (
        <div className="rows">
          {data.rows.map((r) => (
            <div className="row" key={r.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="chip chip-accent mono">{r.action}</span>
                <span className="sub grow">
                  {r.actorDisplayName ?? "—"}
                  {r.targetType && ` · ${r.targetType}`}
                  {r.targetId && ` ${r.targetId}`}
                </span>
                <span className="sub mono">{new Date(r.createdAt).toLocaleString()}</span>
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
      )}

      {data && data.total > data.pageSize && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </button>
          <span className="sub mono">
            Page {data.page} of {totalPages} · {data.total} entries
          </span>
          <button type="button" className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}
