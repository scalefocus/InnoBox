// The §25.3 consent page and the non-redirecting OAuth error page (INNOBOX_SPEC.md): standalone HTML
// served by GET /oauth/authorize, outside AppShell, on the §2.2 tokens (light and dark follow the
// OS). No script at all — the only interactive part is one form POST to /oauth/consent that
// carries the pending-authorization handle and the choice, nothing else. Every interpolated value
// is HTML-escaped. Pure, so the unit tests render it directly.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `
:root{--paper:#f1f2f2;--surface:#fff;--ink:#1a1a1a;--muted:#58595b;--line:#e2e3e4;--anchor:#082773;--accent:#14abe3;--accent-ink:#fff;--danger:#e5343d;--radius:14px;--radius-sm:9px;
--font-display:"Montserrat Variable","Montserrat",Arial,sans-serif;--font-body:"Open Sans Variable","Open Sans",Arial,sans-serif;--shadow:0 1px 2px rgba(8,39,115,.05),0 14px 34px -18px rgba(8,39,115,.25)}
@media (prefers-color-scheme:dark){:root{--paper:#1a1a1a;--surface:#232529;--ink:#f1f2f2;--muted:#a7a9ac;--line:#303236;--anchor:#9db4e8;--accent:#2fbcf0;--accent-ink:#06202c;--danger:#ff5860}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--paper);color:var(--ink);font:15px/1.55 var(--font-body)}
main{width:100%;max-width:520px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:28px}
.brand{font:700 13px var(--font-display);letter-spacing:.08em;text-transform:uppercase;color:var(--anchor);margin:0 0 14px}
h1{font:700 21px/1.3 var(--font-display);margin:0 0 6px}
.muted{color:var(--muted);margin:0 0 18px;font-size:14px}
ul{margin:0 0 18px;padding-left:20px}li{margin:6px 0}
.note{border-left:3px solid var(--accent);padding:8px 12px;margin:0 0 18px;font-size:14px}
.actions{display:flex;gap:10px;flex-wrap:wrap}
button{font:600 15px var(--font-display);border-radius:var(--radius-sm);padding:10px 18px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
a{color:var(--anchor)}
.error{color:var(--danger);font-weight:600}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><p class="brand">InnoBox</p>${body}</main></body></html>`;
}

export interface ConsentPageInput {
  clientName: string;
  /** The host (or custom scheme) the approval returns to. */
  redirectTarget: string;
  personName: string;
  /** The `oauth_pending_authorizations` id — the only thing the form carries. */
  requestId: string;
  /** §25.5: whether namespace-restricted content is shared over MCP. */
  restrictedShared: boolean;
}

export function renderConsentPage(input: ConsentPageInput): string {
  const restricted = input.restrictedShared ? "" : `<p class="note">Namespace-restricted challenges are not shared with agents.</p>`;
  return page(
    `Connect ${input.clientName} to InnoBox`,
    `<h1>Connect ${escapeHtml(input.clientName)} to InnoBox?</h1>
<p class="muted">Signed in as <strong>${escapeHtml(input.personName)}</strong>. Approving returns you to <strong>${escapeHtml(input.redirectTarget)}</strong>.</p>
<p>This AI agent will be able to:</p>
<ul>
<li>Read the challenges, solutions and comments you can see.</li>
<li>Submit challenges, propose solutions, edit and resubmit your own items, comment and follow — as you, marked 'via agent'.</li>
</ul>
<p>It cannot like, change a status, assign, triage or administer.</p>
${restricted}<p class="muted">You can revoke this connection at any time on <a href="/agents">AI agents</a>.</p>
<form method="post" action="/oauth/consent" class="actions">
<input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
<button type="submit" name="decision" value="approve" class="primary">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}

/** The non-redirecting error page: shown when the request cannot be trusted to name where to go
 *  back to (a duplicated parameter, an unknown client, an unregistered redirect URI), or when a
 *  consent cannot be completed. */
export function renderErrorPage(message: string): string {
  return page(
    "InnoBox — can't connect",
    `<h1>This connection can't be completed</h1><p class="error">${escapeHtml(message)}</p><p class="muted">Start the connection again from your AI agent. Your connections are listed on <a href="/agents">AI agents</a>.</p>`,
  );
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
