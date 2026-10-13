"use client";
// The "AI agents (MCP)" card on /admin/settings (INNOBOX_SPEC.md §25.10, §14.3): the two switches
// (§2.2 preference pills) — "Allow AI agents to connect" (`mcp_enabled`) and "Allow
// namespace-restricted content over MCP" (`mcp_restricted_content_enabled`), both off by default —
// the access/refresh token lifetimes (validated server-side: 5–1440 minutes, 1–365 days), the
// read-only server URL, the live-connection and registered-client counts, and the registered
// clients list with Block / Unblock per client. Off is dormant, not revoked; there is deliberately
// no "revoke everything" control. Every change is audited server-side (§25.13). Platform-admin gate
// lives in the page.
import { useCallback, useEffect, useState } from "react";
import { patchJson, postJson, readJson } from "@/lib/api-client";
import { useDateFmt } from "@/components/DateFormat";

const URL_ = "/api/admin/mcp";

interface McpView {
  enabled: boolean;
  restrictedContentEnabled: boolean;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  serverUrl: string;
  liveConnections: number;
  registeredClients: number;
}

interface McpClient {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
  liveConnections: number;
  blocked: boolean;
  blockedAt: string | null;
}

/** The server-side bounds (§25.3), mirrored for the inputs' min/max and the Save guard. */
const ACCESS_MIN = 5;
const ACCESS_MAX = 1440;
const REFRESH_MIN = 1;
const REFRESH_MAX = 365;

const n = (v: number) => v.toLocaleString("en");
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

function inRange(raw: string, min: number, max: number): boolean {
  const v = Number(raw);
  return raw.trim() !== "" && Number.isInteger(v) && v >= min && v <= max;
}

async function fetchView(): Promise<McpView> {
  const res = await fetch(URL_, { headers: { accept: "application/json" }, cache: "no-store" });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.error ?? "Could not load the AI agents settings");
  return json as unknown as McpView;
}

async function fetchClients(): Promise<McpClient[]> {
  const res = await fetch(`${URL_}/clients`, { headers: { accept: "application/json" }, cache: "no-store" });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.error ?? "Could not load the registered clients");
  return (json.clients as McpClient[] | undefined) ?? [];
}

export function McpCard({ onNotice }: { onNotice: (m: string) => void }) {
  const fmt = useDateFmt();
  const [view, setView] = useState<McpView | null>(null);
  const [clients, setClients] = useState<McpClient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "enabled" | "restricted" | "ttl">(null);
  const [clientBusy, setClientBusy] = useState<string | null>(null);
  // The lifetime inputs, as typed. Re-seeded only on load and after a lifetime save, so flipping
  // a switch never wipes what the admin is typing.
  const [accessTtl, setAccessTtl] = useState("");
  const [refreshTtl, setRefreshTtl] = useState("");

  const applyView = useCallback((v: McpView, reseedTtl: boolean) => {
    setView(v);
    if (!reseedTtl) return;
    setAccessTtl(String(v.accessTokenTtlMinutes));
    setRefreshTtl(String(v.refreshTokenTtlDays));
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([fetchView(), fetchClients()]).then(
      ([v, list]) => {
        if (!live) return;
        applyView(v, true);
        setClients(list);
      },
      (err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : "Could not load the AI agents settings");
      },
    );
    return () => {
      live = false;
    };
  }, [applyView]);

  if (loadError && !view) {
    return (
      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <p className="muted" style={{ margin: 0 }}>
          {loadError}
        </p>
      </div>
    );
  }
  if (!view) return <p className="muted">Loading AI agents settings…</p>;

  const patch = async (what: "enabled" | "restricted" | "ttl", body: Partial<McpView>, done: string) => {
    setBusy(what);
    try {
      const json = await patchJson(URL_, body);
      applyView(json as unknown as McpView, what === "ttl");
      onNotice(done);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not save the AI agents settings");
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = () =>
    patch(
      "enabled",
      { enabled: !view.enabled },
      view.enabled ? "Agent access switched off. Connections are kept and resume when it is switched back on." : "Agent access switched on.",
    );

  const toggleRestricted = () =>
    patch(
      "restricted",
      { restrictedContentEnabled: !view.restrictedContentEnabled },
      view.restrictedContentEnabled ? "Namespace-restricted content is no longer shared with agents." : "Namespace-restricted content is now shared with agents.",
    );

  const ttlValid = inRange(accessTtl, ACCESS_MIN, ACCESS_MAX) && inRange(refreshTtl, REFRESH_MIN, REFRESH_MAX);
  const ttlDirty = accessTtl.trim() !== String(view.accessTokenTtlMinutes) || refreshTtl.trim() !== String(view.refreshTokenTtlDays);
  const saveTtl = () =>
    patch("ttl", { accessTokenTtlMinutes: Number(accessTtl), refreshTokenTtlDays: Number(refreshTtl) }, "Token lifetimes saved.");

  const setBlocked = async (c: McpClient, block: boolean) => {
    setClientBusy(c.id);
    try {
      const json = await postJson(`${URL_}/clients/${encodeURIComponent(c.id)}/${block ? "block" : "unblock"}`, {});
      const next = json.client as McpClient | undefined;
      if (next) setClients((cur) => (cur ?? []).map((x) => (x.id === next.id ? next : x)));
      onNotice(block ? `${c.clientName} blocked. Its connections are kept for when it is unblocked.` : `${c.clientName} unblocked.`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : `Could not ${block ? "block" : "unblock"} the client`);
      await fetchClients().then(setClients, () => {});
    } finally {
      setClientBusy(null);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="mcp-card">
      <div className="settings-head">
        <h3>AI agents (MCP)</h3>
        <div className="settings-head-meta">
          <span className={view.enabled ? "pill pill-ok" : "pill pill-muted"} data-testid="mcp-status-pill">
            {view.enabled ? "On" : "Off"}
          </span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 14px" }}>
        Lets people connect AI agents such as Claude Code, Claude Desktop or VS Code to InnoBox. An agent acts as the person who approved it: it
        can read what they can see and submit, propose and comment for them, marked &quot;via agent&quot;. It can never like, change a status,
        assign, triage or administer.
      </p>

      <div className="row" style={{ padding: "8px 0", border: 0 }}>
        <div className="grow">
          <div className="ttl">Allow AI agents to connect</div>
          <div className="sub">
            Off by default. Off means dormant, not revoked: connections are kept and resume when this is switched back on, without anyone
            approving their agent again.
          </div>
        </div>
        <div className="toggle-field">
          <span className={`toggle-state${view.enabled ? " is-on" : ""}`} aria-hidden="true">
            {view.enabled ? "On" : "Off"}
          </span>
          <button
            type="button"
            className="toggle toggle-pref"
            role="switch"
            aria-checked={view.enabled}
            aria-label="Allow AI agents to connect"
            disabled={busy !== null}
            onClick={toggleEnabled}
          >
            <span className="toggle-knob" aria-hidden="true">
              {view.enabled ? "🤖" : "·"}
            </span>
          </button>
        </div>
      </div>

      <div className="row" style={{ padding: "8px 0", border: 0 }}>
        <div className="grow">
          <div className="ttl">Allow namespace-restricted content over MCP</div>
          <div className="sub">
            Off by default. While off, agents behave as if namespace-restricted challenges, their solutions and their comments do not exist.
            Agents send what they read to the AI model their user runs. InnoBox does not control that model.
          </div>
        </div>
        <div className="toggle-field">
          <span className={`toggle-state${view.restrictedContentEnabled ? " is-on" : ""}`} aria-hidden="true">
            {view.restrictedContentEnabled ? "On" : "Off"}
          </span>
          <button
            type="button"
            className="toggle toggle-pref"
            role="switch"
            aria-checked={view.restrictedContentEnabled}
            aria-label="Allow namespace-restricted content over MCP"
            disabled={busy !== null}
            onClick={toggleRestricted}
          >
            <span className="toggle-knob" aria-hidden="true">
              {view.restrictedContentEnabled ? "🔓" : "🔒"}
            </span>
          </button>
        </div>
      </div>

      <div style={{ padding: "8px 0" }}>
        <div className="ttl">Token lifetimes</div>
        <div className="settings-grid" style={{ marginTop: 6 }}>
          <label>
            Access token lifetime (minutes, {ACCESS_MIN}–{ACCESS_MAX})
            <input
              className="field"
              type="number"
              min={ACCESS_MIN}
              max={ACCESS_MAX}
              step={1}
              value={accessTtl}
              onChange={(e) => setAccessTtl(e.target.value)}
              aria-label="Access token lifetime in minutes"
            />
          </label>
          <label>
            Refresh token lifetime (days, {REFRESH_MIN}–{REFRESH_MAX})
            <input
              className="field"
              type="number"
              min={REFRESH_MIN}
              max={REFRESH_MAX}
              step={1}
              value={refreshTtl}
              onChange={(e) => setRefreshTtl(e.target.value)}
              aria-label="Refresh token lifetime in days"
            />
          </label>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ justifySelf: "start" }}
            disabled={busy !== null || !ttlDirty || !ttlValid}
            title={ttlValid ? undefined : `Minutes must be a whole number from ${ACCESS_MIN} to ${ACCESS_MAX}; days from ${REFRESH_MIN} to ${REFRESH_MAX}.`}
            onClick={saveTtl}
          >
            {busy === "ttl" ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          An agent gets a fresh access token automatically. The refresh lifetime is how long a connection may sit unused before its person has to
          approve it again.
        </p>
      </div>

      <section style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
        <div className="settings-field" style={{ marginBottom: 10 }}>
          <span className="ttl">Server URL</span>
          <code className="mono mcp-server-url" data-testid="mcp-server-url">
            {view.serverUrl || "—"}
          </code>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }} data-testid="mcp-counts">
          {plural(view.liveConnections, "live connection", "live connections")} · {plural(view.registeredClients, "registered client", "registered clients")}
        </p>

        <h4 style={{ fontSize: 13.5, margin: "0 0 8px" }}>Registered clients</h4>
        {clients === null ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Loading…
          </p>
        ) : clients.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            No clients have registered yet.
          </p>
        ) : (
          <div className="rows">
            {clients.map((c) => (
              <div className="row mcp-client-row" key={c.id} data-testid="mcp-client">
                <div className="grow">
                  <div className="ttl" style={{ overflowWrap: "anywhere" }}>
                    {c.clientName}
                  </div>
                  <div className="sub">
                    Registered {fmt.date(c.createdAt)} · {c.lastUsedAt ? `last used ${fmt.dateTime(c.lastUsedAt)}` : "never used"} ·{" "}
                    {plural(c.liveConnections, "live connection", "live connections")}
                  </div>
                </div>
                {c.blocked && (
                  <span className="pill pill-danger" title={c.blockedAt ? `Blocked ${fmt.dateTime(c.blockedAt)}` : undefined}>
                    Blocked
                  </span>
                )}
                {c.blocked ? (
                  <button type="button" className="btn btn-sm" disabled={clientBusy !== null} onClick={() => setBlocked(c, false)}>
                    {clientBusy === c.id ? "Unblocking…" : "Unblock"}
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm btn-danger" disabled={clientBusy !== null} onClick={() => setBlocked(c, true)}>
                    {clientBusy === c.id ? "Blocking…" : "Block"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          A blocked client can&apos;t connect, refresh or make calls. Its connections are kept, so unblocking restores them.
        </p>
      </section>
    </div>
  );
}
