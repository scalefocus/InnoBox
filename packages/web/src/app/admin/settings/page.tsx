"use client";
// Platform settings (INNOBOX_SPEC.md §14.3): attachment limits, impact areas (add/rename/
// retire/delete), the date-display format, and the notification sender (Graph consent, wrapper,
// test-send). Namespace/role-mapping management stays on /admin (Phase 1). Platform-admin
// only; every change is audited server-side.
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { cachedGet, invalidateApi } from "@/lib/ui";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";

interface MeResponse {
  roles: { platformAdmin: boolean };
}

export default function AdminSettingsPage() {
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
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Platform settings")} />}
        <h1 className="page-title">Platform settings</h1>
        <p className="page-sub">Impact areas, attachment limits, date format, and the notification sender. Every change is audited.</p>
      </div>

      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <p className="muted" style={{ margin: 0 }}>
            You need the platform admin role to view this page.
          </p>
        </div>
      )}
      {gate === "ok" && (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <SettingsConsole />
        </Suspense>
      )}
    </>
  );
}

interface ImpactArea {
  id: string;
  name: string;
  active: boolean;
  challengeCount: number;
}

interface SettingsData {
  dateFormat: "eu" | "us";
  attachmentLimits: { maxPerItem: number; maxUploadSizeMb: number; chunkSizeMb: number };
  impactAreas: ImpactArea[];
}

interface EmailStatus {
  connected: boolean;
  account: { upn: string; displayName: string; connectedAt: string; connectedByName: string | null } | null;
  lastRefreshError: string | null;
  wrapperHtml: string | null;
  encKeyPresent: boolean;
  smtpConfigured: boolean;
  pill: "operational" | "smtp_fallback" | "down";
  reason: string | null;
}

function SettingsConsole() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<SettingsData | null>(null);
  const [email, setEmail] = useState<EmailStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3200);
  };

  const refresh = () => {
    fetch("/api/admin/settings", { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then(setData)
      .catch(() => notify("Could not load settings"));
  };

  const refreshEmail = () => {
    fetch("/api/admin/email", { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => setEmail(json.status))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    refreshEmail();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch, intentional
  }, []);

  useEffect(() => {
    const emailError = searchParams.get("emailError");
    const emailConnected = searchParams.get("emailConnected");
    if (emailError) notify(`Could not connect: ${emailError}`);
    if (emailConnected) {
      notify("Notification sender connected.");
      refreshEmail();
    }
  }, [searchParams]);

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <ImpactAreasCard areas={data.impactAreas} onChanged={refresh} onError={notify} />
      <AttachmentLimitsCard limits={data.attachmentLimits} onChanged={refresh} onError={notify} />
      <DateFormatCard current={data.dateFormat} onChanged={refresh} onError={notify} />
      <EmailSenderCard status={email} onChanged={refreshEmail} onError={notify} />
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function ImpactAreasCard({ areas, onChanged, onError }: { areas: ImpactArea[]; onChanged: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reassignTo, setReassignTo] = useState<Record<string, string>>({});

  const rename = async (area: ImpactArea, nextName: string) => {
    setBusyId(area.id);
    try {
      const res = await fetch(`/api/admin/settings/impact-areas/${area.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not rename impact area");
      setDrafts((cur) => {
        const next = { ...cur };
        delete next[area.id];
        return next;
      });
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not rename impact area");
    } finally {
      setBusyId(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/admin/settings/impact-areas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not create impact area");
      setName("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create impact area");
    } finally {
      setCreating(false);
    }
  };

  const setActive = async (area: ImpactArea, active: boolean) => {
    setBusyId(area.id);
    try {
      const res = await fetch(`/api/admin/settings/impact-areas/${area.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update impact area");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update impact area");
    } finally {
      setBusyId(null);
    }
  };

  // Delete a retired area (§14.3). With referencing challenges, a target must be chosen — the
  // challenges move there (client_name cleared server-side) before the row is removed.
  const remove = async (area: ImpactArea) => {
    const targetId = reassignTo[area.id] ?? "";
    const targetName = areas.find((x) => x.id === targetId)?.name;
    const n = area.challengeCount;
    const confirmMsg =
      n > 0
        ? `Move ${n} challenge${n === 1 ? "" : "s"} to “${targetName}” and permanently delete “${area.name}”? This cannot be undone.`
        : `Permanently delete “${area.name}”? This cannot be undone.`;
    if (!window.confirm(confirmMsg)) return;
    setBusyId(area.id);
    try {
      const qs = targetId ? `?reassignToId=${encodeURIComponent(targetId)}` : "";
      const res = await fetch(`/api/admin/settings/impact-areas/${area.id}${qs}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Could not delete impact area");
      }
      setReassignTo((cur) => {
        const next = { ...cur };
        delete next[area.id];
        return next;
      });
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete impact area");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Impact areas</h3>
      <form onSubmit={create} className="create-ns-form" style={{ marginBottom: 14 }}>
        <input className="field" placeholder="New impact area name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit" className="btn btn-sm btn-primary" disabled={creating}>
          Add
        </button>
      </form>
      <div className="rows">
        {areas.map((a) => {
          const draft = drafts[a.id] ?? a.name;
          const dirty = draft.trim() !== "" && draft.trim() !== a.name;
          const busy = busyId === a.id;
          // Reassignment targets: other active areas, never Client (challenges can't be bulk-moved
          // into Client — each would need a client_name a bulk move can't supply, §14.3).
          const targets = areas.filter((x) => x.active && x.name !== "Client" && x.id !== a.id);
          const chosenTarget = reassignTo[a.id] ?? "";
          const needsTarget = a.challengeCount > 0 && chosenTarget === "";
          return (
            <div className="row" key={a.id} style={{ flexWrap: "wrap" }}>
              <input
                className="field grow"
                style={{ maxWidth: 320 }}
                value={draft}
                onChange={(e) => setDrafts((cur) => ({ ...cur, [a.id]: e.target.value }))}
                aria-label={`Impact area name`}
              />
              {a.active ? <span className="pill pill-ok">Active</span> : <span className="pill pill-muted">Retired</span>}
              <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={() => rename(a, draft.trim())}>
                Save
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setActive(a, !a.active)}>
                {a.active ? "Retire" : "Reactivate"}
              </button>
              {!a.active && (
                <>
                  {a.challengeCount > 0 && (
                    <select
                      className="field"
                      style={{ maxWidth: 200 }}
                      value={chosenTarget}
                      disabled={busy}
                      aria-label={`Move challenges from ${a.name} to`}
                      onChange={(e) => setReassignTo((cur) => ({ ...cur, [a.id]: e.target.value }))}
                    >
                      <option value="">Move {a.challengeCount} challenge{a.challengeCount === 1 ? "" : "s"} to…</option>
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy || needsTarget}
                    title={
                      needsTarget
                        ? `${a.challengeCount} challenge${a.challengeCount === 1 ? "" : "s"} still use this area — choose an area to move them to`
                        : undefined
                    }
                    onClick={() => remove(a)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AttachmentLimitsCard({
  limits,
  onChanged,
  onError,
}: {
  limits: { maxPerItem: number; maxUploadSizeMb: number; chunkSizeMb: number };
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [maxPerItem, setMaxPerItem] = useState(limits.maxPerItem);
  const [maxUploadSizeMb, setMaxUploadSizeMb] = useState(limits.maxUploadSizeMb);
  const [chunkSizeMb, setChunkSizeMb] = useState(limits.chunkSizeMb);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMaxPerItem(limits.maxPerItem);
    setMaxUploadSizeMb(limits.maxUploadSizeMb);
    setChunkSizeMb(limits.chunkSizeMb);
  }, [limits.maxPerItem, limits.maxUploadSizeMb, limits.chunkSizeMb]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachmentLimits: { maxPerItem, maxUploadSizeMb, chunkSizeMb } }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save attachment limits");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save attachment limits");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Attachment limits</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          Max per item
          <input className="field" type="number" min={1} max={50} value={maxPerItem} onChange={(e) => setMaxPerItem(Number(e.target.value))} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          Max upload size (MB)
          <input className="field" type="number" min={5} max={200} value={maxUploadSizeMb} onChange={(e) => setMaxUploadSizeMb(Number(e.target.value))} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          Chunk size (MB)
          <input className="field" type="number" min={5} max={maxUploadSizeMb} value={chunkSizeMb} onChange={(e) => setChunkSizeMb(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
          Save
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Files larger than the chunk size are uploaded in chunks of this size. Minimum 5&nbsp;MB; cannot exceed the max upload size.
      </p>
    </div>
  );
}

function DateFormatCard({ current, onChanged, onError }: { current: "eu" | "us"; onChanged: () => void; onError: (m: string) => void }) {
  const [saving, setSaving] = useState(false);

  const setFormat = async (format: "eu" | "us") => {
    if (format === current) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dateFormat: format }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save date format");
      invalidateApi("/api/me");
      window.dispatchEvent(new Event("innobox:dateformat-changed"));
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save date format");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Date display format</h3>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className={current === "eu" ? "btn btn-sm btn-primary" : "btn btn-sm"} disabled={saving} onClick={() => setFormat("eu")}>
          EU — dd/mm/yyyy, 24h
        </button>
        <button type="button" className={current === "us" ? "btn btn-sm btn-primary" : "btn btn-sm"} disabled={saving} onClick={() => setFormat("us")}>
          US — mm/dd/yyyy, AM/PM
        </button>
      </div>
    </div>
  );
}

function EmailSenderCard({ status, onChanged, onError }: { status: EmailStatus | null; onChanged: () => void; onError: (m: string) => void }) {
  const [wrapperDraft, setWrapperDraft] = useState("");
  const [savingWrapper, setSavingWrapper] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status?.wrapperHtml) setWrapperDraft(status.wrapperHtml);
  }, [status?.wrapperHtml]);

  if (!status) return <p className="muted">Loading notification sender status…</p>;

  const pillClass = status.pill === "operational" ? "pill pill-ok" : status.pill === "smtp_fallback" ? "pill pill-warn" : "pill pill-danger";
  const pillLabel = status.pill === "operational" ? "Graph sending" : status.pill === "smtp_fallback" ? "SMTP fallback" : "E-mail down";

  const disconnect = async () => {
    if (!window.confirm("Disconnect the notification sender mailbox?")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/email/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Could not disconnect");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  };

  const saveWrapper = async () => {
    setSavingWrapper(true);
    try {
      const res = await fetch("/api/admin/email/wrapper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html: wrapperDraft }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save wrapper");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save wrapper");
    } finally {
      setSavingWrapper(false);
    }
  };

  const testSend = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/email/test-send", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Test send failed");
      onError(`Test e-mail sent to ${json.to}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Test send failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <div className="row" style={{ border: 0, padding: 0, marginBottom: 14 }}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, margin: 0 }} className="grow">
          Notification sender
        </h3>
        <span className={pillClass}>{pillLabel}</span>
      </div>

      {status.connected && status.account ? (
        <div style={{ marginBottom: 14 }}>
          <div className="ttl">{status.account.displayName}</div>
          <div className="sub mono">{status.account.upn}</div>
          {status.lastRefreshError && (
            <p className="muted" style={{ color: "var(--danger)", fontSize: 13 }}>
              {status.lastRefreshError}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <a href="/api/admin/email/connect" className="btn btn-sm">
              Reconnect
            </a>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
            <button type="button" className="btn btn-sm" disabled={busy || !status.wrapperHtml} onClick={testSend}>
              Send test e-mail
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <p className="muted" style={{ fontSize: 13.5 }}>
            No service mailbox connected. {!status.encKeyPresent && "Graph credentials are not configured in this environment."}
          </p>
          <a href="/api/admin/email/connect" className="btn btn-sm btn-primary">
            Connect mailbox
          </a>
        </div>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
        Message wrapper HTML (must contain exactly one <span className="mono">[SYSTEM MESSAGE]</span> placeholder)
        <textarea
          className="field"
          style={{ minHeight: 100, fontFamily: "var(--font-mono)", fontSize: 12.5 }}
          value={wrapperDraft}
          onChange={(e) => setWrapperDraft(e.target.value)}
        />
      </label>
      <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 10 }} disabled={savingWrapper} onClick={saveWrapper}>
        Save wrapper
      </button>
    </div>
  );
}
