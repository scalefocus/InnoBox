// Pins the §25.3 consent page (INNOBOX_SPEC.md), including its anti-phishing shape: the heading
// names the DESTINATION (this computer / the https host / the custom scheme) with the host as the
// most prominent element; the "Approving sends an access code to …" sentence; the "Unverified
// application" notice for a client nobody has approved or one registered under 24 hours ago, and
// nothing extra otherwise; the required "I started this connection" checkbox that gates the
// Approve button's primary styling with pure CSS (no script on the page); and HTML escaping of
// every interpolated value. Also the non-redirecting error page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDestination, escapeHtml, renderConsentPage, renderErrorPage, UNVERIFIED_CLIENT_MINUTES, type ConsentPageInput } from "./consent-page";

const base: ConsentPageInput = {
  clientName: "Claude Code",
  redirectUri: "http://127.0.0.1:33418/callback",
  personName: "Pat Example",
  requestId: "4f1c0e4a-2b7e-4c2a-9d7e-8f1a2b3c4d5e",
  restrictedShared: true,
  everApproved: true,
  registeredMinutesAgo: UNVERIFIED_CLIENT_MINUTES + 1,
};

const render = (extra: Partial<ConsentPageInput> = {}) => renderConsentPage({ ...base, ...extra });

test("destination: loopback is this computer; https is the host; a custom scheme is scheme://", () => {
  assert.deepEqual(describeDestination("http://localhost:6274/oauth/callback"), { kind: "loopback", label: "this computer" });
  assert.deepEqual(describeDestination("http://[::1]:8080/cb"), { kind: "loopback", label: "this computer" });
  assert.deepEqual(describeDestination("https://claude.ai/api/mcp/auth_callback"), { kind: "https", label: "claude.ai" });
  assert.deepEqual(describeDestination("https://app.example.com:8443/cb"), { kind: "https", label: "app.example.com:8443" });
  assert.deepEqual(describeDestination("cursor://anysphere.cursor-retrieval/oauth/callback"), { kind: "custom", label: "cursor://" });
  assert.deepEqual(describeDestination("com.example.app:/oauth"), { kind: "custom", label: "com.example.app://" });
});

test("heading per destination kind, with the host as the prominent element and the warning sentence", () => {
  const loopback = render();
  assert.ok(loopback.includes(`<h1>Connect Claude Code on <span class="destination">this computer</span>?</h1>`));
  assert.ok(loopback.includes("Approving sends an access code to an application on this computer. Only approve a connection you started from your own AI tool."));

  const https = render({ redirectUri: "https://claude.ai/api/mcp/auth_callback" });
  assert.ok(https.includes(`<h1>Connect Claude Code at <span class="destination">claude.ai</span>?</h1>`));
  assert.ok(https.includes("Approving sends an access code to claude.ai. Only approve a connection you started from your own AI tool."));

  const custom = render({ redirectUri: "cursor://anysphere.cursor-retrieval/oauth/callback" });
  assert.ok(custom.includes(`<h1>Connect Claude Code at <span class="destination">cursor://</span>?</h1>`));
  assert.ok(custom.includes("Approving sends an access code to cursor://."));

  // The destination is styled larger than the heading that carries the client name.
  const destinationSize = Number(/\.destination\{[^}]*font:\s*800\s+(\d+)px/.exec(loopback)?.[1]);
  const headingSize = Number(/\bh1\{[^}]*font:\s*\d+\s+(\d+)px/.exec(loopback)?.[1]);
  assert.ok(destinationSize > headingSize, `${destinationSize} > ${headingSize}`);
  assert.ok(!loopback.includes("<script"), "no script at all");
});

test("unverified notice: never approved, or registered under 24 hours ago; nothing when both are fine", () => {
  const trusted = render();
  assert.ok(!trusted.includes("Unverified application"));
  assert.ok(!trusted.includes("connected this application before"));
  assert.ok(!trusted.includes("registered"));

  const neverApproved = render({ everApproved: false });
  assert.ok(neverApproved.includes("Unverified application"));
  assert.ok(neverApproved.includes("Nobody in your organization has connected this application before."));
  assert.ok(!neverApproved.includes("It was registered"));

  const fresh = render({ registeredMinutesAgo: 3.7 });
  assert.ok(fresh.includes("Unverified application"));
  assert.ok(fresh.includes("It was registered 3 minutes ago."));
  assert.ok(!fresh.includes("connected this application before"));
  assert.ok(render({ registeredMinutesAgo: 1 }).includes("It was registered 1 minute ago."));
  assert.ok(render({ registeredMinutesAgo: 60 }).includes("It was registered 1 hour ago."));
  assert.ok(render({ registeredMinutesAgo: 23 * 60 + 59 }).includes("It was registered 23 hours ago."));
  assert.ok(!render({ registeredMinutesAgo: UNVERIFIED_CLIENT_MINUTES }).includes("Unverified"), "exactly 24 hours is no longer fresh");

  const both = render({ everApproved: false, registeredMinutesAgo: 0 });
  assert.ok(both.includes("Nobody in your organization has connected this application before. It was registered 0 minutes ago."));
  // The notice sits above the form's buttons, in the warn tone.
  assert.ok(both.indexOf('class="warn"') < both.indexOf("<form"));
  assert.ok(both.includes("--warn:"));
});

test("the confirmation checkbox is in the form, required, and gates Approve's primary styling by CSS", () => {
  const html = render();
  assert.ok(html.includes(`<input type="checkbox" id="confirm" name="confirm" value="1" required>`));
  assert.ok(html.includes(`<label for="confirm" class="confirm">I started this connection from my own AI tool</label>`));
  assert.ok(html.includes(`<button type="submit" name="decision" value="approve" class="primary">Approve</button>`));
  assert.ok(html.includes(`<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>`), "Deny needs no tick");
  assert.ok(html.includes("#confirm:checked~.actions .primary{background:var(--accent)"), "primary styling only once ticked");
  assert.ok(!/\nbutton\.primary\{/.test(html), "unticked, Approve looks like the secondary button");
  // The checkbox, the label and the actions are siblings inside the form (the CSS relies on it).
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  assert.ok(form.indexOf('id="confirm"') < form.indexOf('class="actions"'));
  assert.ok(form.includes(`<input type="hidden" name="request_id" value="${base.requestId}">`));
  assert.ok(form.includes('action="/oauth/consent"') && form.includes('method="post"'));
});

test("grant wording, the restricted-content note and the revoke pointer", () => {
  const html = render({ restrictedShared: false });
  assert.ok(html.includes("Signed in as <strong>Pat Example</strong>."));
  assert.ok(html.includes("Read the challenges, solutions and comments you can see."));
  assert.ok(html.includes("Submit challenges, propose solutions, edit and resubmit your own items, comment and follow — as you, marked 'via agent'."));
  assert.ok(html.includes("It cannot like, change a status, assign, triage or administer."));
  assert.ok(html.includes("Namespace-restricted challenges are not shared with agents."));
  assert.ok(html.includes('<a href="/agents">AI agents</a>'));
  assert.ok(!render({ restrictedShared: true }).includes("Namespace-restricted"));
  assert.ok(!html.includes("§"), "no spec reference reaches the page");
});

test("every interpolated value is escaped", () => {
  const html = render({
    clientName: '<script>alert("x")</script>',
    redirectUri: "https://evil.example/cb?x=<b>",
    personName: "A & B",
    requestId: '"id"',
    everApproved: false,
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("<title>Connect &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; to InnoBox</title>"));
  assert.ok(html.includes("A &amp; B"));
  assert.ok(html.includes('value="&quot;id&quot;"'));
  assert.ok(html.includes(`<span class="destination">evil.example</span>`), "the host alone, never the query");
  assert.equal(escapeHtml(`'<>&"`), "&#39;&lt;&gt;&amp;&quot;");
});

test("the error page escapes its message and points back to AI agents", () => {
  const html = renderErrorPage("The request names \"<redirect_uri>\" more than once.");
  assert.ok(html.includes("This connection can't be completed"));
  assert.ok(html.includes("&quot;&lt;redirect_uri&gt;&quot;"));
  assert.ok(!html.includes("<redirect_uri>"));
  assert.ok(html.includes('<a href="/agents">AI agents</a>'));
});
