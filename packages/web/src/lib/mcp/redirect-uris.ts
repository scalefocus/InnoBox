// Redirect-URI rules for the agent-access OAuth server (INNOBOX_SPEC.md §25.3): which shapes
// registration accepts, how a presented URI matches a registered one, and the consent page's
// widened CSP form-action. Pure and dependency-free — the edge middleware imports it for the CSP.

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

/**
 * §25.3: the consent page's `form-action` additions — approving is a form POST answered with a 303
 * to the client, and browsers apply form-action across that redirect. The loopback shapes on any
 * port and `https:` always; a custom scheme or the IPv6 loopback only when the request's redirect
 * uses it (a scheme source cannot be wildcarded). The CSP is a filter: the redirect target is
 * still checked against the client's registration before any redirect happens.
 */
export function consentFormActionSources(redirectUri: string | null): string[] {
  const sources = ["http://127.0.0.1:*", "http://localhost:*", "https:"];
  if (redirectUri) {
    const kind = classifyRedirectUri(redirectUri);
    if (kind === "custom") sources.push(`${new URL(redirectUri).protocol}`);
    if (kind === "loopback" && new URL(redirectUri).hostname === "[::1]") sources.push("http://[::1]:*");
  }
  return sources;
}
