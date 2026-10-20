"use client";
// The §22 "AI provider" card on /admin/settings (INNOBOX_SPEC.md §22.4): the status pill, the
// enable switch (§2.2 preference pill), the provider form (Provider · Base URL · write-only API
// key · Model from the provider's list), Test / Save / Remove integration, the Last test and
// 30-day usage panels, the egress notice, and the independent rows (restricted-content switch,
// per-task switches, timeouts, display name). The API key never comes back from the server —
// only its last 4 characters. Platform-admin gate lives in the page.
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteReq, patchJson, putJson, readJson } from "@/lib/api-client";
import { useDateFmt } from "@/components/DateFormat";

const URL_ = "/api/admin/ai";

type Provider = "openwebui" | "openai";
const PROVIDER_LABEL: Record<Provider, string> = { openwebui: "Open WebUI", openai: "OpenAI" };

interface Totals {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

interface AiView {
  keyPresent: boolean;
  config: {
    provider: Provider;
    providerLabel: string;
    baseUrl: string;
    model: string;
    tokenLast4: string;
    enabled: boolean;
    tokenDecrypts: boolean;
    updatedAt: string;
    updatedByName: string | null;
  } | null;
  status: { state: "not_configured" | "off" | "failing" | "operational"; reason: string | null; at: string | null };
  enableBlocker: string | null;
  lastTest: { at: string; ok: boolean; latencyMs: number | null; model: string | null; error: string | null } | null;
  usage: { days: number; total: Totals; byFeature: (Totals & { feature: string; label: string })[] };
  features: { key: string; label: string; egress: string; needsSwitch: boolean; defaultTimeoutMs: number }[];
  displayName: string;
  timeouts: { calls: Record<string, number> };
  switches: { restrictedContent: boolean; features: Record<string, boolean> };
  openaiDefaultBaseUrl: string;
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  httpStatus: number | null;
  error: string | null;
}

const KEY_HINT = "Set AI_TOKEN_ENC_KEY — a 32-byte base64 key — on web and worker.";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

const n = (v: number) => v.toLocaleString("en");

export function AiProviderCard({ onNotice }: { onNotice: (m: string) => void }) {
  const fmt = useDateFmt();
  const [view, setView] = useState<AiView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The form. The key field is write-only: empty means "keep the stored key".
  const [provider, setProvider] = useState<Provider>("openwebui");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState<null | "test" | "save" | "remove" | "toggle">(null);
  const [result, setResult] = useState<{ kind: "test" | "save"; result: TestResult } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const loadModels = useCallback(async (conn: { provider: Provider; baseUrl: string; token: string }) => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const res = await fetch(`${URL_}/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(conn) });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not load the model list");
      if (json.ok === false) throw new Error(typeof json.error === "string" ? json.error : "Could not load the model list");
      setModels(json.models as string[]);
    } catch (err) {
      // The model field falls back to free text, with the error beneath.
      setModels(null);
      setModelsError(err instanceof Error ? err.message : "Could not load the model list");
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // The list loads automatically the first time a saved configuration with a usable stored key
  // is shown; afterwards only on Load models / Refresh.
  const autoLoaded = useRef(false);

  /** Shows a fresh view. `resetForm` re-seeds the form from the saved configuration and clears the
   *  key field — only on first load, after a save and after a remove; a test, a toggle or an
   *  independent row must never wipe what the admin is typing. */
  const applyView = useCallback((v: AiView, resetForm: boolean) => {
    setView(v);
    if (!resetForm) return;
    if (v.config) {
      setProvider(v.config.provider);
      setBaseUrl(v.config.baseUrl);
      setModel(v.config.model);
    }
    setToken("");
    setReplacing(false);
  }, []);

  const refresh = useCallback(async (resetForm = false, isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch(URL_, { headers: { accept: "application/json" } });
      const json = await readJson(res);
      if (!isCurrent()) return;
      if (!res.ok) throw new Error(json.error ?? "Could not load the AI provider");
      const v = json as unknown as AiView;
      applyView(v, resetForm);
      setLoadError(null);
      if (!autoLoaded.current && v.keyPresent && v.config?.tokenDecrypts) {
        autoLoaded.current = true;
        void loadModels({ provider: v.config.provider, baseUrl: v.config.baseUrl, token: "" });
      }
    } catch (err) {
      if (isCurrent()) setLoadError(err instanceof Error ? err.message : "Could not load the AI provider");
    }
  }, [applyView, loadModels]);

  useEffect(() => {
    // A torn-down mount's load is dropped: dev StrictMode mounts twice, and the first load's
    // late form reset would otherwise wipe a key the admin has already typed.
    let current = true;
    void refresh(true, () => current);
    return () => {
      current = false;
    };
  }, [refresh]);

  const config = view?.config ?? null;
  // The stored key is used only against the stored provider and base URL (the server enforces it;
  // this decides only whether the field shows "Set · ends …").
  const storedKeyApplies = !!config && config.tokenDecrypts && provider === config.provider && baseUrl.trim() === config.baseUrl && !replacing;
  const formDisabled = !view?.keyPresent || busy !== null;

  if (loadError) return <div className="card card-pad reveal" style={{ marginBottom: 18 }}><p className="muted" style={{ margin: 0 }}>{loadError}</p></div>;
  if (!view) return <p className="muted">Loading AI provider…</p>;

  const formBody = () => ({ provider, baseUrl, token: storedKeyApplies ? "" : token, model });
  const loadFormModels = () => loadModels({ provider, baseUrl, token: storedKeyApplies ? "" : token });

  const changeProvider = (next: Provider) => {
    setProvider(next);
    // Changing the provider clears the key and makes it required.
    setToken("");
    setReplacing(true);
    setModels(null);
    setModelsError(null);
  };

  const runTest = async () => {
    setBusy("test");
    setFormError(null);
    try {
      const res = await fetch(`${URL_}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(formBody()) });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "The test could not run");
      setResult({ kind: "test", result: json as unknown as TestResult });
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "The test could not run");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setFormError(null);
    try {
      const res = await fetch(URL_, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(formBody()) });
      const json = await readJson(res);
      if (res.status === 422 && json.code === "ai_test_failed") {
        setResult({ kind: "save", result: json.result as TestResult });
        return;
      }
      if (!res.ok) throw new Error(json.error ?? "Could not save the AI provider");
      setResult(null);
      applyView(json.ai as AiView, true);
      onNotice(json.saved ? "AI provider saved." : "Nothing changed.");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save the AI provider");
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async () => {
    if (!config) return;
    setBusy("toggle");
    try {
      const json = await patchJson(URL_, { enabled: !config.enabled });
      applyView(json.ai as AiView, false);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not switch AI");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove the AI integration? The provider, base URL, model and API key are deleted. Usage history is kept.")) return;
    setBusy("remove");
    try {
      await deleteReq(URL_);
      setResult(null);
      setModels(null);
      setProvider("openwebui");
      setBaseUrl("");
      setModel("");
      autoLoaded.current = false;
      await refresh(true);
      onNotice("AI integration removed.");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not remove the AI integration");
    } finally {
      setBusy(null);
    }
  };

  const { status } = view;
  const pill =
    status.state === "operational"
      ? { cls: "pill pill-ok", label: "Operational" }
      : status.state === "failing"
        ? { cls: "pill pill-danger", label: "Failing" }
        : status.state === "off"
          ? { cls: "pill pill-muted", label: "Off" }
          : { cls: "pill pill-muted", label: "Not configured" };
  const enabled = !!config?.enabled;
  // Disabling is always allowed; enabling needs a saved, tested configuration whose key decrypts.
  const switchBlocked = !view.keyPresent || (!enabled && view.enableBlocker !== null);

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="ai-provider-card">
      <div className="settings-head">
        <h3>AI provider</h3>
        <div className="settings-head-meta">
          <span className={pill.cls} data-testid="ai-status-pill">
            {pill.label}
          </span>
          <div className="toggle-field" title={switchBlocked ? (view.keyPresent ? (view.enableBlocker ?? undefined) : KEY_HINT) : undefined}>
            <span className={`toggle-state${enabled ? " is-on" : ""}`} aria-hidden="true">
              {enabled ? "On" : "Off"}
            </span>
            <button
              type="button"
              className="toggle toggle-pref"
              role="switch"
              aria-checked={enabled}
              aria-label="AI enabled"
              disabled={switchBlocked || busy !== null}
              onClick={toggleEnabled}
            >
              <span className="toggle-knob" aria-hidden="true">
                {enabled ? "✨" : "·"}
              </span>
            </button>
          </div>
        </div>
      </div>
      {status.state === "failing" && (
        <p className="muted" style={{ color: "var(--danger)", fontSize: 13, margin: "0 0 10px" }} data-testid="ai-status-reason">
          {status.reason}
          {status.at ? ` — ${fmt.dateTime(status.at)}` : ""}
        </p>
      )}
      <p className="muted" style={{ fontSize: 13, margin: "0 0 14px" }}>
        One external language-model provider that InnoBox features can call. Nothing is sent until AI is switched on, and no feature ever sends who wrote anything.
      </p>

      {!view.keyPresent && (
        <p className="muted" style={{ fontSize: 13, color: "var(--warn)" }} data-testid="ai-key-missing">
          {KEY_HINT}
        </p>
      )}

      <div className="settings-grid">
        <label>
          Provider
          <select className="field" value={provider} disabled={formDisabled} onChange={(e) => changeProvider(e.target.value as Provider)} aria-label="Provider">
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Base URL
          <input
            className="field"
            aria-label="Base URL"
            value={baseUrl}
            disabled={formDisabled}
            placeholder={provider === "openai" ? view.openaiDefaultBaseUrl : "https://openwebui.example.com"}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setModels(null);
            }}
            required={provider === "openwebui"}
          />
        </label>
        <label>
          API key
          {storedKeyApplies && config ? (
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
              <span className="sub mono" data-testid="ai-key-set">
                Set · ends …{config.tokenLast4}
              </span>
              <button type="button" className="btn btn-sm btn-ghost" disabled={formDisabled} onClick={() => setReplacing(true)}>
                Replace
              </button>
            </span>
          ) : (
            <input className="field" type="password" autoComplete="off" aria-label="API key" value={token} disabled={formDisabled} onChange={(e) => setToken(e.target.value)} />
          )}
        </label>
        <label>
          Model
          <span className="field-with-btn">
            {models && models.length > 0 ? (
              <select className="field" value={models.includes(model) ? model : ""} disabled={formDisabled} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                <option value="">Choose a model…</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input className="field" value={model} disabled={formDisabled} onChange={(e) => setModel(e.target.value)} aria-label="Model" />
            )}
            <button type="button" className="btn btn-sm" disabled={formDisabled || loadingModels} onClick={loadFormModels}>
              {models ? "Refresh" : "Load models"}
            </button>
          </span>
        </label>
      </div>
      {modelsError && (
        <p className="muted" style={{ fontSize: 12.5, color: "var(--danger)", margin: "6px 0 0" }} data-testid="ai-models-error">
          {modelsError}
        </p>
      )}
      {provider === "openwebui" && (
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Pick a plain model: Open WebUI custom models can add hidden system prompts, knowledge or tools on the provider side.
        </p>
      )}

      <div className="settings-actions" style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-sm" disabled={formDisabled || !model.trim()} onClick={runTest}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={formDisabled || !model.trim()} onClick={save} data-testid="ai-save">
          {busy === "save" ? "Testing and saving…" : "Save"}
        </button>
        {config && (
          <button type="button" className="btn btn-sm btn-danger" disabled={formDisabled} onClick={remove}>
            Remove integration
          </button>
        )}
      </div>
      {formError && (
        <p className="muted" style={{ fontSize: 13, color: "var(--danger)", margin: "8px 0 0" }} role="alert">
          {formError}
        </p>
      )}
      {result && (
        <p className="muted" role="status" data-testid="ai-test-result" style={{ fontSize: 13, margin: "8px 0 0", color: result.result.ok ? "var(--ok)" : "var(--danger)" }}>
          {result.result.ok
            ? `Test passed in ${n(result.result.latencyMs)} ms${result.result.model ? ` — ${result.result.model} answered` : ""}.`
            : `${result.kind === "save" ? "Not saved — the test failed" : "Test failed"}: ${result.result.error ?? (result.result.httpStatus ? `HTTP ${result.result.httpStatus}` : "no details")}`}
        </p>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", marginTop: 18 }}>
        <section>
          <h4 style={{ fontSize: 13.5, margin: "0 0 6px" }}>Last test</h4>
          {view.lastTest ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }} data-testid="ai-last-test">
              {view.lastTest.ok ? "Passed" : "Failed"} · {fmt.dateTime(view.lastTest.at)}
              {view.lastTest.latencyMs !== null ? ` · ${n(view.lastTest.latencyMs)} ms` : ""}
              {view.lastTest.model ? ` · ${view.lastTest.model}` : ""}
              {view.lastTest.error ? <><br />{view.lastTest.error}</> : null}
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              The saved configuration has not been tested.
            </p>
          )}
        </section>
        <section>
          <h4 style={{ fontSize: 13.5, margin: "0 0 6px" }}>Usage — last {view.usage.days} days</h4>
          {view.usage.total.calls === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              No calls yet.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ fontSize: 12.5, width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr className="muted" style={{ textAlign: "left" }}>
                    <th style={{ fontWeight: 500 }}>Feature</th>
                    <th style={{ fontWeight: 500, textAlign: "right" }}>Calls</th>
                    <th style={{ fontWeight: 500, textAlign: "right" }}>Failures</th>
                    <th style={{ fontWeight: 500, textAlign: "right" }}>Tokens in / out</th>
                  </tr>
                </thead>
                <tbody>
                  {view.usage.byFeature.map((f) => (
                    <tr key={f.feature}>
                      <td>{f.label}</td>
                      <td style={{ textAlign: "right" }}>{n(f.calls)}</td>
                      <td style={{ textAlign: "right" }}>{n(f.failures)}</td>
                      <td style={{ textAlign: "right" }} className="mono">
                        {n(f.inputTokens)} / {n(f.outputTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section style={{ marginTop: 16 }} data-testid="ai-egress">
        <h4 style={{ fontSize: 13.5, margin: "0 0 6px" }}>What leaves InnoBox</h4>
        {config ? (
          <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
            When enabled, the features below send data to {config.providerLabel} at {hostOf(config.baseUrl)}.
          </p>
        ) : null}
        {view.features.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            No features use AI yet. The provider can be configured and tested now.
          </p>
        ) : (
          <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
            {view.features.map((f) => (
              <li key={f.key}>
                <strong>{f.label}</strong> — {f.egress}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AiIndependentRows key={`${view.displayName}|${JSON.stringify(view.timeouts)}`} view={view} onSaved={() => refresh()} onNotice={onNotice} />
    </div>
  );
}

/** Rows with their own save, no test and no key — usable without a configuration or the
 *  encryption key, and kept on Remove. */
function AiIndependentRows({ view, onSaved, onNotice }: { view: AiView; onSaved: () => Promise<void>; onNotice: (m: string) => void }) {
  // Seeded from the view; the parent remounts this (by key) when the saved values change.
  const [displayName, setDisplayName] = useState(view.displayName);
  const [seconds, setSeconds] = useState<Record<string, string>>(() =>
    Object.fromEntries(view.features.map((f) => [f.key, String((view.timeouts.calls[f.key] ?? f.defaultTimeoutMs) / 1000)])),
  );
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try {
      await fn();
      await onSaved();
      onNotice(done);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(null);
    }
  };

  const setSwitch = (body: Record<string, unknown>) => run("switch", () => putJson(`${URL_}/switches`, body), "Saved.");

  const saveTimeouts = () => {
    const calls: Record<string, number | null> = {};
    for (const f of view.features) {
      const ms = Math.round(Number(seconds[f.key]) * 1000);
      calls[f.key] = ms === f.defaultTimeoutMs ? null : ms;
    }
    return run("timeouts", () => putJson(`${URL_}/timeouts`, { calls }), "Timeouts saved.");
  };

  return (
    <section style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div className="row" style={{ padding: "8px 0", border: 0 }}>
        <div className="grow">
          <div className="ttl">Allow namespace-restricted content to be sent to the AI provider</div>
          <div className="sub">Off by default. While off, features skip or refuse restricted challenges and their solutions.</div>
        </div>
        <div className="toggle-field">
          <span className={`toggle-state${view.switches.restrictedContent ? " is-on" : ""}`} aria-hidden="true">
            {view.switches.restrictedContent ? "On" : "Off"}
          </span>
          <button
            type="button"
            className="toggle toggle-pref"
            role="switch"
            aria-checked={view.switches.restrictedContent}
            aria-label="Allow namespace-restricted content"
            disabled={busy !== null}
            onClick={() => setSwitch({ restrictedContent: !view.switches.restrictedContent })}
          >
            <span className="toggle-knob" aria-hidden="true">
              {view.switches.restrictedContent ? "🔓" : "🔒"}
            </span>
          </button>
        </div>
      </div>

      {view.features
        .filter((f) => f.needsSwitch)
        .map((f) => {
          const on = !!view.switches.features[f.key];
          return (
            <div className="row" key={f.key} style={{ padding: "8px 0", border: 0 }}>
              <div className="grow">
                <div className="ttl">{f.label}</div>
                <div className="sub">Off by default — it sends other people&apos;s text.</div>
              </div>
              <div className="toggle-field">
                <span className={`toggle-state${on ? " is-on" : ""}`} aria-hidden="true">
                  {on ? "On" : "Off"}
                </span>
                <button
                  type="button"
                  className="toggle toggle-pref"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${f.label} enabled`}
                  disabled={busy !== null}
                  onClick={() => setSwitch({ features: { [f.key]: !on } })}
                >
                  <span className="toggle-knob" aria-hidden="true">
                    {on ? "✨" : "·"}
                  </span>
                </button>
              </div>
            </div>
          );
        })}

      <div style={{ padding: "8px 0" }}>
        <div className="ttl">Timeouts</div>
        {view.features.length === 0 ? (
          <div className="sub">No features use AI yet, so there is nothing to tune.</div>
        ) : (
          <div className="settings-grid" style={{ marginTop: 6 }}>
            {view.features.map((f) => (
              <label key={f.key}>
                {f.label} (seconds)
                <input
                  className="field"
                  type="number"
                  min={10}
                  max={900}
                  step={1}
                  value={seconds[f.key] ?? ""}
                  onChange={(e) => setSeconds((cur) => ({ ...cur, [f.key]: e.target.value }))}
                />
              </label>
            ))}
            <button type="button" className="btn btn-sm btn-primary" style={{ justifySelf: "start" }} disabled={busy !== null} onClick={saveTimeouts}>
              Save
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: "8px 0" }}>
        <label className="settings-field" style={{ maxWidth: 360 }}>
          <span className="ttl">Display name</span>
          <span className="sub">What people see on AI features — for example “Improve with …”. Up to 24 characters; empty means “AI”.</span>
          <span className="field-with-btn">
            <input className="field" value={displayName} placeholder="AI" maxLength={24} onChange={(e) => setDisplayName(e.target.value)} aria-label="AI display name" />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy !== null || displayName.trim() === view.displayName}
              onClick={() => run("name", () => putJson(`${URL_}/display-name`, { displayName }), "Display name saved.")}
            >
              Save
            </button>
          </span>
        </label>
      </div>
    </section>
  );
}
