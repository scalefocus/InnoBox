"use client";
// AI agents (INNOBOX_SPEC.md §25.9): the signed-in person's own page for the MCP server (§25).
// Linked from the account menu while agent access is on or while the person still holds a
// connection; reachable by any authenticated user. Three cards:
// - Connect — the server URL and ready-to-copy configuration for Claude Code, Claude Desktop and
//   VS Code. No snippet carries a credential (the client registers itself and the person approves
//   it in the browser, §25.3), and none renders before the URL has loaded.
// - Connections — one row per live grant with Revoke (immediate; audited server-side as
//   `mcp.grant_revoked`). Times go through the shared formatter.
// - What agents can do — the §25.6 summary in plain words, the §25.8 "via agent" tag, and whether
//   namespace-restricted content is shared (§25.5).
// While agent access is off (§25.10) the page says so, hides the Connect snippets, and still lists
// the connections so they can be revoked.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { deleteReq, readJson } from "@/lib/api-client";
import { invalidateApi } from "@/lib/ui";
import { copyText } from "@/lib/clipboard";
import { VIA_AGENT_TOOLTIP } from "@/components/ViaAgentTag";

const URL_ = "/api/me/agents";

interface AgentConnection {
  id: string;
  clientName: string;
  authorizedAt: string;
  lastUsedAt: string | null;
}

interface AgentsView {
  enabled: boolean;
  serverUrl: string;
  restrictedShared: boolean;
  connections: AgentConnection[];
}

async function loadAgents(): Promise<AgentsView> {
  const res = await fetch(URL_, { headers: { accept: "application/json" }, cache: "no-store" });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.error ?? "Could not load your AI agents");
  return json as unknown as AgentsView;
}

export default function AgentsPage() {
  const [view, setView] = useState<AgentsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3200);
  }, []);

  const refresh = useCallback(
    () =>
      loadAgents().then(
        (v) => {
          setView(v);
          setLoadError(null);
        },
        (err: unknown) => setLoadError(err instanceof Error ? err.message : "Could not load your AI agents"),
      ),
    [],
  );

  useEffect(() => {
    let live = true;
    loadAgents().then(
      (v) => {
        if (live) setView(v);
      },
      (err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : "Could not load your AI agents");
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Your account</div>
        <h1 className="page-title">AI agents</h1>
        <p className="page-sub">
          Connect an AI agent such as Claude Code, Claude Desktop or VS Code to InnoBox, so it can search the challenges you can see and help you
          submit, propose and comment — as you.
        </p>
      </div>

      {loadError && !view && (
        <div className="card card-pad reveal">
          <p className="muted" style={{ margin: 0 }}>
            {loadError}
          </p>
        </div>
      )}
      {!loadError && !view && <p className="muted">Loading…</p>}

      {view && (
        <>
          {view.enabled ? (
            <ConnectCard serverUrl={view.serverUrl} />
          ) : (
            <div className="card card-pad reveal agents-off" style={{ marginBottom: 18 }} role="status" data-testid="agents-off">
              <div className="ttl">An administrator has turned agent access off.</div>
              <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 0" }}>
                Your agents can&apos;t reach InnoBox right now. Their connections are paused, not removed — they work again if access is switched
                back on. You can still revoke them below.
              </p>
            </div>
          )}
          <ConnectionsCard connections={view.connections} onChanged={refresh} onNotice={notify} />
          <CapabilitiesCard restrictedShared={view.restrictedShared} />
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

// ── Connect ───────────────────────────────────────────────────────────────────────────────────

interface Snippet {
  key: string;
  label: string;
  hint: string;
  text: string;
}

/** The three client configurations (§25.9). The URL is the only variable — never a credential. */
function snippetsFor(url: string): Snippet[] {
  return [
    {
      key: "claude-code",
      label: "Claude Code",
      hint: "Run this in a terminal.",
      text: `claude mcp add --transport http innobox ${url}`,
    },
    {
      key: "claude-desktop",
      label: "Claude Desktop",
      hint: "Add this to claude_desktop_config.json, then restart Claude Desktop.",
      text: JSON.stringify({ mcpServers: { innobox: { type: "http", url } } }, null, 2),
    },
    {
      key: "vscode",
      label: "VS Code",
      hint: "Add this to .vscode/mcp.json in your workspace, or to your user MCP configuration.",
      text: JSON.stringify({ servers: { innobox: { type: "http", url } } }, null, 2),
    },
  ];
}

function ConnectCard({ serverUrl }: { serverUrl: string }) {
  // No snippet before the URL is known (§25.9) — an empty URL would copy a broken command.
  const url = serverUrl.trim();
  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="agents-connect">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 8 }}>Connect an agent</h3>
      <p className="muted" style={{ fontSize: 13.5, margin: "0 0 14px" }}>
        Add InnoBox to your agent with one of the configurations below. None of them contains a password or a key: the agent registers itself,
        then opens your browser so you can sign in and approve it.
      </p>
      {url ? (
        <>
          <div className="agent-url">
            <span className="agent-url-label">Server URL</span>
            <code className="mono agent-url-value" data-testid="agents-server-url">
              {url}
            </code>
            <CopyButton text={url} label="server URL" />
          </div>
          <div className="agent-snippets">
            {snippetsFor(url).map((s) => (
              <section key={s.key} className="agent-snippet" data-testid={`agents-snippet-${s.key}`}>
                <div className="agent-snippet-head">
                  <div className="grow">
                    <div className="ttl">{s.label}</div>
                    <div className="sub">{s.hint}</div>
                  </div>
                  <CopyButton text={s.text} label={`${s.label} configuration`} />
                </div>
                <pre className="mono agent-snippet-code">{s.text}</pre>
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          The server address isn&apos;t available yet. Try again in a moment.
        </p>
      )}
    </div>
  );
}

/** One copy target with a transient "Copied" confirmation. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  };

  return (
    <button type="button" className="btn btn-sm agent-copy" aria-label={`Copy the ${label}`} onClick={copy}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

// ── Connections ───────────────────────────────────────────────────────────────────────────────

function ConnectionsCard({
  connections,
  onChanged,
  onNotice,
}: {
  connections: AgentConnection[];
  onChanged: () => Promise<void>;
  onNotice: (m: string) => void;
}) {
  const fmt = useDateFmt();
  const [busyId, setBusyId] = useState<string | null>(null);

  const revoke = async (c: AgentConnection) => {
    setBusyId(c.id);
    try {
      await deleteReq(`${URL_}/${encodeURIComponent(c.id)}`);
      // The account menu's AI agents item can depend on holding a connection.
      invalidateApi("/api/me");
      onNotice(`${c.clientName} disconnected.`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not revoke the connection");
    } finally {
      // Refresh either way: a 404 means the connection is already gone.
      await onChanged();
      setBusyId(null);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="agents-connections">
      <div className="settings-head" style={{ marginBottom: 12 }}>
        <h3>Connections</h3>
        {connections.length > 0 && <span className="pill pill-muted">{connections.length}</span>}
      </div>
      {connections.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
          No agents are connected. When you approve one in the browser, it appears here.
        </p>
      ) : (
        <div className="rows">
          {connections.map((c) => (
            <div className="row agent-conn-row" key={c.id} data-testid="agents-connection">
              <div className="grow">
                <div className="ttl" style={{ overflowWrap: "anywhere" }}>
                  {c.clientName}
                </div>
                <div className="sub">
                  Authorized {fmt.dateTime(c.authorizedAt)} · {c.lastUsedAt ? `last used ${fmt.dateTime(c.lastUsedAt)}` : "not used yet"}
                </div>
              </div>
              <button type="button" className="btn btn-sm btn-danger" disabled={busyId !== null} onClick={() => revoke(c)}>
                {busyId === c.id ? "Revoking…" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Revoking takes effect at once: the agent&apos;s next request is refused, and connecting it again needs your approval.
      </p>
    </div>
  );
}

// ── What agents can do ────────────────────────────────────────────────────────────────────────

function CapabilitiesCard({ restrictedShared }: { restrictedShared: boolean }) {
  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="agents-capabilities">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 10 }}>What agents can do</h3>
      <ul className="agent-can-list">
        <li>
          <strong>Read</strong> the challenges, solutions and comments you can see — anonymous authors stay anonymous.
        </li>
        <li>
          <strong>Contribute as you:</strong> submit challenges, propose solutions, edit and resubmit your own items, comment, and follow or unfollow.
        </li>
        <li>
          Everything an agent creates shows <span className="via-agent-tag is-flush" title={VIA_AGENT_TOOLTIP}>via agent</span> beside your name. You stay
          the author, with the same name and the same choice to submit anonymously.
        </li>
        <li>
          <strong>They cannot</strong> like, change a status, assign, triage, reveal an author, delete, upload files or administer anything —
          people decide those in the browser.
        </li>
        <li data-testid="agents-restricted">
          {restrictedShared
            ? "Namespace-restricted challenges you can see are shared with agents too."
            : "Namespace-restricted challenges are not shared with agents."}
        </li>
      </ul>
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Your agent sends what it reads to the AI model you run it with — InnoBox doesn&apos;t control that model.
      </p>
    </div>
  );
}
