// The §25.3 consent page and the non-redirecting OAuth error page (INNOBOX_SPEC.md): standalone HTML
// served by GET /oauth/authorize, outside AppShell, on the §2.2 tokens (light and dark follow the
// OS). No script at all — the only interactive part is one form POST to /oauth/consent that
// carries the pending-authorization handle, the choice and the "I started this connection"
// confirmation, nothing else. Every interpolated value is HTML-escaped. Pure, so the unit tests
// render it directly.
//
// Against consent phishing (§25.3): registration is open, so a look-alike client_name costs an
// attacker nothing. The page therefore makes the DESTINATION the thing the person reads — the
// heading names where the access code goes (this computer / a host / a custom scheme) with the
// host as the most prominent text; a client nobody has approved before, or registered under 24
// hours ago, carries an "Unverified application" notice; and Approve stays secondary-styled until
// the person ticks the confirmation (pure CSS — the checkbox is a sibling of the buttons).
import { classifyRedirectUri } from "./redirect-uris";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `
:root{--paper:#f1f2f2;--surface:#fff;--ink:#1a1a1a;--muted:#58595b;--line:#e2e3e4;--anchor:#082773;--accent:#14abe3;--accent-ink:#fff;--danger:#e5343d;--warn:#c97a1f;--warn-soft:#ffedd9;--radius:14px;--radius-sm:9px;
--font-display:"Montserrat Variable","Montserrat",Arial,sans-serif;--font-body:"Open Sans Variable","Open Sans",Arial,sans-serif;--shadow:0 1px 2px rgba(8,39,115,.05),0 14px 34px -18px rgba(8,39,115,.25)}
@media (prefers-color-scheme:dark){:root{--paper:#1a1a1a;--surface:#232529;--ink:#f1f2f2;--muted:#a7a9ac;--line:#303236;--anchor:#9db4e8;--accent:#2fbcf0;--accent-ink:#06202c;--danger:#ff5860;--warn:#ffa652;--warn-soft:#2e2214}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--paper);color:var(--ink);font:15px/1.55 var(--font-body)}
main{width:100%;max-width:520px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:28px}
.brand{font:700 13px var(--font-display);letter-spacing:.08em;text-transform:uppercase;color:var(--anchor);margin:0 0 14px}
h1{font:600 19px/1.4 var(--font-display);margin:0 0 6px;overflow-wrap:anywhere}
.destination{display:inline-block;font:800 30px/1.15 var(--font-display);color:var(--anchor);overflow-wrap:anywhere}
.lead{margin:0 0 14px;font-size:15px}
.muted{color:var(--muted);margin:0 0 18px;font-size:14px}
ul{margin:0 0 18px;padding-left:20px}li{margin:6px 0}
.note{border-left:3px solid var(--accent);padding:8px 12px;margin:0 0 18px;font-size:14px}
.warn{background:var(--warn-soft);border:1px solid var(--warn);border-radius:var(--radius-sm);padding:10px 12px;margin:0 0 18px;font-size:14px}
.warn strong{color:var(--warn);display:block;margin-bottom:2px}
form.consent{display:grid;grid-template-columns:auto 1fr;gap:14px 10px;align-items:start}
#confirm{margin:3px 0 0;width:18px;height:18px;accent-color:var(--accent);cursor:pointer}
.confirm{cursor:pointer;font-weight:600}
.actions{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap}
button{font:600 15px var(--font-display);border-radius:var(--radius-sm);padding:10px 18px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink)}
#confirm:checked~.actions .primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
a{color:var(--anchor)}
.error{color:var(--danger);font-weight:600}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><p class="brand">InnoBox</p>${body}</main></body></html>`;
}

export interface ConsentPageInput {
  clientName: string;
  /** The validated redirect URI the approval's 303 goes to — the page names its destination. */
  redirectUri: string;
  personName: string;
  /** The `oauth_pending_authorizations` id — the only thing the form carries besides the choice. */
  requestId: string;
  /** §25.5: whether namespace-restricted content is shared over MCP. */
  restrictedShared: boolean;
  /** Whether any person has ever approved this client (an `oauth_grants` row, revoked or not). */
  everApproved: boolean;
  /** How long ago the client registered. Under 24 hours shows the unverified notice. */
  registeredMinutesAgo: number;
}

/** The notice threshold: a client registered less than this long ago is "unverified". */
export const UNVERIFIED_CLIENT_MINUTES = 24 * 60;

/** Where the access code goes, in the words the heading and the warning sentence use. */
export function describeDestination(redirectUri: string): { kind: "loopback" | "https" | "custom"; label: string } {
  const kind = classifyRedirectUri(redirectUri);
  if (kind === "loopback") return { kind, label: "this computer" };
  const url = new URL(redirectUri);
  if (kind === "https") return { kind, label: url.host };
  return { kind: "custom", label: `${url.protocol}//` };
}

function registeredAgo(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

export function renderConsentPage(input: ConsentPageInput): string {
  const client = escapeHtml(input.clientName);
  const destination = describeDestination(input.redirectUri);
  const target = `<span class="destination">${escapeHtml(destination.label)}</span>`;
  const heading = destination.kind === "loopback" ? `Connect ${client} on ${target}?` : `Connect ${client} at ${target}?`;
  const sends =
    destination.kind === "loopback"
      ? "Approving sends an access code to an application on this computer."
      : `Approving sends an access code to ${escapeHtml(destination.label)}.`;
  const unverified: string[] = [];
  if (!input.everApproved) unverified.push("Nobody in your organization has connected this application before.");
  if (input.registeredMinutesAgo < UNVERIFIED_CLIENT_MINUTES) unverified.push(`It was registered ${registeredAgo(input.registeredMinutesAgo)}.`);
  const notice = unverified.length ? `<div class="warn" role="note"><strong>Unverified application</strong>${unverified.join(" ")}</div>` : "";
  const restricted = input.restrictedShared ? "" : `<p class="note">Namespace-restricted challenges are not shared with agents.</p>`;
  return page(
    `Connect ${input.clientName} to InnoBox`,
    `<h1>${heading}</h1>
<p class="lead">${sends} Only approve a connection you started from your own AI tool.</p>
<p class="muted">Signed in as <strong>${escapeHtml(input.personName)}</strong>.</p>
<p>This AI agent will be able to:</p>
<ul>
<li>Read the challenges, solutions and comments you can see.</li>
<li>Submit challenges, propose solutions, edit and resubmit your own items, comment and follow — as you, marked 'via agent'.</li>
</ul>
<p>It cannot like, change a status, assign, triage or administer.</p>
${restricted}<p class="muted">You can revoke this connection at any time on <a href="/agents">AI agents</a>.</p>
${notice}<form method="post" action="/oauth/consent" class="consent">
<input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
<input type="checkbox" id="confirm" name="confirm" value="1" required>
<label for="confirm" class="confirm">I started this connection from my own AI tool</label>
<div class="actions">
<button type="submit" name="decision" value="approve" class="primary">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
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
