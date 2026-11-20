// Redirect-URI rules for the agent-access OAuth server (INNOBOX_SPEC.md §25.3): which shapes
// registration accepts and how a presented URI matches a registered one. Pure and dependency-free.

/** The loopback hosts that match on any port — 127.0.0.1 and [::1] (RFC 8252), and localhost,
 *  which MCP clients such as Claude Code register. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Schemes that can never be an app's redirect target. */
const FORBIDDEN_SCHEMES = new Set(["http", "https", "javascript", "data", "file", "vbscript", "blob", "about", "ws", "wss", "ftp", "mailto"]);

export type RedirectKind = "loopback" | "https" | "custom";

/** Classifies a redirect URI by the shapes registration accepts, or null when it is none of
 *  them: loopback `http` on 127.0.0.1 / [::1] / localhost; any `https`; or a custom app scheme.
 *  No wildcards, no fragments, no credentials. */
export function classifyRedirectUri(raw: unknown): RedirectKind | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  if (raw.includes("*") || raw.includes("#") || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http") return LOOPBACK_HOSTS.has(url.hostname) ? "loopback" : null;
  if (scheme === "https") return url.hostname ? "https" : null;
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || FORBIDDEN_SCHEMES.has(scheme)) return null;
  return "custom";
}

/** The registered URI the presented one matches, or null. Exact string match, except that a
 *  loopback URI matches on any port (same host, path and query) — desktop and CLI clients pick
 *  a free port at run time. */
export function matchRedirectUri(registered: readonly string[], presented: unknown): string | null {
  if (typeof presented !== "string" || classifyRedirectUri(presented) === null) return null;
  if (registered.includes(presented)) return presented;
  if (classifyRedirectUri(presented) !== "loopback") return null;
  const p = new URL(presented);
  for (const candidate of registered) {
    if (classifyRedirectUri(candidate) !== "loopback") continue;
    const r = new URL(candidate);
    if (r.hostname === p.hostname && r.pathname === p.pathname && r.search === p.search) return presented;
  }
  return null;
}
