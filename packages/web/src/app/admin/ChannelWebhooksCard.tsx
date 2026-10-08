"use client";
// The §12.4 "Channel webhooks" Administration card body (INNOBOX_SPEC.md): every namespace
// (`global` first, archived ones labelled) with its webhooks — name, format, URL hint, the §2.2
// preference pill switch for enabled, and the latest delivery outcome — plus Send test (result
// inline), Edit (the URL field stays empty; leaving it empty keeps the stored URL) and Delete.
// Add webhook is offered up to 5 per namespace. The full URL is never shown — the server only
// ever returns its hint. The card wrapper and the platform-admin gate live in admin/page.tsx.
import { useEffect, useState, type FormEvent } from "react";
import {
  WEBHOOK_FORMATS,
  WEBHOOK_FORMAT_LABEL,
  WEBHOOK_NAME_MAX,
  WEBHOOKS_PER_NAMESPACE_MAX,
  webhookLastDeliveryLabel,
  webhookTestResultLabel,
  type WebhookFormat,
} from "@innobox/shared/webhooks";
import { deleteReq, patchJson, postJson, readJson } from "@/lib/api-client";

const URL_ = "/api/admin/webhooks";

interface WebhookRow {
  id: string;
  name: string;
  format: WebhookFormat;
  urlHint: string;
  enabled: boolean;
  lastDelivery: { outcome: "sent" | "failed"; at: string; httpStatus: number | null; reason: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

interface NamespaceRow {
  id: string;
  slug: string;
  displayName: string;
  archived: boolean;
  webhooks: WebhookRow[];
}

type TestResult = { ok: boolean; httpStatus?: number; reason?: string; durationMs: number };

/** Which form is open: adding to a namespace, or editing one webhook. */
type FormTarget = { kind: "add"; namespaceId: string } | { kind: "edit"; webhook: WebhookRow } | null;

export function ChannelWebhooksCard({ onNotify, onCount }: { onNotify: (message: string) => void; onCount?: (summary: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceRow[] | null>(null);
  const [form, setForm] = useState<FormTarget>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const [now, setNow] = useState(() => Date.now());

  const load = () =>
    fetch(URL_, { headers: { accept: "application/json" } })
      .then(async (res) => {
        const j = await readJson(res);
        if (!res.ok) throw new Error(j.error ?? "request failed");
        setConfigured(Boolean(j.configured));
        setNamespaces((j.namespaces as NamespaceRow[]) ?? []);
        setNow(Date.now());
      })
      .catch(() => onNotify("Could not load channel webhooks"));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relative "5 min ago" labels refresh on their own.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const total = namespaces?.reduce((n, ns) => n + ns.webhooks.length, 0) ?? null;
  const summary = configured === false ? "off" : total === null ? "…" : String(total);
  useEffect(() => {
    onCount?.(summary);
  }, [summary, onCount]);

  const toggle = async (w: WebhookRow) => {
    setBusyId(w.id);
    try {
      await patchJson(`${URL_}/${w.id}`, { enabled: !w.enabled });
      await load();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Could not update the webhook");
    } finally {
      setBusyId(null);
    }
  };

  const sendTest = async (w: WebhookRow) => {
    setTests((t) => ({ ...t, [w.id]: "running" }));
    try {
      const res = await fetch(`${URL_}/${w.id}/test`, { method: "POST" });
      const j = await readJson(res);
      if (!res.ok) throw new Error(j.error ?? `request failed (${res.status})`);
      setTests((t) => ({ ...t, [w.id]: j as unknown as TestResult }));
    } catch (err) {
      setTests((t) => {
        const next = { ...t };
        delete next[w.id];
        return next;
      });
      onNotify(err instanceof Error ? err.message : "Could not send the test");
    }
  };

  const remove = async (w: WebhookRow) => {
    if (!window.confirm(`Delete webhook ${w.name}? Undelivered posts are discarded.`)) return;
    setBusyId(w.id);
    try {
      await deleteReq(`${URL_}/${w.id}`);
      onNotify("Webhook deleted.");
      await load();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Could not delete the webhook");
    } finally {
      setBusyId(null);
    }
  };

  if (namespaces === null) return <p className="sub">Loading…</p>;

  return (
    <>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Post a short announcement to a team channel when a challenge opens for solutions, a solution is implemented, or a challenge is
        solved — only for items everyone can see. Microsoft Teams (Workflows) or any receiver that accepts JSON.
      </p>
      {configured === false && (
        <p className="sub" role="status" data-testid="webhooks-not-configured">
          Webhooks are not configured on this server.
        </p>
      )}

      {namespaces.map((ns) => (
        <div key={ns.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }} data-testid={`webhooks-ns-${ns.slug}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="ttl">{ns.displayName}</span>
            <span className="sub mono">{ns.slug}</span>
            {ns.archived && <span className="pill">Archived</span>}
            <span className="grow" />
            {configured && ns.webhooks.length < WEBHOOKS_PER_NAMESPACE_MAX && !(form?.kind === "add" && form.namespaceId === ns.id) && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ kind: "add", namespaceId: ns.id })}>
                Add webhook
              </button>
            )}
          </div>

          {ns.webhooks.length === 0 && !(form?.kind === "add" && form.namespaceId === ns.id) && <p className="sub" style={{ margin: 0 }}>No webhooks.</p>}

          {ns.webhooks.map((w) => {
            const test = tests[w.id];
            if (form?.kind === "edit" && form.webhook.id === w.id) {
              return (
                <WebhookForm
                  key={w.id}
                  initial={w}
                  onCancel={() => setForm(null)}
                  onSaved={async (message) => {
                    setForm(null);
                    onNotify(message);
                    await load();
                  }}
                  submit={(body) => patchJson(`${URL_}/${w.id}`, body)}
                />
              );
            }
            return (
              <div key={w.id} className="row" style={{ border: 0, padding: "8px 0", flexWrap: "wrap", gap: 10 }} data-testid="webhook-row">
                <div className="grow" style={{ minWidth: 200 }}>
                  <div className="ttl">
                    {w.name} <span className="chip">{WEBHOOK_FORMAT_LABEL[w.format]}</span>
                  </div>
                  <div className="sub mono">{w.urlHint}</div>
                  <div className="sub">{webhookLastDeliveryLabel(w.lastDelivery, now)}</div>
                  {test && (
                    <div className="sub" role="status" style={{ color: test !== "running" && !test.ok ? "var(--danger)" : undefined }}>
                      {test === "running" ? "Sending test…" : webhookTestResultLabel(test)}
                    </div>
                  )}
                </div>
                <div className="toggle-field">
                  <span className={`toggle-state${w.enabled ? " is-on" : ""}`} aria-hidden="true">
                    {w.enabled ? "On" : "Off"}
                  </span>
                  <button
                    type="button"
                    className="toggle toggle-pref"
                    role="switch"
                    aria-checked={w.enabled}
                    aria-label={`Webhook ${w.name} enabled`}
                    disabled={!configured || busyId === w.id}
                    onClick={() => toggle(w)}
                  >
                    <span className="toggle-knob" aria-hidden="true">
                      {w.enabled ? "📣" : "🔇"}
                    </span>
                  </button>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={!configured || test === "running"} onClick={() => sendTest(w)}>
                    Send test
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={!configured} onClick={() => setForm({ kind: "edit", webhook: w })}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busyId === w.id} onClick={() => remove(w)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}

          {form?.kind === "add" && form.namespaceId === ns.id && (
            <WebhookForm
              onCancel={() => setForm(null)}
              onSaved={async (message) => {
                setForm(null);
                onNotify(message);
                await load();
              }}
              submit={(body) => postJson(URL_, { ...body, namespaceId: ns.id })}
            />
          )}
        </div>
      ))}
    </>
  );
}

function WebhookForm({
  initial,
  onCancel,
  onSaved,
  submit,
}: {
  initial?: WebhookRow;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
  submit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [format, setFormat] = useState<WebhookFormat>(initial?.format ?? "teams_workflows");
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Editing with an empty URL keeps the stored one; a value replaces it.
      const body: Record<string, unknown> = { name, format, enabled };
      if (!editing || url.trim() !== "") body.url = url.trim();
      await submit(body);
      await onSaved(editing ? "Webhook saved." : "Webhook added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the webhook");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }} data-testid="webhook-form">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 180 }}
          value={name}
          maxLength={WEBHOOK_NAME_MAX}
          placeholder="Name, e.g. Innovation team channel"
          onChange={(e) => setName(e.target.value)}
          required
          aria-label="Webhook name"
        />
        <select className="field" value={format} onChange={(e) => setFormat(e.target.value as WebhookFormat)} aria-label="Format">
          {WEBHOOK_FORMATS.map((f) => (
            <option key={f} value={f}>
              {WEBHOOK_FORMAT_LABEL[f]}
            </option>
          ))}
        </select>
      </div>
      <input
        className="field"
        value={url}
        placeholder={editing ? `Leave empty to keep the current URL (${initial!.urlHint})` : "https://…"}
        onChange={(e) => setUrl(e.target.value)}
        required={!editing}
        autoComplete="off"
        spellCheck={false}
        aria-label="Webhook URL"
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label className="sub" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <span className="grow" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || name.trim() === "" || (!editing && url.trim() === "")}>
          {editing ? "Save" : "Add webhook"}
        </button>
      </div>
      {error && (
        <p className="sub" style={{ color: "var(--danger)", margin: 0 }} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
